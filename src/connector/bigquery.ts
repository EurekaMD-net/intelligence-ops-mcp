import type { BigQuery, Query } from "@google-cloud/bigquery";
import { collectCapped } from "./row-stream.js";
import type {
  AnyDialect,
  BigQueryConfig,
  Capabilities,
  ColumnInfo,
  Connector,
  FkEdge,
  IndexInfo,
  QueryResult,
  SchemaContext,
  SchemaTable,
  TableInfo,
  TableSchema,
} from "./types.js";

/**
 * ⚠ EXPERIMENTAL / UNVERIFIED — no integration test (BigQuery has no throwaway container
 * or CI-verifiable emulator). Code-complete against @google-cloud/bigquery@8, gated behind
 * IOMCP_ENABLE_UNVERIFIED_DIALECTS; verify per docs/verify-cloud-connectors.md before trusting.
 *
 * Read-only posture (no transactions on BigQuery — RBAC only):
 *   (a) AUTHORITATIVE — the service account's IAM role: `roles/bigquery.dataViewer` +
 *       `roles/bigquery.jobUser`, with NO write roles. DML/DDL then fail with permission
 *       denied. This is an operator precondition (documented), like the relational grant.
 *   (b) Best-effort self-test (`assertReadOnlySafe`) calls IAM testIamPermissions for write
 *       permissions and REFUSES if any are held; if the check is inconclusive (API/permission)
 *       it logs a loud warning and proceeds — it cannot be the sole guarantee.
 *   (c) COST cap — every job sets `maximumBytesBilled`, so a runaway scan is rejected, not billed.
 * Single SELECT only (validator whitelist). `?` positional params. Row+memory cap via the
 * query result stream (stop after n). "validate/explain" = a `dryRun` (no execution, returns
 * the byte estimate) — BigQuery has no EXPLAIN plan tree.
 */

const BQ_WRITE_PERMISSIONS = [
  "bigquery.tables.updateData",
  "bigquery.tables.create",
  "bigquery.tables.delete",
  "bigquery.tables.update",
  "bigquery.datasets.create",
  "bigquery.datasets.update",
  "bigquery.datasets.delete",
] as const;

/** Pure (unit-testable): does the principal hold any write permission? */
export function hasBigQueryWritePermission(held: readonly string[]): boolean {
  return held.some((p) =>
    (BQ_WRITE_PERMISSIONS as readonly string[]).includes(p),
  );
}

/**
 * Pure (unit-testable): a BigQuery error that means the SERVER rejected the SQL (invalid)
 * vs an infra/auth failure. invalidQuery / HTTP 400 → validity; 401/403/network → infra.
 */
export function isBigQueryValidityError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { code?: unknown; errors?: Array<{ reason?: string }> };
  const reasons = Array.isArray(err.errors)
    ? err.errors.map((x) => x.reason)
    : [];
  if (reasons.includes("invalidQuery") || reasons.includes("invalid")) {
    return true;
  }
  return err.code === 400;
}

/** A dataset/schema identifier safe to interpolate into a backticked table ref. */
function safeIdent(id: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(id)) {
    throw new Error(`invalid BigQuery dataset/schema name: "${id}"`);
  }
  return id;
}

export class BigQueryConnector implements Connector {
  readonly dialect: AnyDialect = "bigquery";
  readonly capabilities: Capabilities = { paramStyle: "?" };
  private client: BigQuery | null = null;
  private safety: Promise<void> | null = null;

  constructor(private readonly cfg: BigQueryConfig) {
    // Fail-closed defense-in-depth: even a direct construction is refused unless the
    // experimental opt-in is set (the factory checks too — this makes the class itself safe).
    if (process.env.IOMCP_ENABLE_UNVERIFIED_DIALECTS !== "true") {
      throw new Error(
        "BigQueryConnector is EXPERIMENTAL/UNVERIFIED and disabled — set " +
          "IOMCP_ENABLE_UNVERIFIED_DIALECTS=true to enable it.",
      );
    }
  }

  private async bq(): Promise<BigQuery> {
    if (!this.client) {
      const mod = await import("@google-cloud/bigquery");
      this.client = new mod.BigQuery({
        projectId: this.cfg.projectId,
        keyFilename: this.cfg.keyFilename,
        location: this.cfg.location,
      });
    }
    return this.client;
  }

  private dataset(schema?: string): string {
    return safeIdent(schema ?? this.cfg.defaultDataset);
  }

  /** Job options shared by every query: cost ceiling + per-job timeout + location. */
  private jobOpts(query: string, params: unknown[]): Query {
    return {
      query,
      params: params as unknown[],
      maximumBytesBilled: this.cfg.maxBytesBilled,
      jobTimeoutMs: this.cfg.statementTimeoutMs,
      location: this.cfg.location,
    };
  }

  /**
   * Best-effort read-only self-test (memoized). Refuses if the principal demonstrably holds
   * a write permission; if the IAM check can't be made (API disabled / no permission to test)
   * it WARNS and proceeds — the maximumBytesBilled cap + dataViewer precondition still apply.
   */
  private assertReadOnlySafe(): Promise<void> {
    if (!this.safety) {
      this.safety = this.checkIam().catch((e) => {
        const violation =
          e instanceof Error && e.message.startsWith("read-only safety");
        if (!violation) this.safety = null; // transient/inconclusive — retry next time
        throw e;
      });
    }
    return this.safety;
  }

  private async checkIam(): Promise<void> {
    let held: string[] | null = null;
    try {
      const client = await this.bq();
      // The BigQuery client carries a GoogleAuth instance; use it to call the
      // Resource Manager testIamPermissions REST endpoint for write permissions.
      // NOTE (UNVERIFIED): this reaches an SDK-internal `authClient`. If its shape
      // differs at runtime the check degrades to the warn-and-proceed path below — it
      // never silently passes a writable principal as "checked". The runbook covers
      // verifying this auth path against a real project.
      const auth = (client as unknown as { authClient?: unknown })
        .authClient as
        | {
            request: (opts: {
              url: string;
              method: string;
              data: unknown;
            }) => Promise<{ data?: { permissions?: string[] } }>;
          }
        | undefined;
      if (auth?.request) {
        const res = await auth.request({
          url: `https://cloudresourcemanager.googleapis.com/v1/projects/${this.cfg.projectId}:testIamPermissions`,
          method: "POST",
          data: { permissions: BQ_WRITE_PERMISSIONS },
        });
        held = res.data?.permissions ?? [];
      }
    } catch {
      held = null; // inconclusive
    }
    if (held && hasBigQueryWritePermission(held)) {
      throw new Error(
        "read-only safety: the BigQuery principal holds write permissions " +
          `(${held.join(", ")}). Grant a service account with roles/bigquery.dataViewer + ` +
          "jobUser only (no write roles).",
      );
    }
    if (held === null) {
      console.error(
        "[iomcp] WARNING: could not verify BigQuery read-only IAM (testIamPermissions " +
          "unavailable). Relying on the dataViewer precondition + maximumBytesBilled cap. " +
          "Confirm the service account has no write roles.",
      );
    }
  }

  async healthCheck(): Promise<boolean> {
    const client = await this.bq();
    await client.query(this.jobOpts("SELECT 1 AS ok", []));
    return true;
  }

  async listTables(schema?: string): Promise<TableInfo[]> {
    const ds = this.dataset(schema);
    const ref = `\`${this.cfg.projectId}.${ds}\`.INFORMATION_SCHEMA.TABLES`;
    const client = await this.bq();
    const [rows] = await client.query(
      this.jobOpts(
        `SELECT table_name FROM ${ref} WHERE table_type = 'BASE TABLE' ORDER BY table_name`,
        [],
      ),
    );
    return (rows as Array<{ table_name: string }>).map((r) => ({
      name: r.table_name,
      schema: ds,
      rowCountEstimate: 0, // row estimates need INFORMATION_SCHEMA.TABLE_STORAGE (unverified; deferred)
      comment: null,
    }));
  }

  async describeTable(table: string, schema?: string): Promise<TableSchema> {
    const ds = this.dataset(schema);
    const tbl = safeIdent(table);
    const base = `\`${this.cfg.projectId}.${ds}\`.INFORMATION_SCHEMA`;
    const client = await this.bq();
    const [cols] = await client.query(
      this.jobOpts(
        `SELECT column_name, data_type, is_nullable
         FROM ${base}.COLUMNS WHERE table_name = ? ORDER BY ordinal_position`,
        [tbl],
      ),
    );
    const colRows = cols as Array<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>;
    if (colRows.length === 0) {
      throw new Error(`table "${ds}.${tbl}" not found or has no columns`);
    }
    // PK from declared (unenforced) PRIMARY KEY constraints, if any.
    const [pks] = await client.query(
      this.jobOpts(
        `SELECT kcu.column_name
         FROM ${base}.TABLE_CONSTRAINTS tc
         JOIN ${base}.KEY_COLUMN_USAGE kcu ON kcu.constraint_name = tc.constraint_name
         WHERE tc.table_name = ? AND tc.constraint_type = 'PRIMARY KEY'`,
        [tbl],
      ),
    );
    const pkSet = new Set(
      (pks as Array<{ column_name: string }>).map((r) => r.column_name),
    );
    const columns: ColumnInfo[] = colRows.map((r) => ({
      name: r.column_name,
      type: r.data_type,
      nullable: r.is_nullable === "YES",
      default: null,
      isPk: pkSet.has(r.column_name),
      fkReferences: null, // BigQuery FKs are rarely declared; relationship graph omitted
    }));
    const indexes: IndexInfo[] = []; // BigQuery has no secondary indexes
    return { table: tbl, schema: ds, columns, indexes, rowCountEstimate: 0 };
  }

  async runUserQuery(
    sql: string,
    params: unknown[] = [],
    limit?: number,
  ): Promise<QueryResult> {
    await this.assertReadOnlySafe();
    const cap = Math.max(1, Math.floor(this.cfg.maxRows));
    const want = Math.min(Math.max(1, Math.floor(limit ?? 100)), cap);
    const client = await this.bq();
    const start = Date.now();
    const stream = client.createQueryStream(this.jobOpts(sql, params));
    const fetched = await collectCapped(stream, want + 1);
    const truncated = fetched.length > want;
    const rows = truncated ? fetched.slice(0, want) : fetched;
    const columns = rows[0] ? Object.keys(rows[0]) : [];
    return {
      columns,
      rows,
      rowCount: rows.length,
      executionMs: Date.now() - start,
      truncated,
    };
  }

  async getSchemaContext(schema?: string): Promise<SchemaContext> {
    const ds = this.dataset(schema);
    const base = `\`${this.cfg.projectId}.${ds}\`.INFORMATION_SCHEMA`;
    const client = await this.bq();
    const [[tbls], [cols], [pks]] = await Promise.all([
      client.query(
        this.jobOpts(
          `SELECT table_name FROM ${base}.TABLES WHERE table_type = 'BASE TABLE' ORDER BY table_name`,
          [],
        ),
      ),
      client.query(
        this.jobOpts(
          `SELECT table_name, column_name, data_type, is_nullable
           FROM ${base}.COLUMNS ORDER BY table_name, ordinal_position`,
          [],
        ),
      ),
      client.query(
        this.jobOpts(
          `SELECT tc.table_name, kcu.column_name
           FROM ${base}.TABLE_CONSTRAINTS tc
           JOIN ${base}.KEY_COLUMN_USAGE kcu ON kcu.constraint_name = tc.constraint_name
           WHERE tc.constraint_type = 'PRIMARY KEY'`,
          [],
        ),
      ),
    ]);
    const pkSet = new Set(
      (pks as Array<{ table_name: string; column_name: string }>).map(
        (r) => `${r.table_name}.${r.column_name}`,
      ),
    );
    const colsByTable = new Map<string, ColumnInfo[]>();
    for (const r of cols as Array<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>) {
      const arr = colsByTable.get(r.table_name) ?? [];
      arr.push({
        name: r.column_name,
        type: r.data_type,
        nullable: r.is_nullable === "YES",
        default: null,
        isPk: pkSet.has(`${r.table_name}.${r.column_name}`),
        fkReferences: null,
      });
      colsByTable.set(r.table_name, arr);
    }
    const tables: SchemaTable[] = (tbls as Array<{ table_name: string }>).map(
      (t) => ({
        name: t.table_name,
        comment: null,
        rowCountEstimate: 0,
        columns: colsByTable.get(t.table_name) ?? [],
      }),
    );
    const relationships: FkEdge[] = []; // no FK graph on BigQuery
    return { schema: ds, tables, relationships };
  }

  /**
   * BigQuery has no EXPLAIN plan tree. A `dryRun` validates the SQL and returns the byte
   * estimate WITHOUT executing — that is the plan-only check, and it also surfaces the cost.
   */
  async explainQuery(sql: string, params: unknown[] = []): Promise<string[]> {
    await this.assertReadOnlySafe();
    const client = await this.bq();
    const [job] = await client.createQueryJob({
      ...this.jobOpts(sql, params),
      dryRun: true,
    });
    const bytes = job.metadata?.statistics?.totalBytesProcessed ?? "unknown";
    return [`Valid (dry run). Estimated bytes processed: ${bytes}.`];
  }

  isValidityError(e: unknown): boolean {
    return isBigQueryValidityError(e);
  }

  async close(): Promise<void> {
    // The BigQuery client is stateless HTTP — nothing to close.
    this.client = null;
  }
}
