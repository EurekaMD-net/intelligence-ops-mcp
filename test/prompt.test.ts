import { describe, it, expect } from "vitest";
import { buildPrompt } from "../src/prompts/retail-sql-agent.js";

describe("retail_sql_agent prompt", () => {
  it("injects the question and wires the full tool loop", () => {
    const q = "¿cuál es mi tienda con más ventas?";
    const p = buildPrompt(q, "$n");
    expect(p).toContain(q);
    for (const tool of [
      "get_schema_context",
      "describe_table",
      "validate_query",
      "execute_query",
    ]) {
      expect(p).toContain(tool);
    }
  });

  it("states the read-only constraint and the show-your-SQL rule", () => {
    const p = buildPrompt("x", "$n").toLowerCase();
    expect(p).toContain("read-only");
    expect(p).toContain("sql");
  });

  it("emits Postgres placeholders ($1, $2 + interval) for paramStyle $n", () => {
    const p = buildPrompt("x", "$n");
    expect(p).toContain("$1");
    expect(p).toContain("$1, $2");
    expect(p).toContain("interval '30 days'");
    expect(p).not.toContain("INTERVAL 30 DAY");
  });

  it("emits MySQL placeholders (?) and no $1 for paramStyle ?", () => {
    const p = buildPrompt("x", "?");
    expect(p).toContain("WHERE p.sku = ?");
    expect(p).not.toContain("$1");
    expect(p).toContain("INTERVAL 30 DAY");
  });
});
