import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Connector } from "./connector/types.js";
import type { AuditTrail } from "./audit/trail.js";
import type { StudioStore } from "./studio/store.js";
import { registerListTables } from "./tools/list-tables.js";
import { registerDescribeTable } from "./tools/describe-table.js";
import { registerExecuteQuery } from "./tools/execute-query.js";
import { registerGetSchemaContext } from "./tools/get-schema-context.js";
import { registerValidateQuery } from "./tools/validate-query.js";
import { registerSavedQueries } from "./tools/saved-queries.js";
import { registerMonitors } from "./tools/monitors.js";
import { registerRetailSqlAgentPrompt } from "./prompts/retail-sql-agent.js";

/**
 * Build the MCP server: 15 tools (Phase 1 core + Phase 2 schema-discovery/validate +
 * Phase 5 SQL-Studio/Automation primitives) and the retail SQL-agent prompt, over any
 * dialect's Connector. The LLM inference, UI, scheduling, and delivery live in the host,
 * not here — this server only does deterministic, read-only data operations.
 */
export function createServer(
  connector: Connector,
  audit: AuditTrail,
  store: StudioStore,
): McpServer {
  const server = new McpServer({
    name: "intelligence-ops-mcp",
    version: "0.6.0",
  });
  // Phase 1 — core
  registerListTables(server, connector);
  registerDescribeTable(server, connector);
  registerExecuteQuery(server, connector, audit);
  // Phase 2 — schema discovery + SQL-agent scaffolding
  registerGetSchemaContext(server, connector);
  registerValidateQuery(server, connector, audit);
  // Phase 5 — SQL Studio + Automation primitives (persist/evaluate only; host owns UI/cron/delivery)
  registerSavedQueries(server, connector, audit, store);
  registerMonitors(server, connector, audit, store);
  // The prompt's placeholder style follows the live dialect ($1,$2 vs ?).
  registerRetailSqlAgentPrompt(server, connector.capabilities.paramStyle);
  return server;
}
