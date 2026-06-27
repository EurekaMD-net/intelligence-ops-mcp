import { describe, it, expect } from "vitest";
import { toMarkdownTable } from "../src/render/markdown.js";
import { inferEChartsSpec } from "../src/render/echarts.js";

describe("toMarkdownTable", () => {
  it("renders header, separator, and rows", () => {
    const md = toMarkdownTable(
      ["nombre", "stock"],
      [
        { nombre: "Narvarte", stock: 3 },
        { nombre: "Roma", stock: 55 },
      ],
    );
    expect(md).toBe(
      "| nombre | stock |\n| --- | --- |\n| Narvarte | 3 |\n| Roma | 55 |",
    );
  });

  it("escapes pipes, flattens newlines, blanks nulls", () => {
    const md = toMarkdownTable(["a"], [{ a: "x|y\nz" }, { a: null }]);
    expect(md).toContain("x\\|y z");
    expect(md.split("\n").pop()).toBe("|  |");
  });

  it("handles 0 rows and 0 columns", () => {
    expect(toMarkdownTable(["a"], [])).toContain("_(0 rows)_");
    expect(toMarkdownTable([], [])).toBe("_(no columns)_");
  });
});

describe("inferEChartsSpec", () => {
  it("category + numeric → bar chart", () => {
    const r = inferEChartsSpec(
      ["nombre", "u"],
      [
        { nombre: "A", u: 10 },
        { nombre: "B", u: 5 },
      ],
    );
    expect(r.spec).toMatchObject({ series: [{ type: "bar", data: [10, 5] }] });
    expect((r.spec as { xAxis: { data: string[] } }).xAxis.data).toEqual([
      "A",
      "B",
    ]);
  });

  it("treats pg string-numerics as numeric", () => {
    const r = inferEChartsSpec(
      ["nombre", "total"],
      [{ nombre: "A", total: "340" }],
    );
    expect(r.spec).not.toBeNull();
    expect(
      (r.spec as { series: { data: number[] }[] }).series[0]!.data,
    ).toEqual([340]);
  });

  it("date-like category → line chart", () => {
    const r = inferEChartsSpec(
      ["fecha", "ventas"],
      [{ fecha: "2026-06-01", ventas: 5 }],
    );
    expect((r.spec as { series: { type: string }[] }).series[0]!.type).toBe(
      "line",
    );
  });

  it("no numeric column → null with a reason", () => {
    const r = inferEChartsSpec(["a", "b"], [{ a: "x", b: "y" }]);
    expect(r.spec).toBeNull();
    expect(r.reason).toMatch(/numeric/);
  });

  it("single column or zero rows → null", () => {
    expect(inferEChartsSpec(["a"], [{ a: 1 }]).spec).toBeNull();
    expect(inferEChartsSpec(["a", "b"], []).spec).toBeNull();
  });

  it("does NOT swap axes when the leading column is numeric (year, total)", () => {
    const r = inferEChartsSpec(
      ["year", "total"],
      [
        { year: 2024, total: 100 },
        { year: 2025, total: 200 },
      ],
    );
    const spec = r.spec as {
      xAxis: { data: string[] };
      series: { type: string; data: unknown[] }[];
    };
    expect(spec.xAxis.data).toEqual(["2024", "2025"]); // year = category
    expect(spec.series[0]!.data).toEqual([100, 200]); // total = value (not swapped)
    expect(spec.series[0]!.type).toBe("line"); // "year" is date-like
  });

  it("maps null values to null (a gap), not 0, in the chart series", () => {
    const r = inferEChartsSpec(
      ["nombre", "total"],
      [
        { nombre: "A", total: 100 },
        { nombre: "B", total: null },
        { nombre: "C", total: 200 },
      ],
    );
    expect(
      (r.spec as { series: { data: unknown[] }[] }).series[0]!.data,
    ).toEqual([100, null, 200]);
  });

  it("does not match date words as substrings (comestibles ≠ mes)", () => {
    const r = inferEChartsSpec(
      ["comestibles", "u"],
      [{ comestibles: "x", u: 1 }],
    );
    expect((r.spec as { series: { type: string }[] }).series[0]!.type).toBe(
      "bar",
    );
  });
});

describe("toMarkdownTable — header escaping", () => {
  it("escapes pipes in column names too", () => {
    const md = toMarkdownTable(["a|b", "c"], [{ "a|b": 1, c: 2 }]);
    expect(md.split("\n")[0]).toBe("| a\\|b | c |");
  });
});
