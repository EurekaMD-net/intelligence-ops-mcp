import { describe, it, expect } from "vitest";
import { DatabaseError } from "pg";
import { isSqlValidityError } from "../src/tools/validate-query.js";

describe("validate_query error classification", () => {
  it("a pg DatabaseError (server rejected the SQL) is a validity error", () => {
    expect(
      isSqlValidityError(
        new DatabaseError("syntax error at or near", 100, "error"),
      ),
    ).toBe(true);
  });

  it("connection errors (ECONNREFUSED / ENOTFOUND) are NOT validity errors — infra failures", () => {
    expect(
      isSqlValidityError(
        Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
        }),
      ),
    ).toBe(false);
    expect(
      isSqlValidityError(
        Object.assign(new Error("getaddrinfo ENOTFOUND"), {
          code: "ENOTFOUND",
        }),
      ),
    ).toBe(false);
  });

  it("a plain Error / pool timeout (no SQLSTATE) is not a validity error", () => {
    expect(
      isSqlValidityError(new Error("timeout exceeded when trying to connect")),
    ).toBe(false);
  });
});
