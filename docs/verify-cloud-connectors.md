# Verifying the experimental cloud connectors (BigQuery, Snowflake)

The BigQuery and Snowflake connectors are **EXPERIMENTAL and UNVERIFIED**: they are
code-complete against the vendor SDKs but have **no integration test** (both are
cloud-credential-only — there is no throwaway container or CI-verifiable emulator, and
their read-only guarantee is RBAC/IAM-only). They are quarantined:

- Disabled unless `IOMCP_ENABLE_UNVERIFIED_DIALECTS=true` (refused at config load, at
  construction in the factory, **and** in the connector constructor — three fail-closed checks).
- Each refuses to run any query if its runtime read-only self-test detects a writable
  principal — but that self-test is **best-effort** (see the limitations below).

**Do not trust these connectors in production until you have completed the checklist below
against the actual warehouse.** Until then, the authoritative read-only guarantee is the
cloud **role/IAM you grant** — not the connector.

---

## BigQuery

**Read-only model:** there are no transactions. Read-only is the service account's IAM
role; the connector adds a `maximumBytesBilled` cost cap and a best-effort IAM self-test.

1. **Grant a read-only service account** — `roles/bigquery.dataViewer` (read data) +
   `roles/bigquery.jobUser` (run query jobs), and **no write roles** (`dataEditor`, `admin`).
2. **Confirm it cannot write** — as that SA, run a `SELECT` (must work) and an `INSERT`/`CREATE
TABLE`/`DELETE` against the dataset (must fail with permission denied). This is the real
   guarantee; everything else is defense-in-depth.
3. **Verify the IAM self-test auth path** — set `IOMCP_ENABLE_UNVERIFIED_DIALECTS=true` and
   the `BIGQUERY_*` env, then run a query through `execute_query`. Confirm the stderr log does
   NOT show the `could not verify BigQuery read-only IAM` warning. If it does, the self-test's
   internal `authClient.testIamPermissions` path did not resolve on your SDK build — the cost
   cap + IAM role still protect you, but the self-test is a no-op; rely on step 2.
4. **Cost cap** — set `BIGQUERY_MAX_BYTES_BILLED` (bytes; default 1 GB). Confirm a deliberately
   huge scan is rejected (`Query exceeded limit for bytes billed`), not billed.
5. **dry-run validate** — `validate_query` returns `Valid (dry run). Estimated bytes …` without
   executing. Confirm it does not run the query.
6. **Schema tools** — `BIGQUERY_DATASET` is the default schema; confirm `list_tables` /
   `get_schema_context` return the dataset's tables. (Row-count estimates are `0` and the FK
   graph is empty — BigQuery has no FKs; this is expected, not a bug.)

## Snowflake

**Read-only model:** Snowflake transactions do NOT enforce read-only. Read-only is the assumed
ROLE; the connector adds a `SHOW GRANTS` self-test, `MULTI_STATEMENT_COUNT=1`, and a statement
timeout.

1. **Assume a read-only role** — grant the role `USAGE` on the warehouse/database/schema and
   `SELECT` on the tables, and **no write privileges**. Set `SNOWFLAKE_ROLE` to it.
2. **Verify across the role hierarchy** — the self-test runs `SHOW GRANTS TO ROLE <role>`, which
   sees only privileges granted **directly** to that role. If the role inherits other roles,
   inspect each (`SHOW GRANTS TO ROLE <child>`) and confirm none grant write access. A role whose
   write access is purely inherited would pass the self-test — this step is how you close that gap.
3. **Confirm it cannot write** — as that role, run a `SELECT` (works) and an `INSERT`/`CREATE
TABLE` (must fail). This is the authoritative check.
4. **Single-statement guard** — confirm `SELECT 1; DROP TABLE x` is rejected (the connector pins
   `MULTI_STATEMENT_COUNT=1`).
5. **Timeout** — confirm a long query aborts near `SNOWFLAKE_STATEMENT_TIMEOUT_MS`.
6. **Row cap + connection reuse** — run a query larger than `MAX_RESULT_ROWS` (expect `truncated:
true`), then run a second query on the same process and confirm it succeeds. The connector
   reuses one connection and destroys the result stream early on truncation without an explicit
   `statement.cancel()`; verify that leaves the shared connection healthy for subsequent queries.

---

## Promoting a connector from experimental → verified

Once a connector passes the checklist against a real warehouse AND has a repeatable verification
(ideally an integration suite gated on a live test account), it can graduate:

1. Move its literal from `ExperimentalDialect` to `Dialect` in `src/connector/types.ts`.
2. Add its `case` to the verified switch in `createConnector` (the `never`-default then enforces it).
3. Drop the constructor opt-in guard and the `createExperimentalConnector` routing.
4. Remove the `IOMCP_ENABLE_UNVERIFIED_DIALECTS` requirement for it; update this doc + the README.

Until then: **gated, unverified, operator-verified-before-trust.**
