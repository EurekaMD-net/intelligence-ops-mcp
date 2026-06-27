import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PostgresConnector } from "./connector/postgres.js";
import type { AuditTrail } from "./audit/trail.js";
import { registerListTables } from "./tools/list-tables.js";
import { registerDescribeTable } from "./tools/describe-table.js";
import { registerExecuteQuery } from "./tools/execute-query.js";

/** Build the MCP server with the 3 Phase-1 tools wired to a connector + audit trail. */
export function createServer(
  connector: PostgresConnector,
  audit: AuditTrail,
): McpServer {
  const server = new McpServer({
    name: "intelligence-ops-mcp",
    version: "0.1.0",
  });
  registerListTables(server, connector);
  registerDescribeTable(server, connector);
  registerExecuteQuery(server, connector, audit);
  return server;
}
