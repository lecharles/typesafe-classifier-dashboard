import { describe, it, expect } from "vitest";
import { toCSV, toJSON } from "@/lib/export";
import { saveRun, loadRun, clearStoredRun, type StoredRun } from "@/lib/persist";

describe("export.toCSV", () => {
  it("joins headers and rows with CRLF", () => {
    const csv = toCSV([
      { a: 1, b: "x" },
      { a: 2, b: "y" },
    ]);
    expect(csv).toBe("a,b\r\n1,x\r\n2,y");
  });

  it("quotes fields with commas, quotes, and newlines; doubles inner quotes", () => {
    const csv = toCSV([{ subject: 'He said "hi, there"', body: "line1\nline2", n: null }]);
    expect(csv.split("\r\n")[1]).toBe('"He said ""hi, there""","line1\nline2",');
  });

  it("empty input yields empty output", () => {
    expect(toCSV([])).toBe("");
  });
});

describe("export.toJSON", () => {
  it("pretty-prints the rows array", () => {
    expect(toJSON([{ a: 1 }])).toBe('[\n  {\n    "a": 1\n  }\n]');
  });
});

/** Minimal in-memory Storage for the persistence tests. */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  } as Storage;
}

describe("persist (D8 run persistence)", () => {
  it("round-trips a run through storage", () => {
    const s = fakeStorage();
    const savedAt = saveRun(s, "emails", [{ id: "1" }]);
    const loaded: StoredRun | null = loadRun(s, "emails");
    expect(loaded).not.toBeNull();
    expect(loaded!.results).toEqual([{ id: "1" }]);
    expect(loaded!.savedAt).toBe(savedAt);
  });

  it("returns null for missing or corrupt entries", () => {
    const s = fakeStorage();
    expect(loadRun(s, "nope")).toBeNull();
    s.setItem("jev.run.broken", "{not json");
    expect(loadRun(s, "broken")).toBeNull();
    s.setItem("jev.run.bad", JSON.stringify({ results: "not-an-array" }));
    expect(loadRun(s, "bad")).toBeNull();
  });

  it("clear removes the stored run", () => {
    const s = fakeStorage();
    saveRun(s, "youtube", []);
    clearStoredRun(s, "youtube");
    expect(loadRun(s, "youtube")).toBeNull();
  });
});
