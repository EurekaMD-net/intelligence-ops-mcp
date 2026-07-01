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

  // Ignore all-null / empty columns (e.g. a CASE sort-helper that never matched because
  // of a value-case mismatch): they carry no information and would otherwise pollute the
  // axis label ("sábado · ") or the measure choice.
  const hasValues = (col: string) =>
    rows.some((r) => r[col] !== null && r[col] !== undefined && r[col] !== "");
  const usable = columns.filter(hasValues);
  if (usable.length < 2) {
    return {
      spec: null,
      reason: "need a category column and a numeric column",
    };
  }

  // Split columns into dimensions (grouping keys) and measures (what we plot). A
  // dimension is any non-numeric column, or a numeric one whose name is temporal/ordinal
  // (hora, año, mes, dia_semana…) — those are grouping keys, not measures.
  let dimensions = usable.filter(
    (c) => !isNumericColumn(c, rows) || looksLikeDate(c, rows),
  );
  // No obvious dimension (every column is a plain measure) → let the first column label
  // the axis, as before.
  if (dimensions.length === 0) dimensions = [usable[0]!];
  const measures = usable.filter((c) => !dimensions.includes(c));

  // Value = the most *significant* measure, not just the last numeric column — a query
  // like `SELECT zona, num_ventas, ventas_totales, ticket_promedio` must chart revenue
  // (165M/63M/50M), not the near-flat average ticket (420/419/422) selected last.
  const valueCol = mostSignificantColumn(measures, rows);
  if (!valueCol) return { spec: null, reason: "no numeric column to plot" };

  // When a result is grouped by more than one dimension (día × hora), a single-axis chart
  // would drop a dimension and leave duplicate, ambiguous labels ("sábado" ×N). Keep every
  // dimension by composing the axis label ("sábado · 14") so each point is distinct.
  const categoryName = dimensions.join(" · ");
  const categories = rows.map((r) =>
    dimensions.map((d) => String(r[d] ?? "")).join(" · "),
  );
  const values = rows.map((r) => {
    const v = r[valueCol];
    return v === null || v === undefined ? null : Number(v);
  });
  // One date dimension is a time series (line); a single categorical dimension or a
  // multi-dimension composite is discrete (bar).
  const type =
    dimensions.length === 1 && looksLikeDate(dimensions[0]!, rows)
      ? "line"
      : "bar";

  return {
    spec: {
      xAxis: { type: "category", name: categoryName, data: categories },
      yAxis: { type: "value", name: valueCol },
      series: [{ type, name: valueCol, data: values }],
      tooltip: { trigger: "axis" },
    },
  };
}
