import type { Readable } from "node:stream";

/**
 * Collect up to `n` rows off a Readable, stopping (and destroying the stream) early once
 * `n` are buffered. This is the row+memory cap for streaming connectors: it bounds client
 * memory regardless of the SQL text (a trailing comment cannot strip an absent LIMIT).
 * The `settled` guard absorbs an error-after-resolve and the double end/close emit.
 */
export function collectCapped(
  stream: Readable,
  n: number,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const rows: Record<string, unknown>[] = [];
    let settled = false;
    const done = (err?: unknown) => {
      if (settled) return;
      settled = true;
      if (err) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve(rows);
    };
    stream.on("error", done);
    stream.on("data", (row: Record<string, unknown>) => {
      rows.push(row);
      if (rows.length >= n) {
        stream.destroy();
        done();
      }
    });
    stream.on("end", () => done());
    stream.on("close", () => done());
  });
}
