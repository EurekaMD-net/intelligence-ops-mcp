import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PostgresConnector } from "./connector/postgres.js";
import type { AuditTrail } from "./audit/trail.js";
import { registerListTables } from "./tools/list-tables.js";
import { registerDescribeTable } from "./tools/describe-table.js";
import { registerExecuteQuery } from "./tools/execute-query.js";
import { registerGetSchemaContext } from "./tools/get-schema-context.js";
import { registerValidateQuery } from "./tools/validate-query.js";
import { registerRetailSqlAgentPrompt } from "./prompts/retail-sql-agent.js";

/**
 * Build the MCP server: 5 tools (Phase 1 core + Phase 2 schema-discovery/validate) and
 * the retail SQL-agent prompt. The LLM inference lives in the host, not here.
 */
export function createServer(
  connector: PostgresConnector,
  audit: AuditTrail,
): McpServer {
  const server = new McpServer({
    name: "intelligence-ops-mcp",
    version: "0.2.0",
  });
  // Phase 1 — core
  registerListTables(server, connector);
  registerDescribeTable(server, connector);
  registerExecuteQuery(server, connector, audit);
  // Phase 2 — schema discovery + SQL-agent scaffolding
  registerGetSchemaContext(server, connector);
  registerValidateQuery(server, connector, audit);
  registerRetailSqlAgentPrompt(server);
  return server;
}
