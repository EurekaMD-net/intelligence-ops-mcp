import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * The SQL Agent itself runs in the EurekaMS host LLM, NOT in this server (the server
 * never does inference). This prompt is the scaffold the host fetches: it wires the
 * host LLM to use THIS server's tools as a read-only retail analyst.
 */
export function registerRetailSqlAgentPrompt(server: McpServer): void {
  server.registerPrompt(
    "retail_sql_agent",
    {
      title: "Retail SQL agent",
      description:
        "Scaffold the host LLM as a read-only retail data analyst over the client's warehouse, using this server's tools. Pass the business question; the prompt wires the discover → generate → validate → execute → iterate loop with retail few-shot examples.",
      argsSchema: {
        question: z
          .string()
          .describe("The business question, in natural language."),
      },
    },
    ({ question }) => ({
      messages: [
        {
          role: "user",
          content: { type: "text" as const, text: buildPrompt(question) },
        },
      ],
    }),
  );
}

export function buildPrompt(question: string): string {
  return `You are a retail data analyst answering a business question against the client's
own database, using ONLY the tools this MCP server exposes. The database is READ-ONLY;
you cannot and must not attempt to modify data.

Loop:
1. get_schema_context — learn the tables, columns, and foreign-key relationships. Call
   this first (it returns the whole schema in one shot). Use describe_table to zoom in.
2. Write ONE SELECT (or WITH … SELECT). Use $1, $2, … params for any literal values —
   never string-concatenate user input. Join using the foreign-key graph.
3. validate_query — confirm the SQL is valid and inspect the plan BEFORE running it.
4. execute_query — run it. If it errors, read the message, fix the SQL, and retry (back
   to step 2). If \`truncated\` is true, the result hit the row cap — refine with
   aggregation or a tighter filter rather than asking for more rows.
5. Answer in plain language, then show the exact SQL you ran so the user can audit it.

Rules: read-only SELECT/WITH only; one statement per call; prefer aggregates over dumping
rows; keep it under ~60 seconds; always surface the SQL behind the answer.

Few-shot (a demo retail schema: sucursales, productos, inventario, ventas):
- "stock de chamarra invierno por tienda" →
  SELECT s.nombre, i.stock FROM inventario i
  JOIN sucursales s ON s.id = i.sucursal_id
  JOIN productos p ON p.id = i.producto_id
  WHERE p.sku = $1 ORDER BY i.stock;   -- params: ['CH-001']
- "tienda con mayor throughput últimos 30 días" →
  SELECT s.nombre, SUM(v.cantidad) AS u FROM ventas v
  JOIN sucursales s ON s.id = v.sucursal_id
  WHERE v.vendido_en >= now() - interval '30 days'
  GROUP BY s.nombre ORDER BY u DESC LIMIT 1;

Business question:
${question}`;
}
