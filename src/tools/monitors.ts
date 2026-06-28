import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Connector } from "../connector/types.js";
import type { AuditTrail } from "../audit/trail.js";
import type { StudioStore } from "../studio/store.js";
import { validateSql, MAX_SQL_LENGTH } from "../validator/sql.js";
import {
  MONITOR_OPERATORS,
  compareValue,
  extractMonitorValue,
} from "../studio/monitor.js";
import { studioNameSchema as nameSchema } from "./studio-names.js";
import { ok, fail } from "./result.js";

/**
 * Automation PRIMITIVES — a monitor is a saved read-only query + a numeric condition. The
 * server only PERSISTS the definition and EVALUATES it deterministically on demand
 * (`evaluate_monitor` → {triggered, value, rows}). It does NOT schedule or deliver anything:
 * the host (Jarvis) runs evaluate_monitor on its cron and decides what to do when triggered
 * (Slack / ticket / email). The monitor SQL should return a single numeric (a column named
 * `value`, else the first column of the first row).
 */
export function registerMonitors(
  server: McpServer,
  connector: Connector,
  audit: AuditTrail,
  store: StudioStore,
): void {
  server.registerTool(
    "save_monitor",
    {
      title: "Save a monitor (alert condition)",
      description:
        "Persist a monitor: a read-only SELECT that returns a single numeric value, plus a comparison (operator + threshold). Upserts by name. The host evaluates it on a schedule via evaluate_monitor — this tool does NOT schedule or send anything.",
      inputSchema: {
        name: nameSchema.describe('Logical name, e.g. "narvarte_stockout".'),
        sql: z
          .string()
          .max(MAX_SQL_LENGTH)
          .describe(
            "A single SELECT returning ONE numeric value to compare (column `value`, or the first column of the first row).",
          ),
        operator: z
          .enum(MONITOR_OPERATORS as unknown as [string, ...string[]])
          .describe("Comparison of the value against the threshold."),
        threshold: z
          .number()
          .describe("The numeric threshold to compare against."),
        params: z
          .array(z.unknown())
          .optional()
          .describe("Positional parameters bound to the SQL's placeholders."),
        description: z
          .string()
          .optional()
          .describe("Optional description of what the monitor watches."),
      },
    },
    async ({ name, sql, operator, threshold, params, description }) => {
      const v = validateSql(sql);
      if (!v.valid) return fail(v.reason);
      store.saveMonitor({
        name,
        sql: v.sql,
        operator: operator as (typeof MONITOR_OPERATORS)[number],
        threshold,
        params,
        description,
      });
      return ok({ name });
    },
  );

  server.registerTool(
    "list_monitors",
    {
      title: "List monitors",
      description:
        "List every saved monitor with its SQL, operator, threshold, and description.",
      inputSchema: {},
    },
    async () => ok({ monitors: store.listMonitors() }),
  );

  server.registerTool(
    "evaluate_monitor",
    {
      title: "Evaluate a monitor now",
      description:
        "Run a saved monitor's query read-only RIGHT NOW and compare its value to the threshold. Returns {triggered, value, operator, threshold, rows}. The host calls this on its schedule and decides delivery; this tool never notifies anyone. `triggered:false` with `value:null` means the query returned no numeric.",
      inputSchema: { name: nameSchema },
    },
    async ({ name }) => {
      const m = store.getMonitor(name);
      if (!m) return fail(`monitor "${name}" not found`);
      const v = validateSql(m.sql);
      if (!v.valid)
        return fail(`monitor "${name}" has invalid SQL: ${v.reason}`);
      const start = Date.now();
      try {
        const result = await connector.runUserQuery(v.sql, m.params, 100);
        audit.log({
          sql: v.sql,
          params: m.params,
          rowCount: result.rowCount,
          execMs: result.executionMs,
        });
        const value = extractMonitorValue(result.columns, result.rows);
        const triggered =
          value === null ? false : compareValue(value, m.operator, m.threshold);
        return ok({
          name,
          value,
          operator: m.operator,
          threshold: m.threshold,
          triggered,
          rows: result.rows,
          evaluatedAt: new Date().toISOString(),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        audit.log({
          sql: v.sql,
          params: m.params,
          execMs: Date.now() - start,
          error: msg,
        });
        return fail(msg);
      }
    },
  );

  server.registerTool(
    "delete_monitor",
    {
      title: "Delete a monitor",
      description:
        "Delete a saved monitor by name. Returns how many were removed.",
      inputSchema: { name: nameSchema },
    },
    async ({ name }) => ok({ deleted: store.deleteMonitor(name) }),
  );
}
