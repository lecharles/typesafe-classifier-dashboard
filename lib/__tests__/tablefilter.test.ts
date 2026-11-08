import { describe, it, expect } from "vitest";
import {
  urgencyBin,
  matchesEmailFilter,
  applyEmailFilter,
  toggleEmailFilter,
  FILTER_LABELS,
  type EmailFilterableRow,
  type EmailFilter,
} from "@/lib/tablefilter";

const row = (over: Partial<EmailFilterableRow> = {}): EmailFilterableRow => ({
  cat: "billing",
  priLabel: "high",
  urgBin: "60-70%",
  routing: "auto",
  ...over,
});

describe("urgencyBin", () => {
  it("buckets probabilities into the histogram's 10% bins", () => {
    expect(urgencyBin(0)).toBe("0-10%");
    expect(urgencyBin(0.09)).toBe("0-10%");
    expect(urgencyBin(0.1)).toBe("10-20%");
    expect(urgencyBin(0.64)).toBe("60-70%");
    expect(urgencyBin(0.95)).toBe("90-100%");
  });

  it("clamps edge/out-of-range values into the first and last bins", () => {
    expect(urgencyBin(1)).toBe("90-100%"); // floor(10) would be bin 10 — clamp to 9
    expect(urgencyBin(-0.2)).toBe("0-10%");
  });
});

describe("matchesEmailFilter", () => {
  it("a null filter matches every row", () => {
    expect(matchesEmailFilter(row(), null)).toBe(true);
  });

  it("matches category exactly", () => {
    const f: EmailFilter = { kind: "category", value: "billing" };
    expect(matchesEmailFilter(row(), f)).toBe(true);
    expect(matchesEmailFilter(row({ cat: "bug" }), f)).toBe(false);
  });

  it("matches the priority label", () => {
    const f: EmailFilter = { kind: "priority", value: "critical" };
    expect(matchesEmailFilter(row(), f)).toBe(false);
    expect(matchesEmailFilter(row({ priLabel: "critical" }), f)).toBe(true);
  });

  it("matches the urgency bin", () => {
    const f: EmailFilter = { kind: "urgency", value: "60-70%" };
    expect(matchesEmailFilter(row(), f)).toBe(true);
    expect(matchesEmailFilter(row({ urgBin: "10-20%" }), f)).toBe(false);
  });

  it("matches the routing bucket", () => {
    const f: EmailFilter = { kind: "routing", value: "human" };
    expect(matchesEmailFilter(row({ routing: "human" }), f)).toBe(true);
    expect(matchesEmailFilter(row(), f)).toBe(false);
  });
});

describe("applyEmailFilter", () => {
  const rows = [row(), row({ cat: "bug" }), row({ routing: "human" })];

  it("null filter returns all rows untouched", () => {
    expect(applyEmailFilter(rows, null)).toEqual(rows);
  });

  it("narrows to matching rows", () => {
    expect(applyEmailFilter(rows, { kind: "category", value: "bug" })).toHaveLength(1);
    expect(applyEmailFilter(rows, { kind: "routing", value: "human" })).toHaveLength(1);
  });

  it("a filter nothing matches yields an empty view", () => {
    expect(applyEmailFilter(rows, { kind: "category", value: "praise" })).toEqual([]);
  });
});

describe("toggleEmailFilter", () => {
  it("clicking a new element replaces the filter", () => {
    expect(toggleEmailFilter(null, { kind: "category", value: "billing" })).toEqual({
      kind: "category",
      value: "billing",
    });
    expect(
      toggleEmailFilter({ kind: "category", value: "billing" }, { kind: "urgency", value: "60-70%" }),
    ).toEqual({ kind: "urgency", value: "60-70%" });
  });

  it("re-clicking the same kind+value clears the filter", () => {
    const f: EmailFilter = { kind: "priority", value: "high" };
    expect(toggleEmailFilter(f, f)).toBeNull();
  });

  it("same kind, different value keeps it active (switches)", () => {
    expect(toggleEmailFilter({ kind: "priority", value: "high" }, { kind: "priority", value: "low" })).toEqual({
      kind: "priority",
      value: "low",
    });
  });
});

describe("FILTER_LABELS", () => {
  it("has a friendly label for every filter kind", () => {
    expect(Object.keys(FILTER_LABELS).sort()).toEqual(["category", "priority", "routing", "urgency"]);
  });
});
