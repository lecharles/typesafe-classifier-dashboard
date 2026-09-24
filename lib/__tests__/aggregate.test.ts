import { describe, it, expect } from "vitest";
import {
  choiceCounts,
  scoreHistogram,
  noulRate,
  avgConfidence,
  sumUsage,
} from "@/lib/aggregate";
import type { BatchItemResult } from "@/lib/batch";

const results: BatchItemResult[] = [
  {
    id: "a",
    result: {
      answers: {
        cat: { type: "choice", choice: "bug", probabilities: { bug: 0.9 }, confidence: 0.9 },
        pri: { type: "score", score: 3, probabilities: { "3": 0.8 }, confidence: 0.8 },
        urg: { type: "noul", noul: 0.8 },
      },
      usage: { input_tokens: 10, output_tokens: 5 },
      model: "m",
    },
  },
  {
    id: "b",
    result: {
      answers: {
        cat: { type: "choice", choice: "bug", probabilities: { bug: 0.7 }, confidence: 0.7 },
        pri: { type: "score", score: 1, probabilities: { "1": 0.6 }, confidence: 0.6 },
        urg: { type: "noul", noul: 0.2 },
      },
      usage: { input_tokens: 20, output_tokens: 8 },
      model: "m",
    },
  },
  { id: "c", error: "boom" },
];

describe("aggregate", () => {
  it("choiceCounts tallies options", () => {
    expect(choiceCounts(results, "cat")).toEqual([{ name: "bug", value: 2 }]);
  });

  it("scoreHistogram maps scores to level labels", () => {
    const levels = ["l0", "l1", "l2", "l3", "l4"];
    const hist = scoreHistogram(results, "pri", levels);
    expect(hist[1].count).toBe(1); // score 1
    expect(hist[3].count).toBe(1); // score 3
  });

  it("noulRate counts items above threshold", () => {
    expect(noulRate(results, "urg", 0.5)).toBe(0.5); // one of two >= 0.5
  });

  it("avgConfidence averages choice+score confidences", () => {
    // (0.9 + 0.8 + 0.7 + 0.6) / 4
    expect(avgConfidence(results)).toBeCloseTo(0.75, 5);
  });

  it("sumUsage sums tokens across successes", () => {
    expect(sumUsage(results)).toEqual({ input_tokens: 30, output_tokens: 13 });
  });
});
