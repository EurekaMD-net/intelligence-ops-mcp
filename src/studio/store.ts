import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS saved_queries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  version     INTEGER NOT NULL,
  sql_text    TEXT NOT NULL,
  description TEXT,
  created_at  TEXT DEFAULT (datetime('now')),
  is_current  INTEGER NOT NULL DEFAULT 1,
  UNIQUE(name, version)
);
CREATE INDEX IF NOT EXISTS idx_saved_queries_name ON saved_queries(name);

CREATE TABLE IF NOT EXISTS monitors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  sql_text    TEXT NOT NULL,
  params      TEXT,
  operator    TEXT NOT NULL,
  threshold   REAL NOT NULL,
  description TEXT,
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);`;

export interface SavedQuery {
  name: string;
  version: number;
  sql: string;
  description: string | null;
  createdAt: string;
  isCurrent: boolean;
}

export interface SavedQuerySummary {
  name: string;
  version: number;
  description: string | null;
  createdAt: string;
}

export type MonitorOperator = ">" | ">=" | "<" | "<=" | "==" | "!=";

export interface Monitor {
  name: string;
  sql: string;
  params: unknown[];
  operator: MonitorOperator;
  threshold: number;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * SQLite persistence for the Phase-5 "SQL Studio" + "Automation" PRIMITIVES: versioned
 * saved queries and monitor definitions. This store ONLY persists/reads — it never runs
 * SQL, schedules anything, or delivers notifications (the host/Jarvis owns UI, cron, and
 * delivery). Saved SQL is opaque text here; it is validated + executed through the read-only
 * connector path at run/evaluate time, so all the connector's guarantees still apply.
 */
export class StudioStore {
  readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  // --- Saved queries (versioned) ---

  /** Save a query under `name`. Each save is a new version; the new one becomes current. */
  saveQuery(name: string, sql: string, description?: string): number {
    const tx = this.db.transaction((): number => {
      const row = this.db
        .prepare(
          `SELECT COALESCE(MAX(version), 0) AS v FROM saved_queries WHERE name = ?`,
        )
        .get(name) as { v: number };
      const version = row.v + 1;
      this.db
        .prepare(`UPDATE saved_queries SET is_current = 0 WHERE name = ?`)
        .run(name);
      this.db
        .prepare(
          `INSERT INTO saved_queries (name, version, sql_text, description, is_current)
           VALUES (?, ?, ?, ?, 1)`,
        )
        .run(name, version, sql, description ?? null);
      return version;
    });
    return tx();
  }

  listSavedQueries(): SavedQuerySummary[] {
    const rows = this.db
      .prepare(
        `SELECT name, version, description, created_at
         FROM saved_queries WHERE is_current = 1 ORDER BY name`,
      )
      .all() as Array<{
      name: string;
      version: number;
      description: string | null;
      created_at: string;
    }>;
    return rows.map((r) => ({
      name: r.name,
      version: r.version,
      description: r.description,
      createdAt: r.created_at,
    }));
  }

  /** Get a saved query by name (latest version) or a specific version. Null if absent. */
  getSavedQuery(name: string, version?: number): SavedQuery | null {
    const row = (
      version === undefined
        ? this.db
            .prepare(
              `SELECT name, version, sql_text, description, created_at, is_current
               FROM saved_queries WHERE name = ? AND is_current = 1`,
            )
            .get(name)
        : this.db
            .prepare(
              `SELECT name, version, sql_text, description, created_at, is_current
               FROM saved_queries WHERE name = ? AND version = ?`,
            )
            .get(name, version)
    ) as
      | {
          name: string;
          version: number;
          sql_text: string;
          description: string | null;
          created_at: string;
          is_current: number;
        }
      | undefined;
    if (!row) return null;
    return {
      name: row.name,
      version: row.version,
      sql: row.sql_text,
      description: row.description,
      createdAt: row.created_at,
      isCurrent: row.is_current === 1,
    };
  }

  /** Delete one version, or (version omitted) every version of `name`. Returns rows removed. */
  deleteSavedQuery(name: string, version?: number): number {
    const tx = this.db.transaction((): number => {
      if (version === undefined) {
        return this.db
          .prepare(`DELETE FROM saved_queries WHERE name = ?`)
          .run(name).changes;
      }
      const changes = this.db
        .prepare(`DELETE FROM saved_queries WHERE name = ? AND version = ?`)
        .run(name, version).changes;
      // If we removed the current version, promote the highest remaining one.
      const hasCurrent = this.db
        .prepare(
          `SELECT 1 FROM saved_queries WHERE name = ? AND is_current = 1 LIMIT 1`,
        )
        .get(name);
      if (!hasCurrent) {
        const max = this.db
          .prepare(`SELECT MAX(version) AS v FROM saved_queries WHERE name = ?`)
          .get(name) as { v: number | null };
        if (max.v !== null) {
          this.db
            .prepare(
              `UPDATE saved_queries SET is_current = 1 WHERE name = ? AND version = ?`,
            )
            .run(name, max.v);
        }
      }
      return changes;
    });
    return tx();
  }

  // --- Monitors (single definition per name, upserted) ---

  saveMonitor(m: {
    name: string;
    sql: string;
    operator: MonitorOperator;
    threshold: number;
    params?: unknown[];
    description?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO monitors (name, sql_text, params, operator, threshold, description)
         VALUES (@name, @sql, @params, @operator, @threshold, @description)
         ON CONFLICT(name) DO UPDATE SET
           sql_text = excluded.sql_text,
           params = excluded.params,
           operator = excluded.operator,
           threshold = excluded.threshold,
           description = excluded.description,
           updated_at = datetime('now')`,
      )
      .run({
        name: m.name,
        sql: m.sql,
        params: m.params ? JSON.stringify(m.params) : null,
        operator: m.operator,
        threshold: m.threshold,
        description: m.description ?? null,
      });
  }

  listMonitors(): Monitor[] {
    const rows = this.db
      .prepare(`SELECT * FROM monitors ORDER BY name`)
      .all() as Array<{
      name: string;
      sql_text: string;
      params: string | null;
      operator: string;
      threshold: number;
      description: string | null;
      created_at: string;
      updated_at: string;
    }>;
    return rows.map((r) => this.rowToMonitor(r));
  }

  getMonitor(name: string): Monitor | null {
    const row = this.db
      .prepare(`SELECT * FROM monitors WHERE name = ?`)
      .get(name) as
      | {
          name: string;
          sql_text: string;
          params: string | null;
          operator: string;
          threshold: number;
          description: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    return row ? this.rowToMonitor(row) : null;
  }

  deleteMonitor(name: string): number {
    return this.db.prepare(`DELETE FROM monitors WHERE name = ?`).run(name)
      .changes;
  }

  private rowToMonitor(r: {
    name: string;
    sql_text: string;
    params: string | null;
    operator: string;
    threshold: number;
    description: string | null;
    created_at: string;
    updated_at: string;
  }): Monitor {
    return {
      name: r.name,
      sql: r.sql_text,
      params: r.params ? (JSON.parse(r.params) as unknown[]) : [],
      operator: r.operator as MonitorOperator,
      threshold: r.threshold,
      description: r.description,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  close(): void {
    this.db.close();
  }
}
