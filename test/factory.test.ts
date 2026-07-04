import { describe, it, expect } from "vitest";
import {
  loadConnectorConfig,
  createConnector,
} from "../src/connector/factory.js";
import { PostgresConnector } from "../src/connector/postgres.js";
import { MysqlConnector } from "../src/connector/mysql.js";
import type {
  AnyConnectorConfig,
  ConnectorConfig,
} from "../src/connector/types.js";

/** Narrow the union to a relational config (postgres|mysql) for property assertions. */
function rel(c: AnyConnectorConfig): ConnectorConfig {
  if (c.dialect !== "postgres" && c.dialect !== "mysql") {
    throw new Error(`expected a relational config, got ${c.dialect}`);
  }
  return c;
}

describe("loadConnectorConfig — verified dialects", () => {
  it("PG_* with NO IOMCP_DIALECT → identical v0.3.0 connection config (zero migration)", () => {
    const cfg = loadConnectorConfig({
      PG_HOST: "h",
      PG_PORT: "6000",
      PG_DATABASE: "d",
      PG_USER: "u",
      PG_PASSWORD: "p",
      PG_SSL: "true",
      PG_POOL_MAX: "9",
      PG_CONNECT_TIMEOUT_MS: "1234",
      PG_STATEMENT_TIMEOUT_MS: "4567",
      MAX_RESULT_ROWS: "222",
    });
    expect(cfg).toEqual({
      dialect: "postgres",
      host: "h",
      port: 6000,
      database: "d",
      user: "u",
      password: "p",
      ssl: true,
      sslInsecure: false,
      poolMax: 9,
      connectTimeoutMs: 1234,
      statementTimeoutMs: 4567,
      maxRows: 222,
    });
  });

  it("empty env → postgres defaults", () => {
    expect(loadConnectorConfig({})).toEqual({
      dialect: "postgres",
      host: "localhost",
      port: 5432,
      database: "postgres",
      user: "postgres",
      password: "",
      ssl: false,
      sslInsecure: false,
      poolMax: 5,
      connectTimeoutMs: 5000,
      statementTimeoutMs: 30000,
      maxRows: 1000,
    });
  });

  it("floors statementTimeout≥1000, poolMax≥1, maxRows≥1 even when env says 0", () => {
    const cfg = rel(
      loadConnectorConfig({
        PG_STATEMENT_TIMEOUT_MS: "0",
        PG_POOL_MAX: "0",
        MAX_RESULT_ROWS: "0",
      }),
    );
    expect(cfg.statementTimeoutMs).toBe(1000);
    expect(cfg.poolMax).toBe(1);
    expect(cfg.maxRows).toBe(1);
  });

  it("TLS cert verification is on by default; PG_SSL_INSECURE=true opts out", () => {
    expect(rel(loadConnectorConfig({ PG_SSL: "true" })).sslInsecure).toBe(
      false,
    );
    expect(
      rel(loadConnectorConfig({ PG_SSL: "true", PG_SSL_INSECURE: "true" }))
        .sslInsecure,
    ).toBe(true);
  });

  it("IOMCP_DIALECT=mysql reads MYSQL_* with port 3306 default", () => {
    const cfg = rel(
      loadConnectorConfig({
        IOMCP_DIALECT: "mysql",
        MYSQL_HOST: "mh",
        MYSQL_DATABASE: "shop",
        MYSQL_USER: "ro",
      }),
    );
    expect(cfg.dialect).toBe("mysql");
    expect(cfg.host).toBe("mh");
    expect(cfg.port).toBe(3306);
    expect(cfg.database).toBe("shop");
    expect(cfg.user).toBe("ro");
  });

  it("throws on an unsupported IOMCP_DIALECT", () => {
    expect(() => loadConnectorConfig({ IOMCP_DIALECT: "oracle" })).toThrow(
      /unsupported IOMCP_DIALECT/,
    );
  });

  it("requires MYSQL_USER (no root default — this server is read-only)", () => {
    expect(() =>
      loadConnectorConfig({ IOMCP_DIALECT: "mysql", MYSQL_DATABASE: "d" }),
    ).toThrow(/MYSQL_USER is required/);
  });

  it("requires MYSQL_DATABASE (it is also the default schema)", () => {
    expect(() =>
      loadConnectorConfig({ IOMCP_DIALECT: "mysql", MYSQL_USER: "ro" }),
    ).toThrow(/MYSQL_DATABASE is required/);
  });
});

describe("loadConnectorConfig — experimental dialects are gated", () => {
  it("bigquery is REFUSED without IOMCP_ENABLE_UNVERIFIED_DIALECTS", () => {
    expect(() =>
      loadConnectorConfig({
        IOMCP_DIALECT: "bigquery",
        BIGQUERY_PROJECT_ID: "p",
        BIGQUERY_DATASET: "d",
      }),
    ).toThrow(/UNVERIFIED experimental dialect/);
  });

  it("snowflake is REFUSED without IOMCP_ENABLE_UNVERIFIED_DIALECTS", () => {
    expect(() => loadConnectorConfig({ IOMCP_DIALECT: "snowflake" })).toThrow(
      /UNVERIFIED experimental dialect/,
    );
  });

  it("with the flag, bigquery parses and requires project + dataset", () => {
    const cfg = loadConnectorConfig({
      IOMCP_DIALECT: "bigquery",
      IOMCP_ENABLE_UNVERIFIED_DIALECTS: "true",
      BIGQUERY_PROJECT_ID: "proj",
      BIGQUERY_DATASET: "ds",
      BIGQUERY_MAX_BYTES_BILLED: "500",
    });
    expect(cfg.dialect).toBe("bigquery");
    if (cfg.dialect === "bigquery") {
      expect(cfg.projectId).toBe("proj");
      expect(cfg.defaultDataset).toBe("ds");
      expect(cfg.maxBytesBilled).toBe("500");
    }
    expect(() =>
      loadConnectorConfig({
        IOMCP_DIALECT: "bigquery",
        IOMCP_ENABLE_UNVERIFIED_DIALECTS: "true",
        BIGQUERY_DATASET: "ds",
      }),
    ).toThrow(/BIGQUERY_PROJECT_ID is required/);
  });

  it("with the flag, snowflake parses and requires account/warehouse/db/schema + auth", () => {
    const cfg = loadConnectorConfig({
      IOMCP_DIALECT: "snowflake",
      IOMCP_ENABLE_UNVERIFIED_DIALECTS: "true",
      SNOWFLAKE_ACCOUNT: "acct",
      SNOWFLAKE_USERNAME: "u",
      SNOWFLAKE_PASSWORD: "pw",
      SNOWFLAKE_WAREHOUSE: "wh",
      SNOWFLAKE_DATABASE: "db",
      SNOWFLAKE_SCHEMA: "sch",
      SNOWFLAKE_ROLE: "RO_ROLE",
    });
    expect(cfg.dialect).toBe("snowflake");
    if (cfg.dialect === "snowflake") {
      expect(cfg.account).toBe("acct");
      expect(cfg.role).toBe("RO_ROLE");
    }
    // no password and no key → refused
    expect(() =>
      loadConnectorConfig({
        IOMCP_DIALECT: "snowflake",
        IOMCP_ENABLE_UNVERIFIED_DIALECTS: "true",
        SNOWFLAKE_ACCOUNT: "acct",
        SNOWFLAKE_USERNAME: "u",
        SNOWFLAKE_WAREHOUSE: "wh",
        SNOWFLAKE_DATABASE: "db",
        SNOWFLAKE_SCHEMA: "sch",
      }),
    ).toThrow(/SNOWFLAKE_PASSWORD or SNOWFLAKE_PRIVATE_KEY_PATH/);
  });
});

describe("createConnector (the structural refusal gate)", () => {
  it("builds a PostgresConnector for dialect postgres", async () => {
    const c = await createConnector(loadConnectorConfig({}));
    expect(c).toBeInstanceOf(PostgresConnector);
    expect(c.dialect).toBe("postgres");
    expect(c.capabilities.paramStyle).toBe("$n");
    await c.close();
  });

  it("builds a MysqlConnector for dialect mysql", async () => {
    const c = await createConnector(
      loadConnectorConfig({
        IOMCP_DIALECT: "mysql",
        MYSQL_DATABASE: "d",
        MYSQL_USER: "ro",
      }),
    );
    expect(c).toBeInstanceOf(MysqlConnector);
    expect(c.dialect).toBe("mysql");
    expect(c.capabilities.paramStyle).toBe("?");
    await c.close();
  });

  it("refuses a forged config with a truly unknown dialect (never-default)", async () => {
    const forged = {
      ...loadConnectorConfig({}),
      dialect: "oracle",
    } as unknown as AnyConnectorConfig;
    await expect(createConnector(forged)).rejects.toThrow(
      /unsupported dialect/,
    );
  });

  it("refuses an experimental config when the flag is off (second refusal layer)", async () => {
    const forged = {
      dialect: "snowflake",
      account: "a",
      username: "u",
      password: "p",
      warehouse: "w",
      database: "d",
      schema: "s",
      connectTimeoutMs: 5000,
      statementTimeoutMs: 30000,
      maxRows: 1000,
    } as unknown as AnyConnectorConfig;
    // IOMCP_ENABLE_UNVERIFIED_DIALECTS is not set in the test env.
    await expect(createConnector(forged)).rejects.toThrow(
      /disabled|UNVERIFIED/,
    );
  });
});
