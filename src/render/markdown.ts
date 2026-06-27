/** Deterministic markdown-table rendering of a query result. No LLM. */

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  // Keep the table one row per record: escape pipes, flatten line breaks (incl. lone \r).
  return s.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

export function toMarkdownTable(
  columns: string[],
  rows: Record<string, unknown>[],
): string {
  if (columns.length === 0) return "_(no columns)_";
  const header = `| ${columns.map(cell).join(" | ")} |`;
  const sep = `| ${columns.map(() => "---").join(" | ")} |`;
  if (rows.length === 0) return `${header}\n${sep}\n_(0 rows)_`;
  const body = rows
    .map((r) => `| ${columns.map((c) => cell(r[c])).join(" | ")} |`)
    .join("\n");
  return `${header}\n${sep}\n${body}`;
}
