import { describe, it, expect } from "vitest";
import { buildPrompt } from "../src/prompts/retail-sql-agent.js";

describe("retail_sql_agent prompt", () => {
  it("injects the question and wires the full tool loop", () => {
    const q = "¿cuál es mi tienda con más ventas?";
    const p = buildPrompt(q);
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
    const p = buildPrompt("x").toLowerCase();
    expect(p).toContain("read-only");
    expect(p).toContain("sql");
  });
});
