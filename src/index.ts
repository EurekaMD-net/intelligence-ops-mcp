#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  loadConnectorConfig,
  PostgresConnector,
} from "./connector/postgres.js";
import { AuditTrail } from "./audit/trail.js";
import { createServer } from "./server.js";

// NOTE: stdout is the MCP (JSON-RPC) channel — ALL diagnostics go to stderr.
async function main(): Promise<void> {
  const connector = new PostgresConnector(loadConnectorConfig());
  const audit = new AuditTrail(
    process.env.AUDIT_DB_PATH ?? "./data/audit.db",
    Number(process.env.AUDIT_RETENTION_DAYS ?? 90),
  );

  try {
    await connector.healthCheck();
    console.error("[iomcp] Postgres connection OK");
  } catch (e) {
    console.error(
      "[iomcp] WARNING: Postgres health check failed:",
      e instanceof Error ? e.message : e,
    );
  }

  const server = createServer(connector, audit);
  await server.connect(new StdioServerTransport());
  console.error(
    "[iomcp] intelligence-ops-mcp running on stdio (list_tables, describe_table, execute_query)",
  );

  const shutdown = async () => {
    console.error("[iomcp] shutting down");
    await connector.close().catch(() => {});
    try {
      audit.close();
    } catch {
      /* already closed */
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("[iomcp] fatal:", e);
  process.exit(1);
});
