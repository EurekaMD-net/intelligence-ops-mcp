#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConnectorConfig, createConnector } from "./connector/factory.js";
import type { Connector } from "./connector/types.js";
import { AuditTrail } from "./audit/trail.js";
import { StudioStore } from "./studio/store.js";
import { createServer } from "./server.js";

// NOTE: stdout is the MCP (JSON-RPC) channel — ALL diagnostics go to stderr.
async function main(): Promise<void> {
  const cfg = loadConnectorConfig();
  const connector: Connector = await createConnector(cfg);
  const audit = new AuditTrail(
    process.env.AUDIT_DB_PATH ?? "./data/audit.db",
    Number(process.env.AUDIT_RETENTION_DAYS ?? 90),
  );
  const studio = new StudioStore(
    process.env.STUDIO_DB_PATH ?? "./data/studio.db",
  );

  try {
    await connector.healthCheck();
    console.error(`[iomcp] ${cfg.dialect} connection OK`);
  } catch (e) {
    console.error(
      `[iomcp] WARNING: ${cfg.dialect} health check failed:`,
      e instanceof Error ? e.message : e,
    );
  }

  const server = createServer(connector, audit, studio);
  await server.connect(new StdioServerTransport());
  console.error(
    `[iomcp] intelligence-ops-mcp v0.6 (${cfg.dialect}) on stdio — 15 tools: discovery (list_tables, describe_table, get_schema_context), query (validate_query, execute_query render:table/chart), studio (save/list/get/run/diff/delete_saved_query), automation (save/list/delete_monitor, evaluate_monitor); prompt: retail_sql_agent`,
  );

  const shutdown = async () => {
    console.error("[iomcp] shutting down");
    await connector.close().catch(() => {});
    try {
      audit.close();
    } catch {
      /* already closed */
    }
    try {
      studio.close();
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
