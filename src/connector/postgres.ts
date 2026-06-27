import pg from "pg";
import Cursor from "pg-cursor";
import type {
  ConnectorConfig,
  TableInfo,
  TableSchema,
  ColumnInfo,
  IndexInfo,
  QueryResult,
} from "./types.js";

const { Pool } = pg;

function num(v: string | undefined, d: number): number {
  // An empty/whitespace env var must fall back to the default, NOT coerce to 0
  // (Number("") === 0 would silently disable statement_timeout / break the pool).
  if (v === undefined || v.trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

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

export function loadConnectorConfig(
  env: NodeJS.ProcessEnv = process.env,
): ConnectorConfig {
  return {
    host: env.PG_HOST ?? "localhost",
    port: num(env.PG_PORT, 5432),
    database: env.PG_DATABASE ?? "postgres",
    user: env.PG_USER ?? "postgres",
    password: env.PG_PASSWORD ?? "",
    ssl: env.PG_SSL === "true",
    poolMax: Math.max(1, Math.floor(num(env.PG_POOL_MAX, 5))),
    connectTimeoutMs: Math.max(1, num(env.PG_CONNECT_TIMEOUT_MS, 5000)),
    // Floored at 1s so an empty/zero env can never DISABLE the per-query timeout.
    statementTimeoutMs: Math.max(1000, num(env.PG_STATEMENT_TIMEOUT_MS, 30000)),
    maxRows: Math.max(1, Math.floor(num(env.MAX_RESULT_ROWS, 1000))),
  };
}

/** Read-only Postgres access for the 3 MCP tools. */
export class PostgresConnector {
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

  async close(): Promise<void> {
    await this.pool.end();
  }
}
