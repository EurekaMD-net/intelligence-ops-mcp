import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS query_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT DEFAULT (datetime('now')),
  sql_text   TEXT NOT NULL,
  params     TEXT,
  row_count  INTEGER,
  exec_ms    INTEGER,
  error      TEXT,
  client_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_query_log_ts ON query_log(ts);`;

export interface AuditEntry {
  sql: string;
  params?: unknown[];
  rowCount?: number;
  execMs?: number;
  error?: string;
  clientId?: string;
}

/** Local SQLite audit trail — one row per query attempt (success or rejection). */
export class AuditTrail {
  readonly db: Database.Database;
  private readonly retentionDays: number;

  constructor(path: string, retentionDays = 90) {
    // A non-numeric AUDIT_RETENTION_DAYS yields NaN → datetime('now','-NaN days') is NULL,
    // so nothing is ever pruned and query_log grows unbounded. Clamp to a positive integer.
    this.retentionDays =
      Number.isFinite(retentionDays) && retentionDays > 0
        ? Math.floor(retentionDays)
        : 90;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.pruneOld();
  }

  log(entry: AuditEntry): void {
    // Isolate audit-write failures (e.g. disk full): a logging error must not
    // turn into a tool error. Surface it to stderr instead.
    try {
      this.db
        .prepare(
          `INSERT INTO query_log (sql_text, params, row_count, exec_ms, error, client_id)
           VALUES (@sql, @params, @rowCount, @execMs, @error, @clientId)`,
        )
        .run({
          sql: entry.sql,
          params: entry.params ? JSON.stringify(entry.params) : null,
          rowCount: entry.rowCount ?? null,
          execMs: entry.execMs ?? null,
          error: entry.error ?? null,
          clientId: entry.clientId ?? null,
        });
    } catch (e) {
      console.error(
        "[iomcp] audit log write failed:",
        e instanceof Error ? e.message : e,
      );
    }
  }

  /** Delete rows older than the retention window. Runs at startup. */
  pruneOld(): number {
    const res = this.db
      .prepare(`DELETE FROM query_log WHERE ts < datetime('now', ?)`)
      .run(`-${this.retentionDays} days`);
    return res.changes;
  }

  close(): void {
    this.db.close();
  }
}
