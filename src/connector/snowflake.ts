import type { Binds, Connection, RowStatement } from "snowflake-sdk";
import { collectCapped } from "./row-stream.js";
import type {
  AnyDialect,
  Capabilities,
  ColumnInfo,
  Connector,
  FkEdge,
  IndexInfo,
  QueryResult,
  SchemaContext,
  SchemaTable,
  SnowflakeConfig,
  TableInfo,
  TableSchema,
} from "./types.js";

/**
 * ⚠ EXPERIMENTAL / UNVERIFIED — no integration test (Snowflake is cloud-only: no throwaway
 * container, read-only is RBAC-only). Code-complete against snowflake-sdk@3, gated behind
 * IOMCP_ENABLE_UNVERIFIED_DIALECTS; verify per docs/verify-cloud-connectors.md before trusting.
 *
 * Read-only posture (Snowflake transactions do NOT enforce read-only — RBAC only):
 *   (a) AUTHORITATIVE — the assumed ROLE must hold only SELECT/USAGE grants (no write privs).
 *       Operator precondition, like the relational grant.
 *   (b) Self-test (`assertReadOnlySafe`) runs `SHOW GRANTS TO ROLE <current_role>` and REFUSES
 *       to run any query if the role holds a write privilege (INSERT/UPDATE/DELETE/CREATE/…).
 *       LIMITATION: this sees only privileges granted DIRECTLY to the current role — it does
 *       NOT expand privileges inherited via role hierarchy. A role whose write access is purely
 *       inherited would pass. So (a) the SELECT/USAGE-only role remains the authoritative layer,
 *       and the operator must verify the role across its hierarchy per the runbook.
 * Single-statement guard: `MULTI_STATEMENT_COUNT=1` on every statement — a `;`-joined payload
 * is rejected. Row+memory cap via `streamRows` (stop after n). Per-query timeout via
 * `STATEMENT_TIMEOUT_IN_SECONDS`. Plan-only validation via `EXPLAIN USING TEXT` (no execution).
 * `?` positional binds.
 */

/** Pure (unit-testable): is a Snowflake privilege a write privilege? */
export function isSnowflakeWritePrivilege(privilege: string): boolean {
  const u = privilege.trim().toUpperCase();
  if (
    [
      "INSERT",
      "UPDATE",
      "DELETE",
      "TRUNCATE",
      "MERGE",
      "OWNERSHIP",
      "MODIFY",
      "WRITE",
      "ALL",
      "ALL PRIVILEGES",
    ].includes(u)
  ) {
    return true;
  }
  return u.startsWith("CREATE "); // CREATE TABLE / SCHEMA / …
}

/**
 * Pure (unit-testable): a Snowflake error that means the SERVER rejected the SQL (invalid)
 * vs an infra/auth failure. A server SQL error carries a SQLSTATE; connection/network
 * failures do not.
 */
export function isSnowflakeValidityError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const sqlState = (e as { sqlState?: unknown }).sqlState;
  return typeof sqlState === "string" && sqlState.length > 0;
}

function asBinds(params: unknown[]): Binds {
  return params as unknown as Binds;
}

export class SnowflakeConnector implements Connector {
  readonly dialect: AnyDialect = "snowflake";
  readonly capabilities: Capabilities = { paramStyle: "?" };
  private conn: Connection | null = null;
  private connecting: Promise<Connection> | null = null;
  private safety: Promise<void> | null = null;

  constructor(private readonly cfg: SnowflakeConfig) {
    // Fail-closed defense-in-depth: even a direct construction is refused unless the
    // experimental opt-in is set (the factory checks too — this makes the class itself safe).
    if (process.env.IOMCP_ENABLE_UNVERIFIED_DIALECTS !== "true") {
      throw new Error(
        "SnowflakeConnector is EXPERIMENTAL/UNVERIFIED and disabled — set " +
          "IOMCP_ENABLE_UNVERIFIED_DIALECTS=true to enable it.",
      );
    }
  }

  private async connection(): Promise<Connection> {
    if (this.conn) return this.conn;
    if (!this.connecting) this.connecting = this.connect();
    try {
      this.conn = await this.connecting;
    } catch (e) {
      this.connecting = null; // transient connect failure — allow a retry
      throw e;
    }
    return this.conn;
  }

  private async connect(): Promise<Connection> {
    const mod = await import("snowflake-sdk");
    const conn = mod.createConnection({
      account: this.cfg.account,
      username: this.cfg.username,
      password: this.cfg.password,
      privateKeyPath: this.cfg.privateKeyPath,
      authenticator: this.cfg.privateKeyPath ? "SNOWFLAKE_JWT" : undefined,
      warehouse: this.cfg.warehouse,
      database: this.cfg.database,
      schema: this.cfg.schema,
      role: this.cfg.role,
      application: "intelligence-ops-mcp",
      timeout: this.cfg.connectTimeoutMs,
    });
    await conn.connectAsync();
    // Per-query server-side timeout (seconds). Floored at 1s.
    const secs = Math.max(1, Math.floor(this.cfg.statementTimeoutMs / 1000));
    await execBuffered(
      conn,
      `ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS = ${secs}`,
      [],
    );
    return conn;
  }

  private schema(s?: string): string {
    return s ?? this.cfg.schema;
  }

  private assertReadOnlySafe(): Promise<void> {
    if (!this.safety) {
      this.safety = this.checkRoleGrants().catch((e) => {
        const violation =
          e instanceof Error && e.message.startsWith("read-only safety");
        if (!violation) this.safety = null; // transient — retry next time
        throw e;
      });
    }
    return this.safety;
  }

  private async checkRoleGrants(): Promise<void> {
    const conn = await this.connection();
    const roleRows = await execBuffered(
      conn,
      "SELECT CURRENT_ROLE() AS role",
      [],
    );
    const role = String(
      (roleRows[0] as { ROLE?: string; role?: string } | undefined)?.ROLE ??
        (roleRows[0] as { role?: string } | undefined)?.role ??
        "",
    );
    if (!/^[A-Za-z0-9_$]+$/.test(role)) {
      throw new Error(
        "read-only safety: could not determine a valid current role for the grant self-test",
      );
    }
    const grants = await execBuffered(conn, `SHOW GRANTS TO ROLE ${role}`, []);
    const writes = grants
      .map((r) => {
        const row = r as { privilege?: string; PRIVILEGE?: string };
        return row.privilege ?? row.PRIVILEGE ?? "";
      })
      .filter((p) => isSnowflakeWritePrivilege(p));
    if (writes.length > 0) {
      throw new Error(
        `read-only safety: role "${role}" holds write privileges (${[...new Set(writes)].join(", ")}). ` +
          "Assume a role with SELECT/USAGE grants only.",
      );
    }
  }

  async healthCheck(): Promise<boolean> {
    const conn = await this.connection();
    await execBuffered(conn, "SELECT 1", []);
    return true;
  }

  async listTables(schema?: string): Promise<TableInfo[]> {
    const sch = this.schema(schema);
    const conn = await this.connection();
    const rows = await execBuffered(
      conn,
      `SELECT table_name AS name, row_count AS rows, comment
       FROM information_schema.tables
       WHERE table_schema = ? AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
      [sch],
    );
    return (
      rows as Array<{
        NAME: string;
        ROWS: number | null;
        COMMENT: string | null;
      }>
    ).map((r) => ({
      name: r.NAME,
      schema: sch,
      rowCountEstimate: Number(r.ROWS ?? 0),
      comment: r.COMMENT ?? null,
    }));
  }

  async describeTable(table: string, schema?: string): Promise<TableSchema> {
    const sch = this.schema(schema);
    const conn = await this.connection();
    const cols = await execBuffered(
      conn,
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name = ?
       ORDER BY ordinal_position`,
      [sch, table],
    );
    const colRows = cols as Array<{
      COLUMN_NAME: string;
      DATA_TYPE: string;
      IS_NULLABLE: string;
      COLUMN_DEFAULT: string | null;
    }>;
    if (colRows.length === 0) {
      throw new Error(`table "${sch}.${table}" not found or has no columns`);
    }
    const pks = await execBuffered(
      conn,
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name
        AND kcu.table_schema = tc.table_schema
       WHERE tc.table_schema = ? AND tc.table_name = ? AND tc.constraint_type = 'PRIMARY KEY'`,
      [sch, table],
    );
    const pkSet = new Set(
      (pks as Array<{ COLUMN_NAME: string }>).map((r) => r.COLUMN_NAME),
    );
    const columns: ColumnInfo[] = colRows.map((r) => ({
      name: r.COLUMN_NAME,
      type: r.DATA_TYPE,
      nullable: r.IS_NULLABLE === "YES",
      default: r.COLUMN_DEFAULT ?? null,
      isPk: pkSet.has(r.COLUMN_NAME),
      fkReferences: null, // FK graph omitted (unverified); declared FKs are unenforced in Snowflake
    }));
    const indexes: IndexInfo[] = []; // Snowflake has no user indexes
    return { table, schema: sch, columns, indexes, rowCountEstimate: 0 };
  }

  async runUserQuery(
    sql: string,
    params: unknown[] = [],
    limit?: number,
  ): Promise<QueryResult> {
    await this.assertReadOnlySafe();
    const cap = Math.max(1, Math.floor(this.cfg.maxRows));
    const want = Math.min(Math.max(1, Math.floor(limit ?? 100)), cap);
    const conn = await this.connection();
    const start = Date.now();
    const stmt = await new Promise<RowStatement>((resolve, reject) => {
      conn.execute({
        sqlText: sql,
        binds: asBinds(params),
        streamResult: true,
        parameters: { MULTI_STATEMENT_COUNT: 1 },
        complete: (err, statement) => {
          if (err) reject(err);
          else resolve(statement as RowStatement);
        },
      });
    });
    const stream = stmt.streamRows();
    const fetched = await collectCapped(stream, want + 1);
    const truncated = fetched.length > want;
    const rows = truncated ? fetched.slice(0, want) : fetched;
    const declared = (stmt.getColumns() ?? []).map((c) => c.getName());
    const columns =
      declared.length > 0 ? declared : rows[0] ? Object.keys(rows[0]) : [];
    return {
      columns,
      rows,
      rowCount: rows.length,
      executionMs: Date.now() - start,
      truncated,
    };
  }

  async getSchemaContext(schema?: string): Promise<SchemaContext> {
    const sch = this.schema(schema);
    const conn = await this.connection();
    const [tbls, cols, pks] = await Promise.all([
      execBuffered(
        conn,
        `SELECT table_name AS name, row_count AS rows, comment
         FROM information_schema.tables
         WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name`,
        [sch],
      ),
      execBuffered(
        conn,
        `SELECT table_name, column_name, data_type, is_nullable, column_default
         FROM information_schema.columns WHERE table_schema = ?
         ORDER BY table_name, ordinal_position`,
        [sch],
      ),
      execBuffered(
        conn,
        `SELECT tc.table_name, kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
         WHERE tc.table_schema = ? AND tc.constraint_type = 'PRIMARY KEY'`,
        [sch],
      ),
    ]);
    const pkSet = new Set(
      (pks as Array<{ TABLE_NAME: string; COLUMN_NAME: string }>).map(
        (r) => `${r.TABLE_NAME}.${r.COLUMN_NAME}`,
      ),
    );
    const colsByTable = new Map<string, ColumnInfo[]>();
    for (const r of cols as Array<{
      TABLE_NAME: string;
      COLUMN_NAME: string;
      DATA_TYPE: string;
      IS_NULLABLE: string;
      COLUMN_DEFAULT: string | null;
    }>) {
      const arr = colsByTable.get(r.TABLE_NAME) ?? [];
      arr.push({
        name: r.COLUMN_NAME,
        type: r.DATA_TYPE,
        nullable: r.IS_NULLABLE === "YES",
        default: r.COLUMN_DEFAULT ?? null,
        isPk: pkSet.has(`${r.TABLE_NAME}.${r.COLUMN_NAME}`),
        fkReferences: null,
      });
      colsByTable.set(r.TABLE_NAME, arr);
    }
    const tables: SchemaTable[] = (
      tbls as Array<{
        NAME: string;
        ROWS: number | null;
        COMMENT: string | null;
      }>
    ).map((t) => ({
      name: t.NAME,
      comment: t.COMMENT ?? null,
      rowCountEstimate: Number(t.ROWS ?? 0),
      columns: colsByTable.get(t.NAME) ?? [],
    }));
    const relationships: FkEdge[] = [];
    return { schema: sch, tables, relationships };
  }

  /** Plan-only validation: `EXPLAIN USING TEXT` does not execute the statement. */
  async explainQuery(sql: string, params: unknown[] = []): Promise<string[]> {
    await this.assertReadOnlySafe();
    const conn = await this.connection();
    const rows = await execBuffered(conn, `EXPLAIN USING TEXT ${sql}`, params);
    return rows.map((r) => {
      const row = r as Record<string, unknown>;
      // EXPLAIN USING TEXT returns one text column; surface whatever value is present.
      return String(Object.values(row)[0] ?? "");
    });
  }

  isValidityError(e: unknown): boolean {
    return isSnowflakeValidityError(e);
  }

  async close(): Promise<void> {
    const conn = this.conn;
    this.conn = null;
    this.connecting = null;
    if (!conn) return;
    await new Promise<void>((resolve) => {
      conn.destroy(() => resolve());
    });
  }
}

/** Promisified buffered execute — for control statements, EXPLAIN, and the grant self-test. */
function execBuffered(
  conn: Connection,
  sqlText: string,
  params: unknown[],
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      binds: asBinds(params),
      parameters: { MULTI_STATEMENT_COUNT: 1 },
      complete: (err, _stmt, rows) => {
        if (err) reject(err);
        else resolve((rows ?? []) as Record<string, unknown>[]);
      },
    });
  });
}
