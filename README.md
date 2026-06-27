# intelligence-ops-mcp

> MCP server + read-only SQL layer for retail intelligence — runs on the client's own Postgres warehouse.

Part of the [EurekaMS](https://github.com/EurekaMD-net) **Intelligence Ops** pillar. A
self-hosted alternative to Wilab: the client's data never leaves their infrastructure, and the
SQL behind every answer is auditable. The LLM (the "SQL Agent") lives in the EurekaMS host and
drives this server's tools — the agent asks, this server safely reads.

## Status — Phase 1 (MCP Core, Postgres) ✅

The three MCP tools work against any Postgres database. Read-only is enforced structurally
(read-only role + read-only transaction), so writes are impossible. 20 unit tests + a 6-test
integration suite (real Postgres) pass. See [`docs/documento-fundacional.md`](docs/documento-fundacional.md)
for the full architecture and the phase roadmap; the Phase-1 build plan + Wilab-parity matrix
live in the EurekaMS workspace (`jarvis-kb/projects/eurekaMS/intelligence-ops-mcp/code/plan-phase1.md`).

## The 3 MCP tools

| Tool             | Input                        | Returns                                                                    |
| ---------------- | ---------------------------- | -------------------------------------------------------------------------- |
| `list_tables`    | `schema?` (default `public`) | tables + row-count estimate + comment                                      |
| `describe_table` | `table`, `schema?`           | columns (type/nullable/default), PKs, FK references, indexes, row estimate |
| `execute_query`  | `sql`, `params?`, `limit?`   | columns + rows + `executionMs` + `truncated`                               |

## Security model — read-only is _structural_, not a regex

The "no writes" guarantee does **not** rely on keyword blocklists (which both miss attacks and
false-positive on legitimate columns like `created_at`/`updated_at`). It is enforced in layers:

1. **Read-only connection** — point the server at a Postgres role with only `GRANT SELECT`, **and**
   every `execute_query` runs inside `BEGIN TRANSACTION READ ONLY … ROLLBACK`. The engine refuses
   any write: _"cannot execute … in a read-only transaction."_
2. **Single statement** — input with a second `;`-separated statement is rejected (no `SELECT 1; DROP …`).
3. **Subquery-wrapped, row-capped** — the query runs as `SELECT * FROM (<your sql>) LIMIT n`, which
   also blocks data-modifying CTEs and bounds result size (`statement_timeout` caps runtime).
4. **Whitelist + length cap** — must start with `SELECT`/`WITH`, ≤ 4000 chars (a cheap first filter).
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
