import { describe, it, expect, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { AuditTrail } from "../src/audit/trail.js";
import { StudioStore } from "../src/studio/store.js";
import type { Connector } from "../src/connector/types.js";

// listTools never touches the connector; createServer only reads capabilities.paramStyle.
const connector = {
  capabilities: { paramStyle: "$n" },
} as unknown as Connector;

const READS = [
  "list_tables",
  "describe_table",
  "get_schema_context",
  "validate_query",
  "execute_query",
  "list_saved_queries",
  "get_saved_query",
  "run_saved_query",
  "diff_saved_queries",
  "list_monitors",
  "evaluate_monitor",
].sort();
const OVERWRITES = ["save_query", "save_monitor"].sort();
const DELETES = ["delete_saved_query", "delete_monitor"].sort();

const audit = new AuditTrail(":memory:");
const store = new StudioStore(":memory:");
const client = new Client({ name: "annotations-test", version: "0.0.0" });

afterAll(async () => {
  await client.close();
  audit.close();
  store.close();
});

async function listTools() {
  const server = createServer(connector, audit, store);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  await client.connect(clientT);
  return (await client.listTools()).tools;
}

describe("MCP tool annotations", () => {
  it("every tool ships annotations, and reads / writes are exactly the expected sets", async () => {
    const tools = await listTools();
    expect(tools).toHaveLength(15);
    for (const t of tools) {
      expect(t.annotations, `${t.name} has no annotations`).toBeDefined();
    }
    type Annotations = NonNullable<(typeof tools)[number]["annotations"]>;
    const names = (pred: (a: Annotations) => boolean) =>
      tools
        .filter((t) => pred(t.annotations!))
        .map((t) => t.name)
        .sort();

    expect(names((a) => a.readOnlyHint === true)).toEqual(READS);
    expect(names((a) => a.readOnlyHint === false)).toEqual(
      [...OVERWRITES, ...DELETES].sort(),
    );

    const byName = new Map(tools.map((t) => [t.name, t.annotations]));
    for (const n of READS) {
      expect(byName.get(n), n).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
    for (const n of OVERWRITES) {
      expect(byName.get(n), n).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      });
    }
    for (const n of DELETES) {
      expect(byName.get(n), n).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
  });
});
