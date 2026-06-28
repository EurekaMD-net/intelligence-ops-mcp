import { createPool } from "mysql2/promise";
import type { Pool, RowDataPacket, FieldPacket } from "mysql2/promise";
import type { Connection as CoreConnection, QueryValues } from "mysql2";
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

/** mysql2 cast `unknown[]` bind params to the driver's value union at the one boundary. */
function asValues(params: unknown[]): QueryValues {
  return params as unknown as QueryValues;
}

/**
 * Stream up to `n` rows off the CORE connection, stopping early once we have them.
 * This is the row+memory cap: the server still computes the full result (MySQL has no
 * lazy server cursor like pg), but we stop reading into Node after `n` rows, so client
 * memory is bounded regardless of the SQL text — a trailing-comment cannot strip an
 * (absent) appended LIMIT. The caller DESTROYS the connection when we stop early
 * (the result set is half-drained), so a poisoned connection never returns to the pool;
 * disconnecting also rolls back the open read-only transaction (InnoDB).
 */
function streamRows(
  core: CoreConnection,
  sql: string,
  params: unknown[],
  n: number,
): Promise<{ rows: Record<string, unknown>[]; fields: FieldPacket[] }> {
  return new Promise((resolve, reject) => {
    const rows: Record<string, unknown>[] = [];
    let fields: FieldPacket[] = [];
    let settled = false;
    const done = (err?: unknown) => {
      if (settled) return;
      settled = true;
      if (err) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve({ rows, fields });
    };
    const q = core.query(sql, asValues(params));
    q.on("fields", (f: FieldPacket[]) => {
      fields = f ?? [];
    });
    q.on("error", done);
    const stream = q.stream();
    stream.on("error", done);
    stream.on("data", (row: Record<string, unknown>) => {
      rows.push(row);
      if (rows.length >= n) {
        stream.destroy(); // early stop — caps client memory
        done();
      }
    });
    stream.on("end", () => done());
    stream.on("close", () => done());
  });
}

/**
 * Read-only MySQL (8.0+, InnoDB) behind the dialect-agnostic Connector seam.
 *
 * Structural read-only is layered, but NOT identical to Postgres — MySQL has a gap PG
 * does not, so the AUTHORITATIVE layer here is the grant, not the transaction:
 *   (a) AUTHORITATIVE — a SELECT-only DB grant WITHOUT the FILE privilege. This is the
 *       load-bearing layer: `START TRANSACTION READ ONLY` blocks DML/DDL but does NOT
 *       block `SELECT … INTO OUTFILE/DUMPFILE`, which is a filesystem WRITE. Only the
 *       absence of FILE (a server-enforced grant) closes that. Enforced here by a
 *       startup self-test (`assertReadOnlySafe`) that REFUSES to run any query if the
 *       connected user holds FILE/ALL — there is no code path to a write otherwise.
 *   (b) DEFENCE-IN-DEPTH — `START TRANSACTION READ ONLY` + ROLLBACK (real on InnoDB)
 *       blocks INSERT/UPDATE/DELETE/DDL.
 * Single-statement guard: `multipleStatements:false` (never enabled) — the server parses
 * a `;`-joined payload as one statement and rejects it. Row+memory cap: stream-and-stop.
 * Plan-only validation: `EXPLAIN FORMAT=TREE` (never ANALYZE), time-bounded (EXPLAIN DOES
 * execute derived subqueries on MySQL, so it carries the same statement timeout as a run).
 */
export class MysqlConnector implements Connector {
  readonly dialect: Dialect = "mysql";
  readonly capabilities: Capabilities = { paramStyle: "?" };
  private readonly pool: Pool;
  /** MySQL has no "public"; the configured database is the default schema. */
  private readonly defaultSchema: string;
  /** Memoized read-only-safety self-test (see assertReadOnlySafe). */
  private safetyAssertion: Promise<void> | null = null;

  constructor(private readonly cfg: ConnectorConfig) {
    this.defaultSchema = cfg.database;
    this.pool = createPool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database || undefined,
      ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
      connectionLimit: cfg.poolMax,
      connectTimeout: cfg.connectTimeoutMs,
      multipleStatements: false, // authoritative single-statement guard — never enable
      dateStrings: true, // DATE/DATETIME/TIMESTAMP as strings (like pg)
      decimalNumbers: false, // DECIMAL stays a string (like pg numeric) for the render layer
    });
  }

  private schema(s?: string): string {
    return s ?? this.defaultSchema;
  }

  /**
   * Read-only-safety gate (memoized). On MySQL the read-only transaction does NOT block
   * `SELECT … INTO OUTFILE/DUMPFILE`, so a user holding FILE (or ALL) could write files
   * through execute_query. We refuse to run ANY user query for such a principal — there
   * is then no code path from a tool to a write. A confirmed violation stays cached
   * (permanently refused); a transient connection failure clears the cache to retry.
   */
  private assertReadOnlySafe(): Promise<void> {
    if (!this.safetyAssertion) {
      this.safetyAssertion = this.checkReadOnlyPrivileges().catch((e) => {
        const violation =
          e instanceof Error && e.message.startsWith("read-only safety");
        if (!violation) this.safetyAssertion = null; // transient — retry next time
        throw e;
      });
    }
    return this.safetyAssertion;
  }

  private async checkReadOnlyPrivileges(): Promise<void> {
    const conn = await this.pool.getConnection();
    try {
      const [rows] = await conn.query<RowDataPacket[]>(
        "SHOW GRANTS FOR CURRENT_USER()",
      );
      // Inspect only the privilege clause of each grant (between "GRANT" and "ON").
      const dangerous = rows.some((r) => {
        const line = String(Object.values(r)[0] ?? "");
        const m = /^GRANT\s+(.+?)\s+ON\s/i.exec(line);
        if (!m) return false;
        const privs = (m[1] ?? "").toUpperCase();
        return (
          /\bFILE\b/.test(privs) ||
          /\bALL PRIVILEGES\b/.test(privs) ||
          privs === "ALL"
        );
      });
      if (dangerous) {
        throw new Error(
          "read-only safety: the MySQL user holds FILE (or ALL PRIVILEGES); " +
            "SELECT … INTO OUTFILE/DUMPFILE can write files and is NOT blocked by a " +
            "READ ONLY transaction. Connect with a SELECT-only user that has no FILE privilege.",
        );
      }
    } finally {
      conn.release();
    }
  }

  async healthCheck(): Promise<boolean> {
    const conn = await this.pool.getConnection();
    try {
      await conn.query("SELECT 1");
      return true;
    } finally {
      conn.release();
    }
  }

  async listTables(schema?: string): Promise<TableInfo[]> {
    const sch = this.schema(schema);
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT TABLE_NAME AS name,
              TABLE_SCHEMA AS \`schema\`,
              COALESCE(TABLE_ROWS, 0) AS row_count_estimate,
              TABLE_COMMENT AS comment
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
       ORDER BY TABLE_NAME`,
      [sch],
    );
    return rows.map((r) => ({
      name: r.name,
      schema: r.schema,
      rowCountEstimate: Number(r.row_count_estimate),
      comment: r.comment || null, // MySQL returns '' (not null) when there is no comment
    }));
  }

  async describeTable(table: string, schema?: string): Promise<TableSchema> {
    const sch = this.schema(schema);
    const params = [sch, table];

    const [cols] = await this.pool.query<RowDataPacket[]>(
      `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type,
              IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      params,
    );
    if (cols.length === 0) {
      throw new Error(`table "${sch}.${table}" not found or has no columns`);
    }

    const [pks] = await this.pool.query<RowDataPacket[]>(
      `SELECT COLUMN_NAME AS col
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'`,
      params,
    );
    const pkSet = new Set<string>(pks.map((r) => r.col));

    // KEY_COLUMN_USAGE yields one row per FK COLUMN paired with its referenced column,
    // so composite keys are matched by position with no cross-product.
    const [fks] = await this.pool.query<RowDataPacket[]>(
      `SELECT COLUMN_NAME AS col,
              CONCAT(REFERENCED_TABLE_SCHEMA, '.', REFERENCED_TABLE_NAME, '.', REFERENCED_COLUMN_NAME) AS ref
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
      params,
    );
    const fkMap = new Map<string, string>(fks.map((r) => [r.col, r.ref]));

    const [idx] = await this.pool.query<RowDataPacket[]>(
      `SELECT INDEX_NAME AS name,
              MIN(NON_UNIQUE) AS non_unique,
              GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       GROUP BY INDEX_NAME
       ORDER BY INDEX_NAME`,
      params,
    );

    const columns: ColumnInfo[] = cols.map((r) => ({
      name: r.name,
      type: r.type,
      nullable: r.is_nullable === "YES",
      default: r.column_default ?? null,
      isPk: pkSet.has(r.name),
      fkReferences: fkMap.get(r.name) ?? null,
    }));
    const indexes: IndexInfo[] = idx.map((r) => ({
      name: r.name,
      columns: String(r.columns ?? "")
        .split(",")
        .filter(Boolean),
      unique: Number(r.non_unique) === 0,
    }));

    const [est] = await this.pool.query<RowDataPacket[]>(
      `SELECT COALESCE(TABLE_ROWS, 0) AS est
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      params,
    );

    return {
      table,
      schema: sch,
      columns,
      indexes,
      rowCountEstimate: Number(est[0]?.est ?? 0),
    };
  }

  async runUserQuery(
    sql: string,
    params: unknown[] = [],
    limit?: number,
  ): Promise<QueryResult> {
    await this.assertReadOnlySafe(); // refuse if the principal can write files (FILE priv)
    const cap = Math.max(1, Math.floor(this.cfg.maxRows));
    const want = Math.min(Math.max(1, Math.floor(limit ?? 100)), cap);
    const conn = await this.pool.getConnection();
    const start = Date.now();
    let truncated = false;
    try {
      await conn.query("START TRANSACTION READ ONLY");
      // max_execution_time (ms, MySQL 8.0+) bounds server time for read-only SELECTs.
      await conn.query(
        `SET SESSION max_execution_time = ${Math.floor(this.cfg.statementTimeoutMs)}`,
      );
      const core = conn.connection as unknown as CoreConnection;
      const { rows: fetched, fields } = await streamRows(
        core,
        sql,
        params,
        want + 1, // one extra row detects truncation
      );
      truncated = fetched.length > want;
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
      if (truncated) {
        // Half-drained result set — drop the connection so it never returns to the
        // pool dirty; the disconnect rolls back the open read-only transaction.
        conn.destroy();
      } else {
        await conn.query("ROLLBACK").catch(() => {});
        conn.release();
      }
    }
  }

  async getSchemaContext(schema?: string): Promise<SchemaContext> {
    const sch = this.schema(schema);
    const [[tablesRes], [colsRes], [pksRes], [fksRes]] = await Promise.all([
      this.pool.query<RowDataPacket[]>(
        `SELECT TABLE_NAME AS name, COALESCE(TABLE_ROWS, 0) AS est, TABLE_COMMENT AS comment
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
         ORDER BY TABLE_NAME`,
        [sch],
      ),
      this.pool.query<RowDataPacket[]>(
        `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name,
                COLUMN_TYPE AS data_type, IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ?
         ORDER BY TABLE_NAME, ORDINAL_POSITION`,
        [sch],
      ),
      this.pool.query<RowDataPacket[]>(
        `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS col
         FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = ? AND CONSTRAINT_NAME = 'PRIMARY'`,
        [sch],
      ),
      this.pool.query<RowDataPacket[]>(
        `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS col,
                CONCAT(REFERENCED_TABLE_SCHEMA, '.', REFERENCED_TABLE_NAME, '.', REFERENCED_COLUMN_NAME) AS ref
         FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
        [sch],
      ),
    ]);

    const pkSet = new Set(pksRes.map((r) => `${r.table_name}.${r.col}`));
    const fkMap = new Map<string, string>(
      fksRes.map((r) => [`${r.table_name}.${r.col}`, r.ref]),
    );
    const colsByTable = new Map<string, ColumnInfo[]>();
    for (const r of colsRes) {
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

    const tables: SchemaTable[] = tablesRes.map((t) => ({
      name: t.name,
      comment: t.comment || null,
      rowCountEstimate: Number(t.est),
      columns: colsByTable.get(t.name) ?? [],
    }));
    const relationships: FkEdge[] = fksRes.map((r) => ({
      from: `${r.table_name}.${r.col}`,
      to: r.ref,
    }));

    return { schema: sch, tables, relationships };
  }

  /**
   * Plan-only validation: `EXPLAIN FORMAT=TREE` (8.0.16+) without ANALYZE. Unlike
   * Postgres, MySQL EXPLAIN *does* materialize/execute derived-table subqueries during
   * planning, so this carries the SAME `max_execution_time` bound as a real run —
   * otherwise `EXPLAIN … (SELECT SLEEP(N))` would be an unbounded pool-exhaustion DoS.
   * `multipleStatements:false` still rejects an injected 2nd statement.
   */
  async explainQuery(sql: string, params: unknown[] = []): Promise<string[]> {
    await this.assertReadOnlySafe();
    const conn = await this.pool.getConnection();
    try {
      await conn.query("START TRANSACTION READ ONLY");
      await conn.query(
        `SET SESSION max_execution_time = ${Math.floor(this.cfg.statementTimeoutMs)}`,
      );
      const [rows] = await conn.query<RowDataPacket[]>(
        `EXPLAIN FORMAT=TREE ${sql}`,
        asValues(params),
      );
      return rows.map((r) => r.EXPLAIN as string);
    } finally {
      await conn.query("ROLLBACK").catch(() => {});
      conn.release();
    }
  }

  /**
   * A mysql2 error with an `ER_`-prefixed `code` means the SERVER parsed and rejected
   * the SQL → genuinely invalid. Connection/infra failures carry libuv/protocol codes
   * (ECONNREFUSED, ENOTFOUND, PROTOCOL_CONNECTION_LOST) and/or `fatal:true`, and must
   * surface as a tool error, not a false "invalid" verdict.
   *
   * Operational errors that are ALSO `ER_`-prefixed and non-fatal — a query/lock TIMEOUT
   * on otherwise-valid SQL — are excluded: reporting them as `valid:false` would make the
   * host LLM "repair" correct SQL (the exact loop this classifier exists to prevent).
   */
  isValidityError(e: unknown): boolean {
    if (!e || typeof e !== "object") return false;
    const code = (e as { code?: unknown }).code;
    const fatal = (e as { fatal?: unknown }).fatal;
    if (typeof code !== "string") return false;
    if (code === "ER_QUERY_TIMEOUT" || code === "ER_LOCK_WAIT_TIMEOUT") {
      return false; // valid SQL that was too slow / blocked — not an invalidity
    }
    return code.startsWith("ER_") && fatal !== true;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
