import { describe, it, expect, afterEach } from "vitest";
import { AuditTrail } from "../src/audit/trail.js";

let trail: AuditTrail | undefined;
afterEach(() => {
  trail?.close();
  trail = undefined;
});

describe("AuditTrail", () => {
  it("logs a successful query", () => {
    trail = new AuditTrail(":memory:");
    trail.log({ sql: "SELECT 1", params: [42], rowCount: 1, execMs: 5 });
    const row = trail.db.prepare("SELECT * FROM query_log").get() as Record<
      string,
      unknown
    >;
    expect(row.sql_text).toBe("SELECT 1");
    expect(row.params).toBe("[42]");
    expect(row.row_count).toBe(1);
    expect(row.error).toBeNull();
  });

  it("logs a rejected query with an error and no row count", () => {
    trail = new AuditTrail(":memory:");
    trail.log({
      sql: "DROP TABLE t",
      error: "only SELECT / WITH queries are allowed",
    });
    const row = trail.db.prepare("SELECT * FROM query_log").get() as Record<
      string,
      unknown
    >;
    expect(row.error).toContain("only SELECT");
    expect(row.row_count).toBeNull();
  });

  it("prunes rows older than the retention window", () => {
    trail = new AuditTrail(":memory:", 90);
    // backdate a row 200 days into the past
    trail.db
      .prepare(
        "INSERT INTO query_log (ts, sql_text) VALUES (datetime('now','-200 days'), 'old')",
      )
      .run();
    trail.log({ sql: "SELECT 1" });
    const removed = trail.pruneOld();
    expect(removed).toBe(1);
    const remaining = trail.db
      .prepare("SELECT count(*) AS c FROM query_log")
      .get() as { c: number };
    expect(remaining.c).toBe(1);
  });
});
