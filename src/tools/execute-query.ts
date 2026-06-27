import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PostgresConnector } from "../connector/postgres.js";
import type { AuditTrail } from "../audit/trail.js";
import { validateSql, MAX_SQL_LENGTH } from "../validator/sql.js";
import { toMarkdownTable } from "../render/markdown.js";
import { inferEChartsSpec } from "../render/echarts.js";
import { ok, fail } from "./result.js";

export function registerExecuteQuery(
  server: McpServer,
  connector: PostgresConnector,
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
    async ({ sql, params, limit, render }) => {
      const v = validateSql(sql);
      if (!v.valid) {
        audit.log({ sql, params, error: v.reason });
        return fail(v.reason);
      }
      const start = Date.now();
      try {
        const result = await connector.runUserQuery(v.sql, params ?? [], limit);
        audit.log({
          sql: v.sql,
          params,
          rowCount: result.rowCount,
          execMs: result.executionMs,
        });
        // Deterministic rendering (no LLM) folded in one pass when requested.
        const payload: Record<string, unknown> = { ...result };
        if (render?.includes("table")) {
          payload.markdown = toMarkdownTable(result.columns, result.rows);
        }
        if (render?.includes("chart")) {
          const c = inferEChartsSpec(result.columns, result.rows);
          payload.chart = c.spec;
          if (!c.spec) payload.chartReason = c.reason;
        }
        return ok(payload);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        audit.log({
          sql: v.sql,
          params,
          execMs: Date.now() - start,
          error: msg,
        });
        return fail(msg);
      }
    },
  );
}
