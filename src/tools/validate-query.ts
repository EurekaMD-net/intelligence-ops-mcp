import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Connector } from "../connector/types.js";
import type { AuditTrail } from "../audit/trail.js";
import { validateSql, MAX_SQL_LENGTH } from "../validator/sql.js";
import { ok, fail } from "./result.js";

export function registerValidateQuery(
  server: McpServer,
  connector: Connector,
  audit: AuditTrail,
): void {
  server.registerTool(
    "validate_query",
    {
      title: "Validate a SQL query without running it",
      description:
        "Check a read-only SQL query (SELECT or WITH…SELECT) WITHOUT executing it: runs EXPLAIN (plan only, no ANALYZE) in a read-only transaction. Use this to confirm a generated query is valid and to inspect its plan before calling execute_query. Returns {valid:true, plan} or {valid:false, reason}. Never returns table data.",
      inputSchema: {
        sql: z
          .string()
          .max(MAX_SQL_LENGTH)
          .describe("A single SELECT or WITH…SELECT statement to validate."),
        params: z
          .array(z.unknown())
          .optional()
          .describe("Positional parameters bound to $1, $2, … in the SQL."),
      },
    },
    async ({ sql, params }) => {
      const v = validateSql(sql);
      if (!v.valid) {
        audit.log({ sql, params, error: `validate: ${v.reason}` });
        return ok({ valid: false, reason: v.reason });
      }
      try {
        const plan = await connector.explainQuery(v.sql, params ?? []);
        audit.log({ sql: v.sql, params });
        return ok({ valid: true, plan });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        audit.log({ sql: v.sql, params, error: `validate: ${msg}` });
        if (connector.isValidityError(e)) {
          return ok({ valid: false, reason: msg });
        }
        return fail(msg);
      }
    },
  );
}
