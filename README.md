# intelligence-ops-mcp

> MCP server + SQL agent layer for retail intelligence — runs on the client's own data warehouse.

Part of the [EurekaMS](https://github.com/EurekaMD-net) Intelligence Ops module. Replaces third-party data connectors with a self-owned, client-side stack.

---

## What it does

Exposes 3 MCP tools that enable a natural-language SQL agent over any client database:

| Tool | Description |
|------|-------------|
| `list_tables` | Lists accessible tables in the client's schema |
| `describe_table` | Returns columns, types, constraints, and relationships |
| `execute_query` | Executes read-only SQL, returns rows + metadata |

The agent uses these tools to answer retail intelligence questions in <60s from the client's own ERP/database — no data extraction, no external sync.

## Architecture

```
Natural language question
    → Schema Discovery (context injection)
    → SQL Agent (generate → validate → execute)
    → Result Renderer (narrative + ECharts)
    → Audit Trail (log every query cycle)
```

See [`docs/documento-fundacional.md`](docs/documento-fundacional.md) for full architecture, build phases, and integration map.

## Build phases

- **Phase 1** — MCP Core (Postgres connector, SQL validator, audit trail) `← next`
- **Phase 2** — Schema Discovery with semantic embeddings
- **Phase 3** — ECharts result renderer
- **Phase 4** — Multi-connector (MySQL, BigQuery, Snowflake)

## Stack

- Node.js + TypeScript (ESM)
- `@modelcontextprotocol/sdk`
- `pg` (Postgres, Phase 1)
- SQLite audit trail (local) or Supabase (cloud)

## Security model

- All database connections are **read-only** at the connection level
- SQL Validator blocks DDL and DML before execution (no INSERT/UPDATE/DELETE/DROP)
- Client data never leaves the client's infrastructure
- Audit Trail records every query for traceability

## License

MIT © EurekaMD
