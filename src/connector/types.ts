/** Shapes the connector and tools exchange. Phase 1 = Postgres only. */

export interface ConnectorConfig {
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
