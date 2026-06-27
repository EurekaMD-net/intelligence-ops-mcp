import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PostgresConnector } from "../connector/postgres.js";
import { ok, fail } from "./result.js";

export function registerListTables(
  server: McpServer,
  connector: PostgresConnector,
): void {
  server.registerTool(
    "list_tables",
    {
      title: "List tables",
      description:
        'List the base tables in the client\'s database schema, each with a row-count estimate and table comment. Call this FIRST to discover what data exists before describing or querying a table. Input: optional `schema` (defaults to "public").',
      inputSchema: {
        schema: z
          .string()
          .optional()
          .describe('Schema name. Defaults to "public".'),
      },
    },
    async ({ schema }) => {
      try {
        const tables = await connector.listTables(schema ?? "public");
        return ok({ tables });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );
}
