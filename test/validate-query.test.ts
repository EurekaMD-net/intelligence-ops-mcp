import { describe, it, expect, afterAll } from "vitest";
import pg from "pg";
import { PostgresConnector } from "../src/connector/postgres.js";
import { MysqlConnector } from "../src/connector/mysql.js";
import type { ConnectorConfig } from "../src/connector/types.js";

// Constructing a pool opens no connection, so these stay DB-free. The classifier
// (validity-error vs infra-error) now lives on each connector, per dialect.
const relational = (dialect: "postgres" | "mysql"): ConnectorConfig => ({
  dialect,
  host: "localhost",
  port: dialect === "postgres" ? 5432 : 3306,
  database: "d",
  user: "ro",
  password: "",
  ssl: false,
  poolMax: 1,
  connectTimeoutMs: 5000,
  statementTimeoutMs: 30000,
  maxRows: 1000,
});
const pgc = new PostgresConnector(relational("postgres"));
const myc = new MysqlConnector(relational("mysql"));
afterAll(async () => {
  await pgc.close();
  await myc.close();
});

describe("PostgresConnector.isValidityError", () => {
  it("a pg DatabaseError (server rejected the SQL) is a validity error", () => {
    expect(
      pgc.isValidityError(new pg.DatabaseError("syntax error", 100, "error")),
    ).toBe(true);
  });

  it("connection errors (ECONNREFUSED / ENOTFOUND) are NOT validity errors", () => {
    expect(
      pgc.isValidityError(
        Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
        }),
      ),
    ).toBe(false);
    expect(
      pgc.isValidityError(
        Object.assign(new Error("getaddrinfo ENOTFOUND"), {
          code: "ENOTFOUND",
        }),
      ),
    ).toBe(false);
  });

  it("a plain Error / pool timeout (no SQLSTATE) is not a validity error", () => {
    expect(pgc.isValidityError(new Error("timeout when connecting"))).toBe(
      false,
    );
  });
});

describe("MysqlConnector.isValidityError", () => {
  it("an ER_-prefixed code (server rejected the SQL) is a validity error", () => {
    expect(
      myc.isValidityError(
        Object.assign(new Error("parse"), { code: "ER_PARSE_ERROR" }),
      ),
    ).toBe(true);
    expect(
      myc.isValidityError(
        Object.assign(new Error("no table"), { code: "ER_NO_SUCH_TABLE" }),
      ),
    ).toBe(true);
  });

  it("connection codes are NOT validity errors", () => {
    expect(
      myc.isValidityError(
        Object.assign(new Error("x"), { code: "ECONNREFUSED" }),
      ),
    ).toBe(false);
    expect(
      myc.isValidityError(
        Object.assign(new Error("x"), {
          code: "PROTOCOL_CONNECTION_LOST",
          fatal: true,
        }),
      ),
    ).toBe(false);
  });

  it("a fatal error is never a validity error, even with an ER_ code", () => {
    expect(
      myc.isValidityError(
        Object.assign(new Error("x"), { code: "ER_PARSE_ERROR", fatal: true }),
      ),
    ).toBe(false);
  });

  it("an error without a code is not a validity error", () => {
    expect(myc.isValidityError(new Error("no code"))).toBe(false);
  });

  it("a query/lock TIMEOUT on valid SQL is NOT a validity error (don't make the LLM repair good SQL)", () => {
    expect(
      myc.isValidityError(
        Object.assign(new Error("timeout"), { code: "ER_QUERY_TIMEOUT" }),
      ),
    ).toBe(false);
    expect(
      myc.isValidityError(
        Object.assign(new Error("lock"), { code: "ER_LOCK_WAIT_TIMEOUT" }),
      ),
    ).toBe(false);
  });
});
