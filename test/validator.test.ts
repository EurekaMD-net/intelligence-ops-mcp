import { describe, it, expect } from "vitest";
import { validateSql, MAX_SQL_LENGTH } from "../src/validator/sql.js";

describe("validateSql — accepts legitimate reads", () => {
  it("accepts a simple SELECT", () => {
    expect(validateSql("SELECT 1")).toEqual({ valid: true, sql: "SELECT 1" });
  });

  it("accepts lower-case select", () => {
    expect(validateSql("select * from productos").valid).toBe(true);
  });

  it("accepts WITH … SELECT", () => {
    const r = validateSql("WITH t AS (SELECT 1 AS n) SELECT * FROM t");
    expect(r.valid).toBe(true);
  });

  it("accepts a leading parenthesis", () => {
    expect(validateSql("(SELECT 1) UNION (SELECT 2)").valid).toBe(true);
  });

  it("does NOT false-positive on created_at / updated_at / deleted_at columns", () => {
    const sql =
      "SELECT created_at, updated_at, deleted_at FROM ventas WHERE deleted_at IS NULL";
    expect(validateSql(sql).valid).toBe(true);
  });

  it("does NOT false-positive on a literal containing a blocked word", () => {
    expect(
      validateSql("SELECT * FROM logs WHERE status = 'UPDATED'").valid,
    ).toBe(true);
  });

  it("strips a single trailing semicolon", () => {
    expect(validateSql("SELECT 1;")).toEqual({ valid: true, sql: "SELECT 1" });
  });

  it("accepts a semicolon inside a string literal", () => {
    expect(validateSql("SELECT * FROM t WHERE note = 'a;b'").valid).toBe(true);
  });

  it("accepts a leading block / line comment before SELECT", () => {
    expect(validateSql("/* report */ SELECT 1").valid).toBe(true);
    expect(validateSql("-- daily\nSELECT 1").valid).toBe(true);
  });

  it("accepts a semicolon inside a dollar-quote or comment (no false positive)", () => {
    expect(validateSql("SELECT $$;$$ AS x").valid).toBe(true);
    expect(validateSql("SELECT $tag$a;b$tag$ AS x").valid).toBe(true);
    expect(validateSql("SELECT 1 -- trailing ; comment").valid).toBe(true);
    expect(validateSql("SELECT 1 /* a ; b */").valid).toBe(true);
  });

  it("does not treat a positional param ($1) as a dollar-quote", () => {
    expect(validateSql("SELECT * FROM t WHERE id = $1").valid).toBe(true);
  });
});

describe("validateSql — statement separator detection (dollar-quote aware)", () => {
  it("catches a real ';' hidden after a dollar-quote", () => {
    // the lone ' inside $$…$$ must NOT flip a quote state and hide the separator
    expect(validateSql("SELECT $$I'm$$ ; DROP TABLE big").valid).toBe(false);
  });

  it("still rejects plain statement chaining", () => {
    expect(validateSql("SELECT 1; SELECT 2").valid).toBe(false);
  });
});

describe("validateSql — rejects unsafe / non-read input", () => {
  it("rejects an empty string", () => {
    const r = validateSql("   ");
    expect(r.valid).toBe(false);
  });

  it("rejects multiple statements", () => {
    const r = validateSql("SELECT 1; DROP TABLE productos");
    expect(r).toEqual({
      valid: false,
      reason: "multiple statements are not allowed — run one query at a time",
    });
  });

  it.each([
    "INSERT INTO t VALUES (1)",
    "UPDATE t SET x=1",
    "DELETE FROM t",
    "DROP TABLE t",
    "ALTER TABLE t ADD c int",
    "TRUNCATE t",
    "GRANT SELECT ON t TO u",
  ])("rejects non-SELECT statement: %s", (sql) => {
    expect(validateSql(sql).valid).toBe(false);
  });

  it("rejects over-length sql", () => {
    const r = validateSql("SELECT " + "a".repeat(MAX_SQL_LENGTH));
    expect(r.valid).toBe(false);
  });
});
