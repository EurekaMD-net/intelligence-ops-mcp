/** Shapes the connector and tools exchange. Dialect-agnostic from Phase 4 on. */

/** The dialects that are BUILT and integration-tested against a real engine. No member
 *  for a deferred dialect: that keeps the factory's exhaustive switch a compile-time
 *  refusal gate (adding a literal here without a built case is a `never`-default error). */
export type Dialect = "postgres" | "mysql";

/** EXPERIMENTAL dialects: code-complete against the vendor SDK but NOT integration-tested
 *  (cloud-credential-only — no throwaway container / CI-verifiable emulator). They are
 *  UNVERIFIED and quarantined: unreachable unless `IOMCP_ENABLE_UNVERIFIED_DIALECTS=true`,
 *  each refuses to run a query for a writable principal at runtime, and the operator must
 *  follow docs/verify-cloud-connectors.md before trusting them. Kept OUT of `Dialect` on
 *  purpose so they are never confused with the verified set. */
export type ExperimentalDialect = "bigquery" | "snowflake";

export type AnyDialect = Dialect | ExperimentalDialect;

/** Per-dialect traits the host needs to know. Minimal by design (YAGNI): only the
 *  one trait with a live consumer — the SQL-agent prompt's placeholder style.
 *  `$n` = $1,$2 (Postgres); `?` = positional (MySQL). Add foreignKeys/transactions
 *  flags in the same PR that builds the first FK-less or txn-less connector. */
export interface Capabilities {
  paramStyle: "$n" | "?";
}

/** Config for the VERIFIED relational dialects (postgres, mysql). */
export interface ConnectorConfig {
  dialect: Dialect;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
  poolMax: number;
  connectTimeoutMs: number;
  statementTimeoutMs: number;
  /** Hard ceiling on rows a single execute_query can return. */
  maxRows: number;
}

/** Config for the EXPERIMENTAL BigQuery connector (auth = service-account or ADC). */
export interface BigQueryConfig {
  dialect: "bigquery";
  projectId: string;
  /** Default dataset — BigQuery's analogue of a schema (the schema-tool default). */
  defaultDataset: string;
  /** Path to a service-account JSON; omit to use Application Default Credentials. */
  keyFilename?: string;
  /** Dataset/job location, e.g. "US", "EU", "us-central1". */
  location?: string;
  /** Hard cost ceiling: a query scanning more than this many bytes is rejected by BigQuery. */
  maxBytesBilled: string;
  statementTimeoutMs: number;
  maxRows: number;
}

/** Config for the EXPERIMENTAL Snowflake connector. */
export interface SnowflakeConfig {
  dialect: "snowflake";
  account: string;
  username: string;
  /** Password auth; OR set privateKeyPath for key-pair auth. */
  password?: string;
  privateKeyPath?: string;
  warehouse: string;
  database: string;
  schema: string;
  /** The role to assume — MUST be a read-only role (SELECT/USAGE grants only). */
  role?: string;
  connectTimeoutMs: number;
  statementTimeoutMs: number;
  maxRows: number;
}

/** Any config the factory can load — verified relational or experimental cloud. */
export type AnyConnectorConfig =
  ConnectorConfig | BigQueryConfig | SnowflakeConfig;

/**
 * The seam every tool depends on (type-only). A concrete connector — Postgres,
 * MySQL — `implements Connector`; tools never name a concrete class. Read-only is
 * a STRUCTURAL guarantee of each implementation (read-only role/grant + read-only
 * transaction), not a flag checked here.
 */
export interface Connector {
  readonly dialect: AnyDialect;
  readonly capabilities: Capabilities;
  listTables(schema?: string): Promise<TableInfo[]>;
  describeTable(table: string, schema?: string): Promise<TableSchema>;
  runUserQuery(
    sql: string,
    params?: unknown[],
    limit?: number,
  ): Promise<QueryResult>;
  getSchemaContext(schema?: string): Promise<SchemaContext>;
  explainQuery(sql: string, params?: unknown[]): Promise<string[]>;
  healthCheck(): Promise<boolean>;
  close(): Promise<void>;
  /**
   * True iff `e` is the driver's "server evaluated this SQL and rejected it"
   * error (→ the query is genuinely invalid). Connection/infra errors return
   * false so validate_query reports a tool error, not a false "invalid" verdict.
   * Owned by each connector because the discriminant is driver-specific
   * (pg.DatabaseError vs a mysql2 `ER_`-prefixed code).
   */
  isValidityError(e: unknown): boolean;
}

export interface TableInfo {
  name: string;
  schema: string;
  rowCountEstimate: number;
  comment: string | null;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  isPk: boolean;
  /** "schema.table.column" of the referenced column, or null. */
  fkReferences: string | null;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface TableSchema {
  table: string;
  schema: string;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  rowCountEstimate: number;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  executionMs: number;
  /** true when the result hit the row cap and more rows exist. */
  truncated: boolean;
}

// --- Phase 2: schema discovery ---

export interface SchemaTable {
  name: string;
  comment: string | null;
  rowCountEstimate: number;
  columns: ColumnInfo[];
}

/** A foreign-key edge: `from` (table.column) references `to` (schema.table.column). */
export interface FkEdge {
  from: string;
  to: string;
}

/** Whole-schema context, LLM-ready: every table's shape + the FK relationship graph. */
export interface SchemaContext {
  schema: string;
  tables: SchemaTable[];
  relationships: FkEdge[];
}
