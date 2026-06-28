import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Connector } from "../connector/types.js";
import { ok, fail } from "./result.js";

export function registerDescribeTable(
  server: McpServer,
  connector: Connector,
): void {
  server.registerTool(
    "describe_table",
    {
      title: "Describe a table",
      description:
        "Return a table's columns (name, type, nullability, default), primary keys, foreign-key references, indexes, and a row-count estimate. Use this to learn a table's shape before writing a query against it. Input: `table` (required) and optional `schema` (defaults to the server's configured schema).",
      inputSchema: {
        table: z.string().describe("Table name to describe."),
        schema: z
          .string()
          .optional()
          .describe(
            'Schema name. Defaults to the server\'s configured schema (Postgres: "public"; MySQL: the connection database).',
          ),
      },
    },
    async ({ table, schema }) => {
      try {
        const result = await connector.describeTable(table, schema);
        return ok(result);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );
}
