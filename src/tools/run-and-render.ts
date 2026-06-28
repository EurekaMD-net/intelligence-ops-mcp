import type { Connector } from "../connector/types.js";
import type { AuditTrail } from "../audit/trail.js";
import { validateSql } from "../validator/sql.js";
import { toMarkdownTable } from "../render/markdown.js";
import { inferEChartsSpec } from "../render/echarts.js";
import { ok, fail } from "./result.js";

export type RenderForm = "table" | "chart";

export interface RunArgs {
  sql: string;
  params?: unknown[];
  limit?: number;
  render?: RenderForm[];
}

/**
 * Validate → run (read-only, capped) → audit → optionally fold in deterministic renders.
 * The single execution path shared by `execute_query` and `run_saved_query`, so saved
 * queries get the exact same structural guarantees and rendering as ad-hoc ones.
 */
export async function runAndRender(
  connector: Connector,
  audit: AuditTrail,
  args: RunArgs,
) {
  const v = validateSql(args.sql);
  if (!v.valid) {
    audit.log({ sql: args.sql, params: args.params, error: v.reason });
    return fail(v.reason);
  }
  const start = Date.now();
  try {
    const result = await connector.runUserQuery(
      v.sql,
      args.params ?? [],
      args.limit,
    );
    audit.log({
      sql: v.sql,
      params: args.params,
      rowCount: result.rowCount,
      execMs: result.executionMs,
    });
    const payload: Record<string, unknown> = { ...result };
    if (args.render?.includes("table")) {
      payload.markdown = toMarkdownTable(result.columns, result.rows);
    }
    if (args.render?.includes("chart")) {
      const c = inferEChartsSpec(result.columns, result.rows);
      payload.chart = c.spec;
      if (!c.spec) payload.chartReason = c.reason;
    }
    return ok(payload);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    audit.log({
      sql: v.sql,
      params: args.params,
      execMs: Date.now() - start,
      error: msg,
    });
    return fail(msg);
  }
}
