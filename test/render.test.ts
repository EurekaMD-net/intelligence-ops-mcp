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

  it("charts the most significant measure, not the last column (revenue over avg ticket)", () => {
    const r = inferEChartsSpec(
      ["zona", "num_ventas", "ventas_totales", "ticket_promedio"],
      [
        {
          zona: "CDMX",
          num_ventas: 394503,
          ventas_totales: 165742596,
          ticket_promedio: 420.13,
        },
        {
          zona: "Puebla",
          num_ventas: 151680,
          ventas_totales: 63636714,
          ticket_promedio: 419.35,
        },
        {
          zona: "Bajío",
          num_ventas: 119905,
          ventas_totales: 50600000,
          ticket_promedio: 422,
        },
      ],
    );
    const spec = r.spec as {
      yAxis: { name: string };
      series: { name: string; data: number[] }[];
    };
    expect(spec.yAxis.name).toBe("ventas_totales"); // not ticket_promedio (last col)
    expect(spec.series[0]!.name).toBe("ventas_totales");
    expect(spec.series[0]!.data).toEqual([165742596, 63636714, 50600000]);
  });

  it("composes a label from every dimension (día × hora), not just the first", () => {
    const r = inferEChartsSpec(
      ["dia_semana", "hora", "num_ventas", "total_ventas"],
      [
        {
          dia_semana: "sábado",
          hora: 14,
          num_ventas: 900,
          total_ventas: 7558971,
        },
        {
          dia_semana: "sábado",
          hora: 20,
          num_ventas: 850,
          total_ventas: 7316928,
        },
        {
          dia_semana: "domingo",
          hora: 18,
          num_ventas: 800,
          total_ventas: 7286357,
        },
      ],
    );
    const spec = r.spec as {
      xAxis: { name: string; data: string[] };
      series: { type: string; name: string; data: number[] }[];
    };
    // hora is a dimension (temporal name), not dropped; labels stay distinct.
    expect(spec.xAxis.name).toBe("dia_semana · hora");
    expect(spec.xAxis.data).toEqual([
      "sábado · 14",
      "sábado · 20",
      "domingo · 18",
    ]);
    expect(spec.series[0]!.name).toBe("total_ventas"); // most significant measure
    expect(spec.series[0]!.type).toBe("bar"); // multi-dimension → discrete bars
  });

  it("ignores an all-null helper column (CASE sort key) — not a dimension", () => {
    const r = inferEChartsSpec(
      ["dia_semana", "total_ventas", "orden"],
      [
        { dia_semana: "lunes", total_ventas: 34891084, orden: null },
        { dia_semana: "martes", total_ventas: 35288078, orden: null },
        { dia_semana: "sábado", total_ventas: 48695901, orden: null },
      ],
    );
    const spec = r.spec as {
      xAxis: { name: string; data: string[] };
      series: { name: string }[];
    };
    // orden is all-null → dropped, so the axis stays the bare weekday (no "lunes · ").
    expect(spec.xAxis.name).toBe("dia_semana");
    expect(spec.xAxis.data).toEqual(["lunes", "martes", "sábado"]);
    expect(spec.series[0]!.name).toBe("total_ventas");
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
