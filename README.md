# intelligence-ops-mcp

> MCP server + read-only SQL layer for retail intelligence — runs on the client's own Postgres warehouse.

Part of the [EurekaMS](https://github.com/EurekaMD-net) **Intelligence Ops** pillar. A
self-hosted alternative to Wilab: the client's data never leaves their infrastructure, and the
SQL behind every answer is auditable. The LLM (the "SQL Agent") lives in the EurekaMS host and
drives this server's tools — the agent asks, this server safely reads.

## Status — Phase 3 (Result Renderer) ✅

Five MCP tools + a SQL-agent prompt work against any Postgres database, and `execute_query` can
now return a markdown table + a heuristic ECharts spec in one pass. Read-only is enforced
structurally (read-only role + read-only transaction + extended-protocol single-statement), so
writes are impossible. 39 unit tests + a 19-test integration suite (real Postgres) pass — 58 total.
See [`docs/documento-fundacional.md`](docs/documento-fundacional.md) for the full architecture and
the phase roadmap; the build plan + Wilab-parity matrix live in the EurekaMS workspace
(`jarvis-kb/projects/eurekaMS/intelligence-ops-mcp/code/plan-phase1.md`).

## The 5 MCP tools

| Tool                 | Input                                 | Returns                                                                                                                                   |
| -------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `list_tables`        | `schema?` (default `public`)          | tables + row-count estimate + comment                                                                                                     |
| `describe_table`     | `table`, `schema?`                    | columns (type/nullable/default), PKs, FK references, indexes, row estimate                                                                |
| `get_schema_context` | `schema?`                             | **whole schema** in one call — every table's columns + the FK relationship graph (LLM-ready)                                              |
| `validate_query`     | `sql`, `params?`                      | `{valid, plan}` or `{valid:false, reason}` — `EXPLAIN` (no execute) pre-check                                                             |
| `execute_query`      | `sql`, `params?`, `limit?`, `render?` | columns + rows + `executionMs` + `truncated`; with `render:["table","chart"]` also a markdown table + a heuristic ECharts spec (one pass) |

**Result rendering is deterministic** (no LLM): category+numeric → bar, date-like category → line,
else table-only. The host writes the narrative and may refine or replace the chart. (Markdown cells
are escaped but are untrusted data — render as text/safe-markdown, never raw HTML.)

Plus the **`retail_sql_agent` prompt** (`question` arg) — scaffolds the host LLM as a read-only
retail analyst over the discover → generate → validate → execute → iterate loop, with retail
few-shot examples. The LLM inference stays in the host; this server only provides the tools + prompt.

## Security model — read-only is _structural_, not a regex

The "no writes" guarantee does **not** rely on keyword blocklists (which both miss attacks and
false-positive on legitimate columns like `created_at`/`updated_at`). It is enforced in layers:

1. **Read-only connection** — point the server at a Postgres role with only `GRANT SELECT`, **and**
   every `execute_query` runs inside `BEGIN TRANSACTION READ ONLY … ROLLBACK`. The engine refuses
   any write: _"cannot execute … in a read-only transaction."_
2. **Single statement** — input with a second `;`-separated statement is rejected (no `SELECT 1; DROP …`).
3. **Server-side cursor, row- and memory-capped** — results stream through a cursor (`read(n+1)`),
   so the row cap can't be stripped by a trailing comment and pg never buffers the whole table;
   `statement_timeout` caps runtime. All execution (`execute_query` and `validate_query`'s EXPLAIN)
   uses the extended protocol — Parse rejects multi-statement input authoritatively.
4. **Whitelist + length cap** — must start with `SELECT`/`WITH`, ≤ 4000 chars; a cheap first filter
   (the extended-protocol Parse is the authoritative single-statement guard).
5. **Audit trail** — every query (success or rejection) is logged to local SQLite (`query_log`).

Create the read-only role once on the client DB:

```sql
CREATE ROLE readonly_user LOGIN PASSWORD '…';
GRANT CONNECT ON DATABASE client_db TO readonly_user;
GRANT USAGE ON SCHEMA public TO readonly_user;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO readonly_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO readonly_user;
```

## Configuration (environment variables)

| Var                                   | Default                           | Purpose                                           |
| ------------------------------------- | --------------------------------- | ------------------------------------------------- |
| `PG_HOST` / `PG_PORT` / `PG_DATABASE` | `localhost` / `5432` / `postgres` | client warehouse                                  |
| `PG_USER` / `PG_PASSWORD`             | `postgres` / —                    | **must be read-only**                             |
| `PG_SSL`                              | `false`                           | `true` for external connections                   |
| `PG_POOL_MAX`                         | `5`                               | connection pool size                              |
| `PG_CONNECT_TIMEOUT_MS`               | `5000`                            | connect timeout                                   |
| `PG_STATEMENT_TIMEOUT_MS`             | `30000`                           | per-query timeout                                 |
| `MAX_RESULT_ROWS`                     | `1000`                            | hard row cap (a call's `limit` can't exceed this) |
| `AUDIT_DB_PATH`                       | `./data/audit.db`                 | SQLite audit trail                                |
| `AUDIT_RETENTION_DAYS`                | `90`                              | audit rows older than this are pruned at startup  |

## Run

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # 20 unit tests (integration skips without TEST_PG_URL)
npm run build         # emit dist/
npm start             # node dist/index.js  (stdio MCP server)
npm run dev           # tsx src/index.ts     (no build)
```

Diagnostics go to **stderr** — stdout is the MCP (JSON-RPC) channel.

### Integration tests (real Postgres)

```bash
docker run -d --name pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:5499:5432 postgres:16-alpine
TEST_PG_URL="postgres://postgres:postgres@127.0.0.1:5499/postgres" npx vitest run test/integration.test.ts
docker rm -f pg
```

The suite seeds `scripts/seed-demo.sql` and exercises all 3 tools, the row cap, the read-only
transaction, and write rejection.

### Use from Claude Desktop

```json
{
  "mcpServers": {
    "intelligence-ops": {
      "command": "node",
      "args": ["/path/to/intelligence-ops-mcp/dist/index.js"],
      "env": {
        "PG_HOST": "…",
        "PG_DATABASE": "…",
        "PG_USER": "readonly_user",
        "PG_PASSWORD": "…"
      }
    }
  }
}
```

## License

MIT © EurekaMD
