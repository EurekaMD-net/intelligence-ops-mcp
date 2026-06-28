import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Connector } from "../connector/types.js";
import { ok, fail } from "./result.js";

export function registerGetSchemaContext(
  server: McpServer,
  connector: Connector,
): void {
  server.registerTool(
    "get_schema_context",
    {
      title: "Get full schema context",
      description:
        "Return the WHOLE schema in one call — every table with its columns (type, nullability, PK, FK) PLUS the foreign-key relationship graph — as LLM-ready context for writing correct SQL (joins, filters). Prefer this over many describe_table calls when planning a query. Input: optional `schema` (defaults to the server's configured schema).",
      inputSchema: {
        schema: z
          .string()
          .optional()
          .describe(
            'Schema name. Defaults to the server\'s configured schema (Postgres: "public"; MySQL: the connection database).',
          ),
      },
    },
    async ({ schema }) => {
      try {
        return ok(await connector.getSchemaContext(schema));
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );
}
