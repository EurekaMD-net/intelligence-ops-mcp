import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { PostgresConnector } from "../src/connector/postgres.js";
import type { ConnectorConfig } from "../src/connector/types.js";

// Integration tests need a throwaway Postgres. Set TEST_PG_URL to run them;
// otherwise they skip (so `npm test` stays green without Docker).
const TEST_URL = process.env.TEST_PG_URL;
const here = dirname(fileURLToPath(import.meta.url));

function configFromUrl(raw: string): ConnectorConfig {
  const u = new URL(raw);
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    database: u.pathname.replace(/^\//, "") || "postgres",
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    ssl: false,
    poolMax: 4,
    connectTimeoutMs: 5000,
    statementTimeoutMs: 30000,
    maxRows: 1000,
  };
}

describe.skipIf(!TEST_URL)("PostgresConnector (integration)", () => {
  let connector: PostgresConnector;
  let seedPool: pg.Pool;

  beforeAll(async () => {
    const cfg = configFromUrl(TEST_URL!);
    seedPool = new pg.Pool({
      host: cfg.host,
      port: cfg.port,
      database: cfg.database,
      user: cfg.user,
      password: cfg.password,
    });
    await seedPool.query(
      readFileSync(join(here, "..", "scripts", "seed-demo.sql"), "utf8"),
    );
    connector = new PostgresConnector(cfg);
  });

  afterAll(async () => {
    await connector?.close();
    await seedPool?.end();
  });

  it("list_tables returns the seeded tables with row estimates", async () => {
    const tables = await connector.listTables("public");
    const names = tables.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "sucursales",
        "productos",
        "inventario",
        "ventas",
      ]),
    );
  });

  it("describe_table returns columns, PK and FK references", async () => {
    const schema = await connector.describeTable("ventas");
    const byName = Object.fromEntries(schema.columns.map((c) => [c.name, c]));
    expect(byName.id?.isPk).toBe(true);
    expect(byName.sucursal_id?.fkReferences).toBe("public.sucursales.id");
    expect(schema.indexes.length).toBeGreaterThan(0);
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

  it("execute_query enforces the row cap with truncated=true", async () => {
    const r = await connector.runUserQuery("SELECT * FROM sucursales", [], 2);
    expect(r.rowCount).toBe(2);
    expect(r.truncated).toBe(true);
  });

  it("runs every query inside a READ ONLY transaction", async () => {
    const r = await connector.runUserQuery(
      "SELECT current_setting('transaction_read_only') AS ro",
    );
    expect(r.rows[0]).toEqual({ ro: "on" });
  });

  it("rejects a write and leaves the table unchanged", async () => {
    const before = await connector.runUserQuery(
      "SELECT count(*)::int AS c FROM sucursales",
    );
    await expect(
      connector.runUserQuery(
        "WITH x AS (INSERT INTO sucursales (nombre, ciudad) VALUES ('hack','x') RETURNING id) SELECT * FROM x",
      ),
    ).rejects.toThrow();
    const after = await connector.runUserQuery(
      "SELECT count(*)::int AS c FROM sucursales",
    );
    expect(after.rows[0]).toEqual(before.rows[0]); // no row inserted
  });

  it("defaults to a 100-row page when no limit is given", async () => {
    const r = await connector.runUserQuery(
      "SELECT g FROM generate_series(1, 5000) AS g",
    );
    expect(r.rowCount).toBe(100);
    expect(r.truncated).toBe(true);
  });

  it("hard-caps at maxRows even when the requested limit is larger", async () => {
    // config maxRows = 1000; ask for 99999 → clamped to 1000
    const r = await connector.runUserQuery(
      "SELECT g FROM generate_series(1, 5000) AS g",
      [],
      99999,
    );
    expect(r.rowCount).toBe(1000);
    expect(r.truncated).toBe(true);
  });

  it("a trailing comment cannot strip the cap (old subquery-wrap bypass is gone)", async () => {
    // Previously: `…) AS _ioq --` closed the wrap's paren and commented out its LIMIT.
    // With a server-side cursor there is no appended LIMIT to strip — this is now just
    // invalid SQL (unbalanced paren), never an uncapped dump.
    await expect(
      connector.runUserQuery(
        "SELECT g FROM generate_series(1, 5000) AS g) AS _ioq --",
        [],
        10,
      ),
    ).rejects.toThrow();
    const legit = await connector.runUserQuery(
      "SELECT g FROM generate_series(1, 5000) AS g",
      [],
      10,
    );
    expect(legit.rowCount).toBe(10);
    expect(legit.truncated).toBe(true);
  });

  it("describe_table maps a COMPOSITE foreign key by ordinal (no cross-product)", async () => {
    const schema = await connector.describeTable("promociones");
    const byName = Object.fromEntries(schema.columns.map((c) => [c.name, c]));
    expect(byName.region?.fkReferences).toBe("public.precios_region.region");
    expect(byName.producto_id?.fkReferences).toBe(
      "public.precios_region.producto_id",
    );
  });
});
