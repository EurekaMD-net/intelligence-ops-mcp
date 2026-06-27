/**
 * SQL validator — the CHEAP first filter. It is NOT the safety guarantee:
 * read-only is enforced structurally by the connector (read-only Postgres role +
 * `BEGIN TRANSACTION READ ONLY`). So we deliberately do NOT scan for blocked
 * keywords by substring — that rejects legitimate reads (`created_at`,
 * `updated_at`, a column named `delete_flag`, a literal `WHERE s = 'UPDATED'`).
 *
 * This validator only: caps length, best-effort blocks multiple statements, and
 * requires the query to start with SELECT or WITH. The AUTHORITATIVE single-statement
 * guard is the connector's extended-protocol execution — pg rejects multiple commands
 * in one Parse; read-only is enforced by the read-only role + read-only transaction.
 */

export const ALLOWED_STARTS = ["SELECT", "WITH"] as const;
export const MAX_SQL_LENGTH = 4000;

export type ValidationResult =
  { valid: true; sql: string } | { valid: false; reason: string };

export function validateSql(input: string): ValidationResult {
  if (typeof input !== "string") {
    return { valid: false, reason: "sql must be a string" };
  }
  let sql = input.trim();
  if (sql.length === 0) return { valid: false, reason: "sql is empty" };
  if (sql.length > MAX_SQL_LENGTH) {
    return {
      valid: false,
      reason: `sql exceeds the ${MAX_SQL_LENGTH}-character limit`,
    };
  }

  // Strip a single trailing semicolon, then reject any remaining ';' that separates
  // statements — ignoring ';' inside string literals, dollar-quotes, and comments.
  if (sql.endsWith(";")) sql = sql.slice(0, -1).trimEnd();
  if (hasStatementSeparator(sql)) {
    return {
      valid: false,
      reason: "multiple statements are not allowed — run one query at a time",
    };
  }

  // First keyword, ignoring leading whitespace, parens, and comments.
  const head = sql.replace(/^(?:\s+|\(+|--[^\n]*\n?|\/\*[\s\S]*?\*\/)+/, "");
  const firstWord = (head.match(/^[a-zA-Z]+/)?.[0] ?? "").toUpperCase();
  if (!(ALLOWED_STARTS as readonly string[]).includes(firstWord)) {
    return {
      valid: false,
      reason: `only ${ALLOWED_STARTS.join(" / ")} queries are allowed (got "${firstWord || "?"}"); writes are blocked at the connection level`,
    };
  }

  return { valid: true, sql };
}

/**
 * True if a ';' separates top-level statements. Skips single-quoted strings (with ''
 * escapes), dollar-quoted strings ($tag$…$tag$), and line/block comments — so `'a;b'`,
 * `$$;$$` and `-- ;` are not mistaken for a separator. Best-effort: the connector's
 * extended-protocol Parse is the authoritative single-statement guard.
 */
function hasStatementSeparator(sql: string): boolean {
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const ch = sql[i];
    if (ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i + 2);
      if (nl === -1) return false; // rest of input is a line comment
      i = nl + 1;
    } else if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
    } else if (ch === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2; // escaped '' inside the literal
            continue;
          }
          i++;
          break;
        }
        i++;
      }
    } else if (ch === "$") {
      const tag = sql.slice(i).match(/^\$(?:[A-Za-z_]\w*)?\$/)?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? n : end + tag.length;
      } else {
        i++; // a lone '$' or a positional param like $1
      }
    } else if (ch === ";") {
      return true;
    } else {
      i++;
    }
  }
  return false;
}
