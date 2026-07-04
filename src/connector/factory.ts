import type {
  AnyConnectorConfig,
  BigQueryConfig,
  Connector,
  ConnectorConfig,
  Dialect,
  SnowflakeConfig,
} from "./types.js";
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

/** Experimental (cloud) dialects are unreachable unless this opt-in flag is set. */
export function unverifiedDialectsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.IOMCP_ENABLE_UNVERIFIED_DIALECTS === "true";
}

function need(env: NodeJS.ProcessEnv, key: string): string {
  const v = (env[key] ?? "").trim();
  if (!v) throw new Error(`${key} is required for this dialect`);
  return v;
}

/**
 * Build the connector config from the environment. `IOMCP_DIALECT` selects the
 * dialect (default "postgres"); each dialect reads its own env prefix.
 *
 * VERIFIED dialects (postgres, mysql) load unconditionally. EXPERIMENTAL dialects
 * (bigquery, snowflake) are UNVERIFIED (no CI/integration test) and load ONLY when
 * `IOMCP_ENABLE_UNVERIFIED_DIALECTS=true` — otherwise this throws. (First refusal layer.)
 *
 * BACKWARD-COMPAT INVARIANT: a deployment that sets only PG_* and no IOMCP_DIALECT
 * gets identical connection config to v0.3.0 — same env names, same defaults/flooring,
 * plus the new `dialect:"postgres"` tag — so zero env migration. (Locked by a unit test.)
 */
export function loadConnectorConfig(
  env: NodeJS.ProcessEnv = process.env,
): AnyConnectorConfig {
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
      sslInsecure: env.PG_SSL_INSECURE === "true",
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
      sslInsecure: env.MYSQL_SSL_INSECURE === "true",
      ...commonNumbers(env, "MYSQL"),
    };
  }

  // --- EXPERIMENTAL (cloud, UNVERIFIED) — gated behind the opt-in flag ---
  if (dialect === "bigquery" || dialect === "snowflake") {
    if (!unverifiedDialectsEnabled(env)) {
      throw new Error(
        `"${dialect}" is an UNVERIFIED experimental dialect (no integration test). ` +
          "Set IOMCP_ENABLE_UNVERIFIED_DIALECTS=true to enable it, and follow " +
          "docs/verify-cloud-connectors.md before trusting it.",
      );
    }
    const sharedTimeout = Math.max(
      1000,
      num(
        env[
          `${dialect === "bigquery" ? "BIGQUERY" : "SNOWFLAKE"}_STATEMENT_TIMEOUT_MS`
        ],
        30000,
      ),
    );
    const maxRows = Math.max(1, Math.floor(num(env.MAX_RESULT_ROWS, 1000)));

    if (dialect === "bigquery") {
      const cfg: BigQueryConfig = {
        dialect: "bigquery",
        projectId: need(env, "BIGQUERY_PROJECT_ID"),
        defaultDataset: need(env, "BIGQUERY_DATASET"),
        keyFilename: env.BIGQUERY_KEY_FILENAME?.trim() || undefined,
        location: env.BIGQUERY_LOCATION?.trim() || undefined,
        // Cost ceiling: a query scanning more bytes than this is rejected by BigQuery.
        maxBytesBilled: (env.BIGQUERY_MAX_BYTES_BILLED ?? "1000000000").trim(),
        statementTimeoutMs: sharedTimeout,
        maxRows,
      };
      return cfg;
    }

    // snowflake
    const password = env.SNOWFLAKE_PASSWORD?.trim() || undefined;
    const privateKeyPath = env.SNOWFLAKE_PRIVATE_KEY_PATH?.trim() || undefined;
    if (!password && !privateKeyPath) {
      throw new Error(
        "snowflake requires SNOWFLAKE_PASSWORD or SNOWFLAKE_PRIVATE_KEY_PATH",
      );
    }
    const cfg: SnowflakeConfig = {
      dialect: "snowflake",
      account: need(env, "SNOWFLAKE_ACCOUNT"),
      username: need(env, "SNOWFLAKE_USERNAME"),
      password,
      privateKeyPath,
      warehouse: need(env, "SNOWFLAKE_WAREHOUSE"),
      database: need(env, "SNOWFLAKE_DATABASE"),
      schema: need(env, "SNOWFLAKE_SCHEMA"),
      role: env.SNOWFLAKE_ROLE?.trim() || undefined,
      connectTimeoutMs: Math.max(
        1,
        num(env.SNOWFLAKE_CONNECT_TIMEOUT_MS, 5000),
      ),
      statementTimeoutMs: sharedTimeout,
      maxRows,
    };
    return cfg;
  }

  // Refuse to build a config we cannot serve — the first layer of the structural gate.
  throw new Error(
    `unsupported IOMCP_DIALECT "${dialect}" — supported: postgres, mysql ` +
      "(experimental: bigquery, snowflake — require IOMCP_ENABLE_UNVERIFIED_DIALECTS=true)",
  );
}

/**
 * Construct the connector for a config. VERIFIED dialects (postgres, mysql) are built by
 * a direct closed-union switch — the structural-safety resolver: adding a `Dialect` literal
 * without a built case is a COMPILE error, and a forged string throws at runtime.
 *
 * EXPERIMENTAL dialects (bigquery, snowflake) are routed to a separate, async, dynamically
 * imported path that (1) re-checks the opt-in flag (second refusal layer, even against a
 * forged config) and (2) logs a loud UNVERIFIED warning to stderr. Their vendor SDKs are
 * optionalDependencies loaded on demand, so a Postgres/MySQL deployment never needs them.
 */
export async function createConnector(
  cfg: AnyConnectorConfig,
): Promise<Connector> {
  switch (cfg.dialect) {
    case "postgres":
      return new PostgresConnector(cfg);
    case "mysql":
      return new MysqlConnector(cfg);
    case "bigquery":
    case "snowflake":
      return createExperimentalConnector(cfg);
    default: {
      const _exhaustive: never = cfg;
      throw new Error(
        `unsupported dialect "${String((_exhaustive as { dialect?: string }).dialect)}"`,
      );
    }
  }
}

async function createExperimentalConnector(
  cfg: BigQueryConfig | SnowflakeConfig,
): Promise<Connector> {
  if (!unverifiedDialectsEnabled()) {
    throw new Error(
      `"${cfg.dialect}" is an UNVERIFIED experimental connector and is disabled. ` +
        "Set IOMCP_ENABLE_UNVERIFIED_DIALECTS=true to enable it.",
    );
  }
  // stdout is the MCP JSON-RPC channel — this warning MUST go to stderr.
  console.error(
    `[iomcp] WARNING: "${cfg.dialect}" is an EXPERIMENTAL, UNVERIFIED connector ` +
      "(no integration test). Read-only is enforced by the cloud role/IAM + a runtime " +
      "self-test only. Verify per docs/verify-cloud-connectors.md before trusting it.",
  );
  if (cfg.dialect === "bigquery") {
    const { BigQueryConnector } = await import("./bigquery.js");
    return new BigQueryConnector(cfg);
  }
  const { SnowflakeConnector } = await import("./snowflake.js");
  return new SnowflakeConnector(cfg);
}

export type { Dialect };
