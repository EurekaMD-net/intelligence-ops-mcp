import { describe, it, expect } from "vitest";
import {
  loadConnectorConfig,
  createConnector,
} from "../src/connector/factory.js";
import { PostgresConnector } from "../src/connector/postgres.js";
import { MysqlConnector } from "../src/connector/mysql.js";
import type { ConnectorConfig } from "../src/connector/types.js";

describe("loadConnectorConfig", () => {
  it("PG_* with NO IOMCP_DIALECT → byte-identical v0.3.0 config (zero migration)", () => {
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
      poolMax: 5,
      connectTimeoutMs: 5000,
      statementTimeoutMs: 30000,
      maxRows: 1000,
    });
  });

  it("floors statementTimeout≥1000, poolMax≥1, maxRows≥1 even when env says 0", () => {
    const cfg = loadConnectorConfig({
      PG_STATEMENT_TIMEOUT_MS: "0",
      PG_POOL_MAX: "0",
      MAX_RESULT_ROWS: "0",
    });
    expect(cfg.statementTimeoutMs).toBe(1000);
    expect(cfg.poolMax).toBe(1);
    expect(cfg.maxRows).toBe(1);
  });

  it("IOMCP_DIALECT=mysql reads MYSQL_* with port 3306 default", () => {
    const cfg = loadConnectorConfig({
      IOMCP_DIALECT: "mysql",
      MYSQL_HOST: "mh",
      MYSQL_DATABASE: "shop",
      MYSQL_USER: "ro",
    });
    expect(cfg.dialect).toBe("mysql");
    expect(cfg.host).toBe("mh");
    expect(cfg.port).toBe(3306);
    expect(cfg.database).toBe("shop");
    expect(cfg.user).toBe("ro");
  });

  it("throws on an unsupported IOMCP_DIALECT (refuse to build a config we can't serve)", () => {
    expect(() => loadConnectorConfig({ IOMCP_DIALECT: "snowflake" })).toThrow(
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

describe("createConnector (the structural refusal gate)", () => {
  it("builds a PostgresConnector for dialect postgres", async () => {
    const c = createConnector(loadConnectorConfig({}));
    expect(c).toBeInstanceOf(PostgresConnector);
    expect(c.dialect).toBe("postgres");
    expect(c.capabilities.paramStyle).toBe("$n");
    await c.close();
  });

  it("builds a MysqlConnector for dialect mysql", async () => {
    const c = createConnector(
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

  it("refuses a forged config whose dialect was never built", () => {
    const forged = {
      ...loadConnectorConfig({}),
      dialect: "snowflake",
    } as unknown as ConnectorConfig;
    expect(() => createConnector(forged)).toThrow(/unsupported dialect/);
  });
});
