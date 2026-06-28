import pg from "pg";
import Cursor from "pg-cursor";
import type {
  Connector,
  Capabilities,
  ConnectorConfig,
  Dialect,
  TableInfo,
  TableSchema,
  ColumnInfo,
  IndexInfo,
  QueryResult,
  SchemaContext,
  SchemaTable,
  FkEdge,
} from "./types.js";

const { Pool } = pg;

/** Read up to `n` rows from a server-side cursor, returning rows + field names. */
function readCursor(
  cursor: Cursor,
  n: number,
): Promise<{ rows: Record<string, unknown>[]; fields: { name: string }[] }> {
  return new Promise((resolve, reject) => {
    cursor.read(n, (err, rows, result) => {
      if (err) return reject(err);
      resolve({
        rows: rows as Record<string, unknown>[],
        fields: result?.fields ?? [],
      });
    });
  });
}

/** Read-only Postgres access behind the dialect-agnostic Connector seam. */
export class PostgresConnector implements Connector {
  readonly dialect: Dialect = "postgres";
  readonly capabilities: Capabilities = { paramStyle: "$n" };
  private readonly pool: pg.Pool;

  constructor(private readonly cfg: ConnectorConfig) {
    this.pool = new Pool({
      host: cfg.host,
      port: cfg.port,
      database: cfg.database,
      user: cfg.user,
      password: cfg.password,
      ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
      max: cfg.poolMax,
      connectionTimeoutMillis: cfg.connectTimeoutMs,
    });
  }

  async healthCheck(): Promise<boolean> {
    const c = await this.pool.connect();
    try {
      await c.query("SELECT 1");
      return true;
    } finally {
      c.release();
    }
  }

  async listTables(schema = "public"): Promise<TableInfo[]> {
    const res = await this.pool.query(
      `SELECT t.table_name AS name,
              t.table_schema AS schema,
              COALESCE(s.n_live_tup, 0)::bigint AS row_count_estimate,
              obj_description(format('%I.%I', t.table_schema, t.table_name)::regclass) AS comment
       FROM information_schema.tables t
       LEFT JOIN pg_stat_user_tables s
         ON s.relname = t.table_name AND s.schemaname = t.table_schema
       WHERE t.table_schema = $1 AND t.table_type = 'BASE TABLE'
       ORDER BY t.table_name`,
      [schema],
    );
    return res.rows.map((r) => ({
      name: r.name,
      schema: r.schema,
      rowCountEstimate: Number(r.row_count_estimate),
      comment: r.comment ?? null,
    }));
  }

  async describeTable(table: string, schema = "public"): Promise<TableSchema> {
    const reg = "format('%I.%I', $1::text, $2::text)::regclass";
    const params = [schema, table];

    const cols = await this.pool.query(
      `SELECT column_name AS name, data_type AS type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position`,
      params,
    );
    if (cols.rows.length === 0) {
      throw new Error(`table "${schema}.${table}" not found or has no columns`);
    }

    const pks = await this.pool.query(
      `SELECT a.attname AS col
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = ${reg} AND i.indisprimary`,
      params,
    );
    const pkSet = new Set<string>(pks.rows.map((r) => r.col));

    // Pair each FK column with its referenced column BY ORDINAL (conkey[i]↔confkey[i]);
    // joining on constraint name alone cross-products composite keys.
    const fks = await this.pool.query(
      `SELECT att.attname AS col,
              fn.nspname || '.' || fc.relname || '.' || fatt.attname AS ref
       FROM pg_constraint con
       JOIN unnest(con.conkey) WITH ORDINALITY AS ck(attnum, ord) ON true
       JOIN unnest(con.confkey) WITH ORDINALITY AS fk(attnum, ord) ON fk.ord = ck.ord
       JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ck.attnum
       JOIN pg_class fc ON fc.oid = con.confrelid
       JOIN pg_namespace fn ON fn.oid = fc.relnamespace
       JOIN pg_attribute fatt ON fatt.attrelid = con.confrelid AND fatt.attnum = fk.attnum
       WHERE con.contype = 'f' AND con.conrelid = ${reg}`,
      params,
    );
    const fkMap = new Map<string, string>(fks.rows.map((r) => [r.col, r.ref]));

    const idx = await this.pool.query(
      `SELECT ic.relname AS name,
              ix.indisunique AS unique,
              array_agg(a.attname ORDER BY k.ord) AS columns
       FROM pg_index ix
       JOIN pg_class ic ON ic.oid = ix.indexrelid
       JOIN unnest(ix.indkey) WITH ORDINALITY k(attnum, ord) ON true
       JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum
       WHERE ix.indrelid = ${reg}
       GROUP BY ic.relname, ix.indisunique
       ORDER BY ic.relname`,
      params,
    );

    const columns: ColumnInfo[] = cols.rows.map((r) => ({
      name: r.name,
      type: r.type,
      nullable: r.is_nullable === "YES",
      default: r.column_default ?? null,
      isPk: pkSet.has(r.name),
      fkReferences: fkMap.get(r.name) ?? null,
    }));
    const indexes: IndexInfo[] = idx.rows.map((r) => ({
      name: r.name,
      columns: r.columns,
      unique: r.unique,
    }));

    const est = await this.pool.query(
      `SELECT reltuples::bigint AS est FROM pg_class WHERE oid = ${reg}`,
      params,
    );

    return {
      table,
      schema,
      columns,
      indexes,
      rowCountEstimate: Number(est.rows[0]?.est ?? 0),
    };
  }

  /** Run a validated user SELECT inside a READ ONLY transaction, row- and memory-capped. */
  async runUserQuery(
    sql: string,
    params: unknown[] = [],
    limit?: number,
  ): Promise<QueryResult> {
    const cap = Math.max(1, Math.floor(this.cfg.maxRows));
    const want = Math.min(Math.max(1, Math.floor(limit ?? 100)), cap);
    const client = await this.pool.connect();
    const start = Date.now();
    let cursor: Cursor | undefined;
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      await client.query(
        `SET LOCAL statement_timeout = ${this.cfg.statementTimeoutMs}`,
      );
      // A server-side cursor caps BOTH rows and memory regardless of the SQL text:
      // a trailing comment can't strip an appended LIMIT (there is none), and pg never
      // buffers the whole table into Node. Fetch one extra row to detect truncation.
      cursor = client.query(new Cursor(sql, params));
      const { rows: fetched, fields } = await readCursor(cursor, want + 1);
      const truncated = fetched.length > want;
      const rows = truncated ? fetched.slice(0, want) : fetched;
      const columns =
        fields.length > 0
          ? fields.map((f) => f.name)
          : rows[0]
            ? Object.keys(rows[0])
            : [];
      return {
        columns,
        rows,
        rowCount: rows.length,
        executionMs: Date.now() - start,
        truncated,
      };
    } finally {
      if (cursor) await cursor.close().catch(() => {});
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }

  /**
   * Whole-schema context for the host LLM, in 4 batched catalog queries (no N+1):
   * every table's columns/PK/FK + the FK relationship graph.
   */
  async getSchemaContext(schema = "public"): Promise<SchemaContext> {
    const [tablesRes, colsRes, pksRes, fksRes] = await Promise.all([
      this.pool.query(
        `SELECT t.table_name AS name,
                COALESCE(s.n_live_tup, 0)::bigint AS est,
                obj_description(format('%I.%I', t.table_schema, t.table_name)::regclass) AS comment
         FROM information_schema.tables t
         LEFT JOIN pg_stat_user_tables s
           ON s.relname = t.table_name AND s.schemaname = t.table_schema
         WHERE t.table_schema = $1 AND t.table_type = 'BASE TABLE'
         ORDER BY t.table_name`,
        [schema],
      ),
      this.pool.query(
        `SELECT table_name, column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = $1
         ORDER BY table_name, ordinal_position`,
        [schema],
      ),
      this.pool.query(
        `SELECT c.relname AS table_name, a.attname AS col
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE n.nspname = $1 AND i.indisprimary`,
        [schema],
      ),
      this.pool.query(
        `SELECT c.relname AS table_name, att.attname AS col,
                fn.nspname || '.' || fc.relname || '.' || fatt.attname AS ref
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN unnest(con.conkey) WITH ORDINALITY AS ck(attnum, ord) ON true
         JOIN unnest(con.confkey) WITH ORDINALITY AS fk(attnum, ord) ON fk.ord = ck.ord
         JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ck.attnum
         JOIN pg_class fc ON fc.oid = con.confrelid
         JOIN pg_namespace fn ON fn.oid = fc.relnamespace
         JOIN pg_attribute fatt ON fatt.attrelid = con.confrelid AND fatt.attnum = fk.attnum
         WHERE n.nspname = $1 AND con.contype = 'f'`,
        [schema],
      ),
    ]);

    const pkSet = new Set(pksRes.rows.map((r) => `${r.table_name}.${r.col}`));
    const fkMap = new Map<string, string>(
      fksRes.rows.map((r) => [`${r.table_name}.${r.col}`, r.ref]),
    );
    const colsByTable = new Map<string, ColumnInfo[]>();
    for (const r of colsRes.rows) {
      const key = `${r.table_name}.${r.column_name}`;
      const col: ColumnInfo = {
        name: r.column_name,
        type: r.data_type,
        nullable: r.is_nullable === "YES",
        default: r.column_default ?? null,
        isPk: pkSet.has(key),
        fkReferences: fkMap.get(key) ?? null,
      };
      const arr = colsByTable.get(r.table_name) ?? [];
      arr.push(col);
      colsByTable.set(r.table_name, arr);
    }

    const tables: SchemaTable[] = tablesRes.rows.map((t) => ({
      name: t.name,
      comment: t.comment ?? null,
      rowCountEstimate: Number(t.est),
      columns: colsByTable.get(t.name) ?? [],
    }));
    const relationships: FkEdge[] = fksRes.rows.map((r) => ({
      from: `${r.table_name}.${r.col}`,
      to: r.ref,
    }));

    return { schema, tables, relationships };
  }

  /**
   * Plan-only validation: `EXPLAIN` (no ANALYZE → does NOT execute) inside a read-only
   * transaction. Lets the host agent check a query is valid before running it.
   *
   * Routed through a cursor (like runUserQuery) so it ALWAYS uses the extended protocol:
   * pg's Parse rejects multi-command input ("cannot insert multiple commands…") even when
   * `params` is empty. A plain `client.query` with no values would fall back to the SIMPLE
   * protocol and execute an injected second statement — the validator's separator scan is
   * only best-effort, so the protocol is the authoritative single-statement guard.
   */
  async explainQuery(sql: string, params: unknown[] = []): Promise<string[]> {
    const client = await this.pool.connect();
    let cursor: Cursor | undefined;
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      await client.query(
        `SET LOCAL statement_timeout = ${this.cfg.statementTimeoutMs}`,
      );
      cursor = client.query(new Cursor(`EXPLAIN ${sql}`, params));
      const { rows } = await readCursor(cursor, 10_000); // plan rows are few
      return rows.map((r) => r["QUERY PLAN"] as string);
    } finally {
      if (cursor) await cursor.close().catch(() => {});
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }

  /**
   * A `pg.DatabaseError` means the server evaluated the SQL and rejected it → the
   * query is genuinely INVALID. Anything else — ECONNREFUSED, ENOTFOUND, a pool
   * connect-timeout — is infra and must surface as a TOOL error, not a false
   * "invalid" verdict that makes the host LLM loop repairing good SQL. (A string
   * `code` check can't discriminate: libuv codes are also non-empty strings.)
   */
  isValidityError(e: unknown): boolean {
    return e instanceof pg.DatabaseError;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
