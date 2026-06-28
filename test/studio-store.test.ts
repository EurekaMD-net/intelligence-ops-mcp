import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StudioStore } from "../src/studio/store.js";

let store: StudioStore;
beforeEach(() => {
  store = new StudioStore(":memory:");
});
afterEach(() => store.close());

describe("StudioStore — saved queries (versioning)", () => {
  it("saves versions incrementally; the latest is current", () => {
    expect(store.saveQuery("q", "SELECT 1")).toBe(1);
    expect(store.saveQuery("q", "SELECT 2")).toBe(2);
    const cur = store.getSavedQuery("q");
    expect(cur?.version).toBe(2);
    expect(cur?.sql).toBe("SELECT 2");
    expect(cur?.isCurrent).toBe(true);
    const v1 = store.getSavedQuery("q", 1);
    expect(v1?.sql).toBe("SELECT 1");
    expect(v1?.isCurrent).toBe(false);
  });

  it("lists only the current version of each name", () => {
    store.saveQuery("a", "SELECT 1");
    store.saveQuery("a", "SELECT 2");
    store.saveQuery("b", "SELECT 3");
    const list = store.listSavedQueries();
    expect(list.map((q) => q.name)).toEqual(["a", "b"]);
    expect(list.find((q) => q.name === "a")?.version).toBe(2);
  });

  it("returns null for a missing name or version", () => {
    expect(store.getSavedQuery("nope")).toBeNull();
    expect(store.getSavedQuery("nope", 5)).toBeNull();
  });

  it("deleting the current version promotes the highest remaining one", () => {
    store.saveQuery("q", "SELECT 1");
    store.saveQuery("q", "SELECT 2");
    store.saveQuery("q", "SELECT 3");
    expect(store.deleteSavedQuery("q", 3)).toBe(1);
    expect(store.getSavedQuery("q")?.version).toBe(2);
  });

  it("deletes all versions of a name when no version is given", () => {
    store.saveQuery("q", "SELECT 1");
    store.saveQuery("q", "SELECT 2");
    expect(store.deleteSavedQuery("q")).toBe(2);
    expect(store.getSavedQuery("q")).toBeNull();
  });
});

describe("StudioStore — monitors (upsert)", () => {
  it("saves and updates by name (no duplicate rows)", () => {
    store.saveMonitor({
      name: "m",
      sql: "SELECT 1 AS value",
      operator: ">",
      threshold: 5,
    });
    let m = store.getMonitor("m");
    expect(m?.operator).toBe(">");
    expect(m?.threshold).toBe(5);
    store.saveMonitor({
      name: "m",
      sql: "SELECT 2 AS value",
      operator: "<",
      threshold: 10,
      params: [1],
      description: "d",
    });
    m = store.getMonitor("m");
    expect(m?.threshold).toBe(10);
    expect(m?.operator).toBe("<");
    expect(m?.params).toEqual([1]);
    expect(m?.description).toBe("d");
    expect(store.listMonitors().length).toBe(1);
  });

  it("deletes a monitor", () => {
    store.saveMonitor({
      name: "m",
      sql: "SELECT 1 AS value",
      operator: ">",
      threshold: 5,
    });
    expect(store.deleteMonitor("m")).toBe(1);
    expect(store.getMonitor("m")).toBeNull();
  });
});
