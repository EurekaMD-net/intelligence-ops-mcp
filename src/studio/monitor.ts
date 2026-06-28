import type { MonitorOperator } from "./store.js";

export const MONITOR_OPERATORS: readonly MonitorOperator[] = [
  ">",
  ">=",
  "<",
  "<=",
  "==",
  "!=",
] as const;

/** Deterministic comparison of a numeric value against a monitor's threshold. */
export function compareValue(
  value: number,
  operator: MonitorOperator,
  threshold: number,
): boolean {
  switch (operator) {
    case ">":
      return value > threshold;
    case ">=":
      return value >= threshold;
    case "<":
      return value < threshold;
    case "<=":
      return value <= threshold;
    case "==":
      return value === threshold;
    case "!=":
      return value !== threshold;
    default: {
      const _exhaustive: never = operator;
      throw new Error(`unknown operator "${String(_exhaustive)}"`);
    }
  }
}

/**
 * Extract the single numeric a monitor compares: prefer a column literally named `value`,
 * else the first column of the first row. Returns null if there are no rows or the cell is
 * not finite-numeric (pg/mysql often return numerics as strings, so we coerce via Number).
 */
export function extractMonitorValue(
  columns: string[],
  rows: Record<string, unknown>[],
): number | null {
  if (rows.length === 0) return null;
  const first = rows[0]!;
  const key = columns.includes("value") ? "value" : columns[0];
  if (key === undefined) return null;
  const raw = first[key];
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}
