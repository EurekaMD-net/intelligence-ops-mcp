/**
 * Deterministic ECharts-spec inference from a result's shape. No LLM — a sensible
 * baseline the host can use as-is or refine: category + numeric → bar; a date-like
 * category → line; anything else → no chart (table is the right rendering).
 */

export interface EChartsResult {
  /** An ECharts `option` object, or null when the data isn't chartable. */
  spec: Record<string, unknown> | null;
  /** Why no chart was produced (present only when spec is null). */
  reason?: string;
}

const DATE_WORDS = new Set([
  "fecha",
  "date",
  "datetime",
  "timestamp",
  "periodo",
  "mes",
  "semana",
  "dia",
  "día",
  "day",
  "month",
  "week",
  "year",
  "anio",
  "año",
  "time",
  "hora",
]);

/** pg returns numeric/bigint as strings — treat a column as numeric if every value coerces. */
function isNumericColumn(
  col: string,
  rows: Record<string, unknown>[],
): boolean {
  const vals = rows
    .map((r) => r[col])
    .filter((v) => v !== null && v !== undefined);
  if (vals.length === 0) return false;
  return vals.every((v) => {
    if (typeof v === "number") return Number.isFinite(v);
    return (
      typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))
    );
  });
}

function looksLikeDate(col: string, rows: Record<string, unknown>[]): boolean {
  const lc = col.toLowerCase();
  if (lc.endsWith("_at")) return true;
  // Match whole name tokens, not substrings (so "comestibles"/"holiday" don't match).
  const tokens = lc.split(/[^a-z0-9áéíóúñ]+/i).filter(Boolean);
  if (tokens.some((t) => DATE_WORDS.has(t))) return true;
  const sample = rows.find((r) => r[col] != null)?.[col];
  if (sample instanceof Date) return true;
  return (
    typeof sample === "string" &&
    /^\d{4}-\d{2}/.test(sample) &&
    !Number.isNaN(Date.parse(sample))
  );
}

/**
 * Of several numeric measures, the one worth charting is the most significant one:
 * the column with the greatest total magnitude. Sums and counts (revenue, units — the
 * headline figures) dwarf derived per-row metrics (average ticket, margin %), so this
 * surfaces the measure a reader cares about at a glance and lets the chart emphasize its
 * extremes, instead of a near-constant secondary column. Ties keep the last column
 * (measures usually follow their dimensions in a SELECT).
 */
function mostSignificantColumn(
  cols: string[],
  rows: Record<string, unknown>[],
): string | undefined {
  let best: string | undefined;
  let bestMagnitude = -1;
  for (const c of cols) {
    let magnitude = 0;
    for (const r of rows) {
      const n = Number(r[c]);
      if (Number.isFinite(n)) magnitude += Math.abs(n);
    }
    if (magnitude >= bestMagnitude) {
      bestMagnitude = magnitude;
      best = c;
    }
  }
  return best;
}

export function inferEChartsSpec(
  columns: string[],
  rows: Record<string, unknown>[],
): EChartsResult {
  if (rows.length === 0) return { spec: null, reason: "no rows to chart" };
  if (columns.length < 2) {
    return {
      spec: null,
      reason: "need a category column and a numeric column",
    };
  }

  const numericCols = columns.filter((c) => isNumericColumn(c, rows));

  // Category FIRST — a non-numeric dimension if there is one, else the leading column
  // (e.g. a year/month int that is the dimension, not the measure).
  const categoryCol =
    columns.find((c) => !numericCols.includes(c)) ?? columns[0];
  if (!categoryCol) return { spec: null, reason: "only one usable column" };

  // Value = the most *significant* measure among the numeric columns, not just the
  // last one — a query like `SELECT zona, num_ventas, ventas_totales, ticket_promedio`
  // must chart revenue (165M/63M/50M), not the near-flat average ticket (420/419/422)
  // that happens to be selected last.
  const valueCol = mostSignificantColumn(
    numericCols.filter((c) => c !== categoryCol),
    rows,
  );
  if (!valueCol) return { spec: null, reason: "no numeric column to plot" };

  const categories = rows.map((r) => String(r[categoryCol] ?? ""));
  const values = rows.map((r) => {
    const v = r[valueCol];
    return v === null || v === undefined ? null : Number(v);
  });
  const type = looksLikeDate(categoryCol, rows) ? "line" : "bar";

  return {
    spec: {
      xAxis: { type: "category", name: categoryCol, data: categories },
      yAxis: { type: "value", name: valueCol },
      series: [{ type, name: valueCol, data: values }],
      tooltip: { trigger: "axis" },
    },
  };
}
