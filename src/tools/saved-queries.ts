import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Connector } from "../connector/types.js";
import type { AuditTrail } from "../audit/trail.js";
import type { StudioStore } from "../studio/store.js";
import { validateSql, MAX_SQL_LENGTH } from "../validator/sql.js";
import { lineDiff } from "../studio/diff.js";
import { runAndRender } from "./run-and-render.js";
import { studioNameSchema as nameSchema } from "./studio-names.js";
import { ok, fail } from "./result.js";

/**
 * SQL Studio PRIMITIVES — versioned saved queries (promote → version → diff → run).
 * Persistence only; the Studio UI lives in the host. Saved SQL runs through the SAME
 * read-only connector path as execute_query, so all structural guarantees still hold.
 */
export function registerSavedQueries(
  server: McpServer,
  connector: Connector,
  audit: AuditTrail,
  store: StudioStore,
): void {
  server.registerTool(
    "save_query",
    {
      title: "Save (promote) a query",
      description:
        "Persist a read-only SELECT/WITH query under a name for reuse. Each save creates a NEW version (the latest becomes current); nothing is overwritten, so you can diff or roll back. Returns the assigned version. Use run_saved_query to execute it.",
      inputSchema: {
        name: nameSchema.describe('Logical name, e.g. "weekly_stockouts".'),
        sql: z
          .string()
          .max(MAX_SQL_LENGTH)
          .describe("A single SELECT or WITH…SELECT statement."),
        description: z
          .string()
          .optional()
          .describe("Optional human description of what the query answers."),
      },
    },
    async ({ name, sql, description }) => {
      const v = validateSql(sql);
      if (!v.valid) return fail(v.reason);
      const version = store.saveQuery(name, v.sql, description);
      return ok({ name, version });
    },
  );

  server.registerTool(
    "list_saved_queries",
    {
      title: "List saved queries",
      description:
        "List the current version of every saved query (name, version, description, created_at). Use get_saved_query for the SQL of a specific one.",
      inputSchema: {},
    },
    async () => ok({ queries: store.listSavedQueries() }),
  );

  server.registerTool(
    "get_saved_query",
    {
      title: "Get a saved query",
      description:
        "Return a saved query's SQL and metadata — the current version, or a specific `version` if given. Returns an error if the name/version does not exist.",
      inputSchema: {
        name: nameSchema,
        version: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Specific version; defaults to the current (latest)."),
      },
    },
    async ({ name, version }) => {
      const q = store.getSavedQuery(name, version);
      return q
        ? ok(q)
        : fail(
            `saved query "${name}" (version ${version ?? "current"}) not found`,
          );
    },
  );

  server.registerTool(
    "run_saved_query",
    {
      title: "Run a saved query",
      description:
        "Execute a saved query (current version, or a specific `version`) against the client's database and return rows + metadata — same read-only execution and optional `render` as execute_query. Pass `params` for its $1/? placeholders.",
      inputSchema: {
        name: nameSchema,
        version: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Specific version; defaults to the current (latest)."),
        params: z
          .array(z.unknown())
          .optional()
          .describe("Positional parameters bound to the query's placeholders."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max rows to return (default 100; capped by the server)."),
        render: z
          .array(z.enum(["table", "chart"]))
          .optional()
          .describe(
            'Optional rendered forms: "table" (markdown) and/or "chart" (ECharts spec).',
          ),
      },
    },
    async ({ name, version, params, limit, render }) => {
      const q = store.getSavedQuery(name, version);
      if (!q) {
        return fail(
          `saved query "${name}" (version ${version ?? "current"}) not found`,
        );
      }
      return runAndRender(connector, audit, {
        sql: q.sql,
        params,
        limit,
        render,
      });
    },
  );

  server.registerTool(
    "diff_saved_queries",
    {
      title: "Diff two versions of a saved query",
      description:
        "Return a deterministic line-level diff between two versions of a saved query (lines tagged add/remove/context). Use to review what changed before promoting or rolling back.",
      inputSchema: {
        name: nameSchema,
        from: z.number().int().positive().describe("The older version number."),
        to: z.number().int().positive().describe("The newer version number."),
      },
    },
    async ({ name, from, to }) => {
      const a = store.getSavedQuery(name, from);
      const b = store.getSavedQuery(name, to);
      if (!a) return fail(`saved query "${name}" version ${from} not found`);
      if (!b) return fail(`saved query "${name}" version ${to} not found`);
      return ok({ name, from, to, diff: lineDiff(a.sql, b.sql) });
    },
  );

  server.registerTool(
    "delete_saved_query",
    {
      title: "Delete a saved query",
      description:
        "Delete a saved query: a specific `version`, or (version omitted) ALL versions of the name. Returns how many rows were removed. If the current version is deleted, the highest remaining version becomes current.",
      inputSchema: {
        name: nameSchema,
        version: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Specific version to delete; omit to delete all versions."),
      },
    },
    async ({ name, version }) =>
      ok({ deleted: store.deleteSavedQuery(name, version) }),
  );
}
