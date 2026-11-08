import { describe, it, expect } from "vitest";
import type { Answer, ClassifyResult } from "@/lib/schema";
import {
  PROVIDER_CHOICES,
  decisionOf,
  answersMatch,
  compareResults,
  latencyLabel,
} from "@/lib/compare";

const choice = (c: string, conf = 0.9): Answer => ({
  type: "choice",
  choice: c,
  probabilities: { [c]: conf },
  confidence: conf,
});
const score = (s: number, conf = 0.8): Answer => ({
  type: "score",
  score: s,
  probabilities: {},
  confidence: conf,
});
const noul = (p: number): Answer => ({ type: "noul", noul: p });

const result = (answers: Record<string, Answer>): ClassifyResult => ({
  answers,
  usage: { input_tokens: 10, output_tokens: 5 },
  model: "m",
  provider: "gateway",
});

describe("PROVIDER_CHOICES", () => {
  it("offers auto plus both real backends", () => {
    expect(PROVIDER_CHOICES.map((p) => p.id)).toEqual(["auto", "jev", "gateway"]);
    expect(PROVIDER_CHOICES.every((p) => p.hint.length > 0)).toBe(true);
  });
});

describe("decisionOf", () => {
  it("reduces each primitive to its effective decision", () => {
    expect(decisionOf(choice("bug"))).toBe("bug");
    expect(decisionOf(score(2.99))).toBe(3); // Jev fractional scores round to a level
    expect(decisionOf(score(2.4))).toBe(2);
    expect(decisionOf(noul(0.75))).toBe(true);
    expect(decisionOf(noul(0.49))).toBe(false);
  });
});

describe("answersMatch", () => {
  it("matches identical decisions", () => {
    expect(answersMatch(choice("billing"), choice("billing"))).toBe(true);
    expect(answersMatch(score(1.9), score(2.1))).toBe(true);
    expect(answersMatch(noul(0.9), noul(0.6))).toBe(true);
  });

  it("flags different decisions and mismatched types", () => {
    expect(answersMatch(choice("billing"), choice("bug"))).toBe(false);
    expect(answersMatch(score(1), score(4))).toBe(false);
    expect(answersMatch(noul(0.9), noul(0.1))).toBe(false);
    expect(answersMatch(choice("billing"), noul(0.9))).toBe(false);
  });
});

describe("compareResults", () => {
  it("reports per-question agree/diff", () => {
    const a = result({ tone: choice("negative"), priority: score(3.2) });
    const b = result({ tone: choice("negative"), priority: score(0.4) });
    expect(compareResults(a, b)).toEqual({ tone: "match", priority: "diff" });
  });

  it("marks n/a when either side lacks the question", () => {
    const a = result({ tone: choice("praise") });
    const b = result({ urgent: noul(0.8) });
    expect(compareResults(a, b)).toEqual({ tone: "n/a", urgent: "n/a" });
  });

  it("handles null sides (a failed provider column) gracefully", () => {
    const a = result({ tone: choice("praise") });
    expect(compareResults(a, null)).toEqual({ tone: "n/a" });
    expect(compareResults(null, null)).toEqual({});
    expect(compareResults(undefined, a)).toEqual({ tone: "n/a" });
  });
});

describe("latencyLabel", () => {
  it("shows milliseconds under a second", () => {
    expect(latencyLabel(412.6)).toBe("413 ms");
    expect(latencyLabel(0)).toBe("0 ms");
    expect(latencyLabel(999.4)).toBe("999 ms");
  });

  it("switches to seconds at 1000ms and above", () => {
    expect(latencyLabel(1000)).toBe("1.00 s");
    expect(latencyLabel(1346)).toBe("1.35 s");
  });

  it("renders an em-dash for unknown latencies", () => {
    expect(latencyLabel(null)).toBe("—");
    expect(latencyLabel(undefined)).toBe("—");
    expect(latencyLabel(NaN)).toBe("—");
  });
});
