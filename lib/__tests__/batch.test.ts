import { describe, it, expect, vi } from "vitest";
import { classifyBatch } from "@/lib/batch";
import type { ClassifyResult, Question } from "@/lib/schema";

const questions: Record<string, Question> = {
  urgent: { type: "noul", instructions: "urgent?" },
};

function fakeResult(): ClassifyResult {
  return { answers: { urgent: { type: "noul", noul: 0.5 } }, usage: { input_tokens: 1, output_tokens: 1 }, model: "m" };
}

describe("classifyBatch", () => {
  it("classifies every item and preserves order", async () => {
    const classifyFn = vi.fn().mockResolvedValue(fakeResult());
    const items = [
      { id: "a", state: "1" },
      { id: "b", state: "2" },
      { id: "c", state: "3" },
    ];
    const out = await classifyBatch(items, questions, { concurrency: 2, classifyFn });
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(out.every((r) => r.result)).toBe(true);
    expect(classifyFn).toHaveBeenCalledTimes(3);
  });

  it("isolates a failing item without aborting the batch", async () => {
    const classifyFn = vi
      .fn()
      .mockResolvedValueOnce(fakeResult())
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(fakeResult());
    const items = [
      { id: "a", state: "1" },
      { id: "b", state: "2" },
      { id: "c", state: "3" },
    ];
    const out = await classifyBatch(items, questions, { concurrency: 1, classifyFn });
    expect(out[0].result).toBeTruthy();
    expect(out[1].error).toBe("boom");
    expect(out[2].result).toBeTruthy();
  });

  it("respects the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    const classifyFn = vi.fn().mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return fakeResult();
    });
    const items = Array.from({ length: 10 }, (_, i) => ({ id: String(i), state: String(i) }));
    await classifyBatch(items, questions, { concurrency: 3, classifyFn });
    expect(peak).toBeLessThanOrEqual(3);
  });
});
