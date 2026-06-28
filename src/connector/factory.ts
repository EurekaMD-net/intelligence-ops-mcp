import type { Connector, ConnectorConfig, Dialect } from "./types.js";
import { PostgresConnector } from "./postgres.js";
import { MysqlConnector } from "./mysql.js";

function num(v: string | undefined, d: number): number {
  // An empty/whitespace env var must fall back to the default, NOT coerce to 0
  // (Number("") === 0 would silently disable statement_timeout / break the pool).
  if (v === undefined || v.trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** Common numeric fields, floored so an empty/zero env can never disable a guard. */
function commonNumbers(
  env: NodeJS.ProcessEnv,
  prefix: "PG" | "MYSQL",
): Pick<
  ConnectorConfig,
  "poolMax" | "connectTimeoutMs" | "statementTimeoutMs" | "maxRows"
> {
  return {
    poolMax: Math.max(1, Math.floor(num(env[`${prefix}_POOL_MAX`], 5))),
    connectTimeoutMs: Math.max(
      1,
      num(env[`${prefix}_CONNECT_TIMEOUT_MS`], 5000),
    ),
    // Floored at 1s so an empty/zero env can never DISABLE the per-query timeout.
    statementTimeoutMs: Math.max(
      1000,
      num(env[`${prefix}_STATEMENT_TIMEOUT_MS`], 30000),
    ),
    // Dialect-neutral hard row ceiling, shared by all connectors.
    maxRows: Math.max(1, Math.floor(num(env.MAX_RESULT_ROWS, 1000))),
  };
}

/**
 * Build the connector config from the environment. `IOMCP_DIALECT` selects the
 * dialect (default "postgres"); each dialect reads its own env prefix.
 *
 * BACKWARD-COMPAT INVARIANT: a deployment that sets only PG_* and no IOMCP_DIALECT
 * gets identical connection config to v0.3.0 — same env names, same defaults/flooring,
 * plus the new `dialect:"postgres"` tag — so zero env migration. (Locked by a unit test.)
 */
export function loadConnectorConfig(
  env: NodeJS.ProcessEnv = process.env,
): ConnectorConfig {
  const dialect = (env.IOMCP_DIALECT ?? "postgres").trim() || "postgres";

  if (dialect === "postgres") {
    return {
      dialect: "postgres",
      host: env.PG_HOST ?? "localhost",
      port: num(env.PG_PORT, 5432),
      database: env.PG_DATABASE ?? "postgres",
      user: env.PG_USER ?? "postgres",
      password: env.PG_PASSWORD ?? "",
      ssl: env.PG_SSL === "true",
      ...commonNumbers(env, "PG"),
    };
  }

  if (dialect === "mysql") {
    // No default user: this server is read-only, so the connection user must be an
    // explicit SELECT-only account WITHOUT the FILE privilege (defaulting to "root"
    // would silently open SELECT … INTO OUTFILE). MYSQL_DATABASE is required because it
    // is also the default schema — an empty one makes every schema tool return nothing.
    const user = env.MYSQL_USER ?? "";
    const database = env.MYSQL_DATABASE ?? "";
    if (!user) {
      throw new Error(
        "MYSQL_USER is required for the mysql dialect — use a SELECT-only user with no FILE privilege",
      );
    }
    if (!database) {
      throw new Error(
        "MYSQL_DATABASE is required for the mysql dialect (it is also the default schema)",
      );
    }
    return {
      dialect: "mysql",
      host: env.MYSQL_HOST ?? "localhost",
      port: num(env.MYSQL_PORT, 3306),
      database,
      user,
      password: env.MYSQL_PASSWORD ?? "",
      ssl: env.MYSQL_SSL === "true",
      ...commonNumbers(env, "MYSQL"),
    };
  }

  // Refuse to build a config we cannot serve — the first layer of the structural gate.
  throw new Error(
    `unsupported IOMCP_DIALECT "${dialect}" — supported dialects: postgres, mysql`,
  );
}

/**
 * Construct the connector for a config. This switch IS the structural-safety
 * resolver for connector selection (two reinforcing refusals):
 *   1. `cfg.dialect` is the closed `Dialect` union of BUILT+TESTED dialects, so the
 *      `default` arm is typed `never` — adding a Dialect literal without a built
 *      case is a COMPILE error (no silent fallthrough to an unproven connector).
 *   2. The runtime `default` throw catches any forged string that slips past config
 *      parsing. There is no registered class for a deferred dialect, so no env string
 *      can instantiate one.
 */
export function createConnector(cfg: ConnectorConfig): Connector {
  switch (cfg.dialect) {
    case "postgres":
      return new PostgresConnector(cfg);
    case "mysql":
      return new MysqlConnector(cfg);
    default: {
      const _exhaustive: never = cfg.dialect;
      throw new Error(
        `unsupported dialect "${String(_exhaustive)}" — built+tested dialects: postgres, mysql`,
      );
    }
  }
}

export type { Dialect };
