import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Connector } from "../connector/types.js";
import type { AuditTrail } from "../audit/trail.js";
import { MAX_SQL_LENGTH } from "../validator/sql.js";
import { runAndRender } from "./run-and-render.js";

export function registerExecuteQuery(
  server: McpServer,
  connector: Connector,
  audit: AuditTrail,
): void {
  server.registerTool(
    "execute_query",
    {
      title: "Execute a read-only SQL query",
      description:
        "Run ONE read-only SQL query (SELECT or WITH…SELECT only) against the client's database and return rows + metadata. Writes are impossible: the query runs in a read-only transaction, so INSERT/UPDATE/DELETE/DDL are rejected by the engine. Pass user-supplied values via `params` ($1, $2, …) — never string-concatenate them. `limit` caps returned rows (default 100, hard-capped by the server). Every call is recorded in the audit trail; `truncated:true` means more rows exist.",
      inputSchema: {
        sql: z
          .string()
          .max(MAX_SQL_LENGTH)
          .describe(
            "A single SELECT or WITH…SELECT statement. No INSERT/UPDATE/DELETE/DDL.",
          ),
        params: z
          .array(z.unknown())
          .optional()
          .describe(
            "Positional parameters bound to $1, $2, … placeholders in the SQL.",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max rows to return (default 100; capped by the server)."),
        render: z
          .array(z.enum(["table", "chart"]))
          .optional()
          .describe(
            'Optional rendered forms returned alongside the rows, in one pass: "table" → a markdown table; "chart" → a heuristic ECharts spec (bar for category+numeric, line for time-series) inferred from the result shape. You still write the narrative, and may refine or replace the chart.',
          ),
      },
    },
    async ({ sql, params, limit, render }) =>
      runAndRender(connector, audit, { sql, params, limit, render }),
  );
}
