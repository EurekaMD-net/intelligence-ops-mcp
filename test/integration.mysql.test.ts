import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import mysql from "mysql2/promise";
import { MysqlConnector } from "../src/connector/mysql.js";
import { inferEChartsSpec } from "../src/render/echarts.js";
import type { ConnectorConfig } from "../src/connector/types.js";

// Needs a throwaway MySQL 8.0+. Set TEST_MYSQL_URL to run; otherwise skips (so
// `npm test` stays green without Docker), mirroring the Postgres integration gate.
const TEST_URL = process.env.TEST_MYSQL_URL;
const here = dirname(fileURLToPath(import.meta.url));

function configFromUrl(raw: string): ConnectorConfig {
  const u = new URL(raw);
  return {
    dialect: "mysql",
    host: u.hostname,
    port: Number(u.port || 3306),
    database: u.pathname.replace(/^\//, "") || "",
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    ssl: false,
    poolMax: 4,
    connectTimeoutMs: 5000,
    statementTimeoutMs: 30000,
    maxRows: 1000,
  };
}

// 5000-row helper table seeded by seed-demo.mysql.sql (MySQL has no generate_series).
const GEN = "SELECT n FROM numeros";

describe.skipIf(!TEST_URL)("MysqlConnector (integration)", () => {
  const cfg = TEST_URL ? configFromUrl(TEST_URL) : null;
  const db = cfg?.database ?? "";
  let connector: MysqlConnector;
  let seedPool: mysql.Pool;
  // The CONNECTOR connects as the SELECT-only user the seed creates (no FILE priv) — the
  // real production posture. The admin URL is used only to seed and for the root-refusal test.
  const roConfig = (): ConnectorConfig => ({
    ...cfg!,
    user: "iomcp_ro",
    password: "ro_pw",
  });

  beforeAll(async () => {
    const c = cfg!;
    // The seed file is multi-statement; the CONNECTOR keeps multipleStatements:false.
    seedPool = mysql.createPool({
      host: c.host,
      port: c.port,
      database: c.database,
      user: c.user,
      password: c.password,
      multipleStatements: true,
    });
    await seedPool.query(
      readFileSync(join(here, "..", "scripts", "seed-demo.mysql.sql"), "utf8"),
    );
    connector = new MysqlConnector(roConfig());
  });

  afterAll(async () => {
    await connector?.close();
    await seedPool?.end();
  });

  it("list_tables returns the seeded tables", async () => {
    const names = (await connector.listTables()).map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "sucursales",
        "productos",
        "inventario",
        "ventas",
      ]),
    );
  });

  it("describe_table returns columns, PK, FK references and indexes", async () => {
    const schema = await connector.describeTable("ventas");
    const byName = Object.fromEntries(schema.columns.map((c) => [c.name, c]));
    expect(byName.id?.isPk).toBe(true);
    expect(byName.sucursal_id?.fkReferences).toBe(`${db}.sucursales.id`);
    expect(schema.indexes.length).toBeGreaterThan(0);
  });

  it("describe_table maps a COMPOSITE foreign key by ordinal (no cross-product)", async () => {
    const schema = await connector.describeTable("promociones");
    const byName = Object.fromEntries(schema.columns.map((c) => [c.name, c]));
    expect(byName.region?.fkReferences).toBe(`${db}.precios_region.region`);
    expect(byName.producto_id?.fkReferences).toBe(
      `${db}.precios_region.producto_id`,
    );
  });

  it("execute_query runs a SELECT and returns rows", async () => {
    const r = await connector.runUserQuery(
      "SELECT nombre FROM sucursales ORDER BY id",
      [],
      100,
    );
    expect(r.rows.length).toBe(3);
    expect(r.columns).toContain("nombre");
    expect(r.truncated).toBe(false);
  });

  it("enforces the row cap with truncated=true", async () => {
    const r = await connector.runUserQuery("SELECT * FROM sucursales", [], 2);
    expect(r.rowCount).toBe(2);
    expect(r.truncated).toBe(true);
  });

  it("defaults to a 100-row page when no limit is given", async () => {
    const r = await connector.runUserQuery(GEN);
    expect(r.rowCount).toBe(100);
    expect(r.truncated).toBe(true);
  });

  it("hard-caps at maxRows even when the requested limit is larger", async () => {
    // config maxRows = 1000; ask for 99999 → clamped to 1000
    const r = await connector.runUserQuery(GEN, [], 99999);
    expect(r.rowCount).toBe(1000);
    expect(r.truncated).toBe(true);
  });

  it("a trailing comment cannot strip the cap (the stream is the real cap)", async () => {
    const r = await connector.runUserQuery(`${GEN} -- `, [], 10);
    expect(r.rowCount).toBe(10);
    expect(r.truncated).toBe(true);
  });

  it("runs every query inside a READ ONLY transaction (write rejected, table unchanged)", async () => {
    const before = await connector.runUserQuery(
      "SELECT COUNT(*) AS c FROM sucursales",
    );
    await expect(
      connector.runUserQuery(
        "INSERT INTO sucursales (nombre, ciudad) VALUES ('hack', 'x')",
      ),
    ).rejects.toThrow();
    const after = await connector.runUserQuery(
      "SELECT COUNT(*) AS c FROM sucursales",
    );
    expect(after.rows[0]).toEqual(before.rows[0]); // no row inserted
  });

  it("blocks an injected second statement (multipleStatements:false)", async () => {
    await expect(
      connector.runUserQuery("SELECT 1 AS a; DROP TABLE sucursales"),
    ).rejects.toThrow();
    // sucursales must still exist with its 3 rows
    const r = await connector.runUserQuery(
      "SELECT COUNT(*) AS c FROM sucursales",
    );
    expect(Number(r.rows[0]!.c)).toBe(3);
  });

  it("explainQuery returns a plan for a valid SELECT without executing it", async () => {
    const plan = await connector.explainQuery(
      "SELECT * FROM sucursales WHERE id = ?",
      [1],
    );
    expect(plan.join("\n").length).toBeGreaterThan(0);
  });

  it("explainQuery rejects an injected second statement (no DoS via plan path)", async () => {
    const t0 = Date.now();
    await expect(
      connector.explainQuery("SELECT 1; SELECT SLEEP(2)"),
    ).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(1500); // SLEEP(2) never ran
  });

  it("get_schema_context returns every table + the FK relationship graph", async () => {
    const ctx = await connector.getSchemaContext();
    expect(ctx.tables.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "sucursales",
        "productos",
        "inventario",
        "ventas",
        "promociones",
        "precios_region",
      ]),
    );
    expect(ctx.relationships).toEqual(
      expect.arrayContaining([
        { from: "ventas.sucursal_id", to: `${db}.sucursales.id` },
        { from: "promociones.region", to: `${db}.precios_region.region` },
        {
          from: "promociones.producto_id",
          to: `${db}.precios_region.producto_id`,
        },
      ]),
    );
  });

  it("serializes DECIMAL and DATETIME as strings (render-layer parity with pg)", async () => {
    const r = await connector.runUserQuery(
      "SELECT p.precio, v.vendido_en FROM ventas v JOIN productos p ON p.id = v.producto_id LIMIT 1",
    );
    expect(typeof r.rows[0]!.precio).toBe("string"); // DECIMAL → string
    expect(typeof r.rows[0]!.vendido_en).toBe("string"); // DATETIME → string
  });

  it("renders a bar chart from a real GROUP BY SUM (sum comes back as a string)", async () => {
    const r = await connector.runUserQuery(
      "SELECT s.nombre, SUM(v.cantidad) AS u FROM ventas v JOIN sucursales s ON s.id = v.sucursal_id GROUP BY s.nombre ORDER BY u DESC",
      [],
      100,
    );
    const chart = inferEChartsSpec(r.columns, r.rows);
    expect(chart.spec).not.toBeNull();
    const series = (
      chart.spec as { series: { type: string; data: unknown[] }[] }
    ).series[0]!;
    expect(series.type).toBe("bar");
    expect(
      series.data.every((n) => typeof n === "number" && Number.isFinite(n)),
    ).toBe(true);
  });

  it("REFUSES to run any query when the connected user holds FILE (the OUTFILE-write hole)", async () => {
    // The admin URL (root) holds FILE/ALL — SELECT … INTO OUTFILE is a write the read-only
    // transaction does NOT block, so the connector must refuse before any query runs.
    const rootConn = new MysqlConnector(cfg!);
    try {
      await expect(rootConn.runUserQuery("SELECT 1")).rejects.toThrow(
        /read-only safety|FILE/i,
      );
      await expect(rootConn.explainQuery("SELECT 1")).rejects.toThrow(
        /read-only safety|FILE/i,
      );
    } finally {
      await rootConn.close();
    }
  });

  it("explainQuery is TIME-BOUNDED (MySQL EXPLAIN executes derived subqueries)", async () => {
    // EXPLAIN of a derived-table SLEEP would run unbounded without the statement timeout.
    const short = new MysqlConnector({
      ...roConfig(),
      statementTimeoutMs: 1000,
    });
    try {
      const t0 = Date.now();
      await expect(
        short.explainQuery("SELECT * FROM (SELECT SLEEP(5) AS s) x"),
      ).rejects.toThrow();
      expect(Date.now() - t0).toBeLessThan(3000); // bounded ~1s, never 5s
    } finally {
      await short.close();
    }
  });
});
