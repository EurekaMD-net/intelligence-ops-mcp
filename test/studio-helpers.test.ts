import { describe, it, expect } from "vitest";
import { lineDiff } from "../src/studio/diff.js";
import { compareValue, extractMonitorValue } from "../src/studio/monitor.js";

describe("lineDiff", () => {
  it("identical text → all context", () => {
    expect(lineDiff("a\nb", "a\nb").every((d) => d.type === "context")).toBe(
      true,
    );
  });

  it("detects an add and a remove, keeps unchanged as context", () => {
    const d = lineDiff("a\nb\nc", "a\nx\nc");
    expect(d).toContainEqual({ type: "remove", line: "b" });
    expect(d).toContainEqual({ type: "add", line: "x" });
    expect(d.filter((x) => x.type === "context").map((x) => x.line)).toEqual([
      "a",
      "c",
    ]);
  });

  it("pure addition", () => {
    expect(lineDiff("a", "a\nb")).toContainEqual({ type: "add", line: "b" });
  });
});

describe("compareValue", () => {
  it("evaluates each operator", () => {
    expect(compareValue(5, ">", 3)).toBe(true);
    expect(compareValue(3, ">", 3)).toBe(false);
    expect(compareValue(3, ">=", 3)).toBe(true);
    expect(compareValue(2, "<", 3)).toBe(true);
    expect(compareValue(3, "<=", 3)).toBe(true);
    expect(compareValue(3, "==", 3)).toBe(true);
    expect(compareValue(3, "!=", 4)).toBe(true);
  });
});

describe("extractMonitorValue", () => {
  it("prefers a `value` column", () => {
    expect(extractMonitorValue(["x", "value"], [{ x: 1, value: 7 }])).toBe(7);
  });
  it("falls back to the first column", () => {
    expect(extractMonitorValue(["c"], [{ c: 42 }])).toBe(42);
  });
  it("coerces pg/mysql string-numerics", () => {
    expect(extractMonitorValue(["value"], [{ value: "340" }])).toBe(340);
  });
  it("returns null for no rows / non-numeric / null cell", () => {
    expect(extractMonitorValue(["value"], [])).toBeNull();
    expect(extractMonitorValue(["value"], [{ value: "abc" }])).toBeNull();
    expect(extractMonitorValue(["value"], [{ value: null }])).toBeNull();
  });
});
