/** Shapes the connector and tools exchange. Dialect-agnostic from Phase 4 on. */

/** The dialects that are BUILT and integration-tested. No member for a deferred
 *  dialect: that keeps the factory's exhaustive switch a compile-time refusal gate
 *  (adding a literal here without a built case is a `never`-default error). */
export type Dialect = "postgres" | "mysql";

/** Per-dialect traits the host needs to know. Minimal by design (YAGNI): only the
 *  one trait with a live consumer — the SQL-agent prompt's placeholder style.
 *  `$n` = $1,$2 (Postgres); `?` = positional (MySQL). Add foreignKeys/transactions
 *  flags in the same PR that builds the first FK-less or txn-less connector. */
export interface Capabilities {
  paramStyle: "$n" | "?";
}

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

/**
 * The seam every tool depends on (type-only). A concrete connector — Postgres,
 * MySQL — `implements Connector`; tools never name a concrete class. Read-only is
 * a STRUCTURAL guarantee of each implementation (read-only role/grant + read-only
 * transaction), not a flag checked here.
 */
export interface Connector {
  readonly dialect: Dialect;
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
