import { describe, it, expect } from "vitest";
import {
  hasBigQueryWritePermission,
  isBigQueryValidityError,
} from "../src/connector/bigquery.js";
import {
  isSnowflakeWritePrivilege,
  isSnowflakeValidityError,
} from "../src/connector/snowflake.js";

// These cover the PURE, side-effect-free logic of the experimental cloud connectors.
// The connectors themselves are UNVERIFIED (no integration test — cloud-creds only);
// the read-only self-test and validity classification reduce to these functions.

describe("BigQuery — write-permission detection (read-only self-test)", () => {
  it("flags any write permission", () => {
    expect(hasBigQueryWritePermission(["bigquery.tables.updateData"])).toBe(
      true,
    );
    expect(hasBigQueryWritePermission(["bigquery.tables.create"])).toBe(true);
    expect(hasBigQueryWritePermission(["bigquery.datasets.delete"])).toBe(true);
  });
  it("passes a read-only permission set", () => {
    expect(
      hasBigQueryWritePermission([
        "bigquery.tables.get",
        "bigquery.tables.getData",
        "bigquery.jobs.create",
      ]),
    ).toBe(false);
    expect(hasBigQueryWritePermission([])).toBe(false);
  });
});

describe("BigQuery — validity-vs-infra classification", () => {
  it("invalidQuery / HTTP 400 → validity error", () => {
    expect(
      isBigQueryValidityError({ errors: [{ reason: "invalidQuery" }] }),
    ).toBe(true);
    expect(isBigQueryValidityError({ code: 400 })).toBe(true);
  });
  it("auth / network → NOT validity errors", () => {
    expect(isBigQueryValidityError({ code: 403 })).toBe(false);
    expect(
      isBigQueryValidityError(
        Object.assign(new Error("x"), { code: "ENOTFOUND" }),
      ),
    ).toBe(false);
    expect(isBigQueryValidityError(new Error("boom"))).toBe(false);
  });
});

describe("Snowflake — write-privilege detection (read-only self-test)", () => {
  it("flags write privileges (incl. CREATE *, OWNERSHIP, ALL)", () => {
    for (const p of [
      "INSERT",
      "update",
      " DELETE ",
      "TRUNCATE",
      "OWNERSHIP",
      "CREATE TABLE",
      "ALL",
    ]) {
      expect(isSnowflakeWritePrivilege(p)).toBe(true);
    }
  });
  it("passes read-only privileges", () => {
    for (const p of ["SELECT", "USAGE", "REFERENCES", "MONITOR"]) {
      expect(isSnowflakeWritePrivilege(p)).toBe(false);
    }
  });
});

describe("Snowflake — validity-vs-infra classification", () => {
  it("a server SQL error carries a SQLSTATE → validity error", () => {
    expect(isSnowflakeValidityError({ code: 904, sqlState: "42000" })).toBe(
      true,
    );
  });
  it("connection/network errors (no SQLSTATE) → NOT validity errors", () => {
    expect(
      isSnowflakeValidityError(
        Object.assign(new Error("x"), { code: "ECONNREFUSED" }),
      ),
    ).toBe(false);
    expect(isSnowflakeValidityError(new Error("boom"))).toBe(false);
  });
});
