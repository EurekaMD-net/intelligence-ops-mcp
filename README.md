# intelligence-ops-mcp

> MCP server + read-only SQL layer for retail intelligence — runs on the client's own Postgres **or MySQL** warehouse.

Part of the [EurekaMS](https://github.com/EurekaMD-net) **Intelligence Ops** pillar. A
self-hosted alternative to Wilab: the client's data never leaves their infrastructure, and the
SQL behind every answer is auditable. The LLM (the "SQL Agent") lives in the EurekaMS host and
drives this server's tools — the agent asks, this server safely reads.

## Status — Phase 4b (Cloud connectors, experimental) ✅

Five MCP tools + a SQL-agent prompt run against the client's **Postgres or MySQL** warehouse
(both VERIFIED, real-DB integration-tested), selected by `IOMCP_DIALECT`. A `Connector` interface

- factory make the dialect a swap-in; tools, prompt, and rendering are dialect-agnostic. Read-only
  is enforced structurally per dialect (see below), and `execute_query` returns a markdown table + a
  heuristic ECharts spec in one pass. 73 unit tests + two real-DB integration suites (15 Postgres,
  17 MySQL) — **105 tests**.

**Experimental (UNVERIFIED):** BigQuery + Snowflake connectors are code-complete but **not
integration-tested** (cloud-credential-only — no CI-verifiable emulator). They are **disabled
unless `IOMCP_ENABLE_UNVERIFIED_DIALECTS=true`** and must be verified per
[`docs/verify-cloud-connectors.md`](docs/verify-cloud-connectors.md) before trusting. **Still
deferred** (Docker-testable, queued): MSSQL, ClickHouse.

See [`docs/documento-fundacional.md`](docs/documento-fundacional.md) for the full architecture and
the phase roadmap; the build plan + Wilab-parity matrix live in the EurekaMS workspace
(`jarvis-kb/projects/eurekaMS/intelligence-ops-mcp/code/plan-phase1.md`).

## The 5 MCP tools

| Tool                 | Input                                  | Returns                                                                                                                                   |
| -------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `list_tables`        | `schema?` (default: configured schema) | tables + row-count estimate + comment                                                                                                     |
| `describe_table`     | `table`, `schema?`                     | columns (type/nullable/default), PKs, FK references, indexes, row estimate                                                                |
| `get_schema_context` | `schema?`                              | **whole schema** in one call — every table's columns + the FK relationship graph (LLM-ready)                                              |
| `validate_query`     | `sql`, `params?`                       | `{valid, plan}` or `{valid:false, reason}` — `EXPLAIN` (no execute) pre-check                                                             |
| `execute_query`      | `sql`, `params?`, `limit?`, `render?`  | columns + rows + `executionMs` + `truncated`; with `render:["table","chart"]` also a markdown table + a heuristic ECharts spec (one pass) |

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

The exact mechanism is per-dialect (the connection role/grant is always the authoritative layer):

- **Postgres** — read-only role (`GRANT SELECT`) **and** `BEGIN TRANSACTION READ ONLY`; the
  transaction blocks every write including `SELECT … INTO`. Server-side cursor caps rows+memory;
  extended-protocol Parse is the authoritative single-statement guard; `EXPLAIN` is plan-only.
- **MySQL 8.0.16+ / InnoDB** — the **SELECT-only grant is the load-bearing layer**, because
  `START TRANSACTION READ ONLY` blocks DML/DDL but does **not** block `SELECT … INTO OUTFILE/DUMPFILE`
  (a filesystem write). So the connection user **must have `GRANT SELECT` only and must NOT hold the
  `FILE` privilege**; the connector runs a startup self-test (`SHOW GRANTS`) and **refuses to execute
  any query** if the user holds `FILE`/`ALL`. `multipleStatements:false` is the single-statement guard;
  rows+memory are capped by streaming `n+1` then stopping; `EXPLAIN FORMAT=TREE` is time-bounded
  (MySQL EXPLAIN executes derived subqueries, so it carries the statement timeout). MariaDB is **not**
  supported (its timeout variable differs). There is no default `MYSQL_USER` — it must be set explicitly.

Create the read-only principal once on the client DB.

**Postgres:**

```sql
CREATE ROLE readonly_user LOGIN PASSWORD '…';
GRANT CONNECT ON DATABASE client_db TO readonly_user;
GRANT USAGE ON SCHEMA public TO readonly_user;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO readonly_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO readonly_user;
```

**MySQL** (SELECT-only, **no `FILE`** — `FILE` would allow `INTO OUTFILE` file writes):

```sql
CREATE USER 'iomcp_ro'@'%' IDENTIFIED BY '…';
GRANT SELECT ON client_db.* TO 'iomcp_ro'@'%';  -- SELECT only; never GRANT FILE / ALL
FLUSH PRIVILEGES;
```

## Configuration (environment variables)

`IOMCP_DIALECT` selects the warehouse: `postgres` (default) or `mysql`. Each dialect reads its own
prefix. **Backward-compat:** an existing deployment that sets only `PG_*` and no `IOMCP_DIALECT`
keeps working unchanged — same vars, same defaults, zero migration.

**Postgres** (`IOMCP_DIALECT` unset or `postgres`):

| Var                                   | Default                           | Purpose                         |
| ------------------------------------- | --------------------------------- | ------------------------------- |
| `PG_HOST` / `PG_PORT` / `PG_DATABASE` | `localhost` / `5432` / `postgres` | client warehouse                |
| `PG_USER` / `PG_PASSWORD`             | `postgres` / —                    | **must be read-only**           |
| `PG_SSL`                              | `false`                           | `true` for external connections |
| `PG_POOL_MAX`                         | `5`                               | connection pool size            |
| `PG_CONNECT_TIMEOUT_MS`               | `5000`                            | connect timeout                 |
| `PG_STATEMENT_TIMEOUT_MS`             | `30000`                           | per-query timeout               |

**MySQL** (`IOMCP_DIALECT=mysql`):

| Var                             | Default               | Purpose                                                   |
| ------------------------------- | --------------------- | --------------------------------------------------------- |
| `MYSQL_HOST` / `MYSQL_PORT`     | `localhost` / `3306`  | client warehouse                                          |
| `MYSQL_DATABASE`                | — (**required**)      | also the default schema (no `"public"` in MySQL)          |
| `MYSQL_USER` / `MYSQL_PASSWORD` | — (**required user**) | **SELECT-only, no `FILE`** (refused at startup otherwise) |
| `MYSQL_SSL`                     | `false`               | `true` for external connections                           |
| `MYSQL_POOL_MAX`                | `5`                   | connection pool size                                      |
| `MYSQL_CONNECT_TIMEOUT_MS`      | `5000`                | connect timeout                                           |
| `MYSQL_STATEMENT_TIMEOUT_MS`    | `30000`               | per-query timeout (`max_execution_time`)                  |

**Shared (both dialects):**

| Var                    | Default           | Purpose                                           |
| ---------------------- | ----------------- | ------------------------------------------------- |
| `MAX_RESULT_ROWS`      | `1000`            | hard row cap (a call's `limit` can't exceed this) |
| `AUDIT_DB_PATH`        | `./data/audit.db` | SQLite audit trail                                |
| `AUDIT_RETENTION_DAYS` | `90`              | audit rows older than this are pruned at startup  |

The SQL-agent prompt's placeholder style follows the dialect automatically: `$1, $2` for Postgres,
`?` for MySQL (and `?` for the experimental cloud dialects).

### Experimental cloud dialects (UNVERIFIED) — opt-in

`IOMCP_DIALECT=bigquery` / `snowflake` are **disabled** unless `IOMCP_ENABLE_UNVERIFIED_DIALECTS=true`.
They have **no integration test** (cloud-credential-only) — read-only is enforced by the cloud
role/IAM you grant plus a best-effort runtime self-test. **Verify per
[`docs/verify-cloud-connectors.md`](docs/verify-cloud-connectors.md) before trusting them.**

**BigQuery** (`@google-cloud/bigquery`, optional dep): `BIGQUERY_PROJECT_ID` (req), `BIGQUERY_DATASET`
(req — default schema), `BIGQUERY_KEY_FILENAME` (SA JSON; omit for ADC), `BIGQUERY_LOCATION`,
`BIGQUERY_MAX_BYTES_BILLED` (cost cap, bytes; default `1000000000`), `BIGQUERY_STATEMENT_TIMEOUT_MS`.
Precondition: a service account with `roles/bigquery.dataViewer` + `jobUser` and **no write roles**.

**Snowflake** (`snowflake-sdk`, optional dep): `SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_USERNAME`,
`SNOWFLAKE_WAREHOUSE`, `SNOWFLAKE_DATABASE`, `SNOWFLAKE_SCHEMA` (all req), `SNOWFLAKE_PASSWORD` **or**
`SNOWFLAKE_PRIVATE_KEY_PATH` (req one), `SNOWFLAKE_ROLE` (a **read-only** role), `SNOWFLAKE_CONNECT_TIMEOUT_MS`,
`SNOWFLAKE_STATEMENT_TIMEOUT_MS`. Precondition: a role with `SELECT`/`USAGE` grants only (verify across
the role hierarchy — the self-test sees only direct grants).

## Run

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # 60 unit tests (integration suites skip without TEST_PG_URL / TEST_MYSQL_URL)
npm run build         # emit dist/
npm start             # node dist/index.js  (stdio MCP server)
npm run dev           # tsx src/index.ts     (no build)
```

Diagnostics go to **stderr** — stdout is the MCP (JSON-RPC) channel.

### Integration tests (real databases)

Each suite seeds its demo schema and exercises all tools, the row+memory cap, the read-only
transaction, write rejection, single-statement blocking, and plan-only EXPLAIN.

```bash
# Postgres
docker run -d --name pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:5499:5432 postgres:16-alpine
TEST_PG_URL="postgres://postgres:postgres@127.0.0.1:5499/postgres" npx vitest run test/integration.test.ts
docker rm -f pg

# MySQL — seed runs as the admin user; the connector connects as the SELECT-only iomcp_ro it creates
docker run -d --name my -e MYSQL_ROOT_PASSWORD=testpw -e MYSQL_DATABASE=shop -p 127.0.0.1:13306:3306 mysql:8.4
TEST_MYSQL_URL="mysql://root:testpw@127.0.0.1:13306/shop" npx vitest run test/integration.mysql.test.ts
docker rm -f my
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
