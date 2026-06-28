export type DiffType = "context" | "add" | "remove";

export interface DiffLine {
  type: DiffType;
  line: string;
}

/**
 * Deterministic line-level diff (LCS) between two SQL texts. `remove` = a line only in
 * `from`, `add` = a line only in `to`, `context` = unchanged. Pure and side-effect free.
 */
export function lineDiff(from: string, to: string): DiffLine[] {
  const a = from.split("\n");
  const b = to.split("\n");
  const n = a.length;
  const m = b.length;

  // LCS length table.
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  // Walk the table to emit a stable diff.
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "context", line: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ type: "remove", line: a[i]! });
      i++;
    } else {
      out.push({ type: "add", line: b[j]! });
      j++;
    }
  }
  while (i < n) out.push({ type: "remove", line: a[i++]! });
  while (j < m) out.push({ type: "add", line: b[j++]! });
  return out;
}
