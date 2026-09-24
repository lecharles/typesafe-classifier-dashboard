import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the gateway module before importing classify.
vi.mock("@/lib/gateway", () => ({
  chat: vi.fn(),
}));

import { classify, extractJson } from "@/lib/classify";
import { chat } from "@/lib/gateway";
import type { ClassifyRequest } from "@/lib/schema";

const req: ClassifyRequest = {
  state: "I am furious, this is the third time it broke!",
  questions: {
    category: {
      type: "choice",
      instructions: "Pick the category",
      criteria: { complaint: "an angry complaint", praise: "positive feedback" },
    },
    urgent: { type: "noul", instructions: "Is it urgent?" },
  },
};

const validJson = JSON.stringify({
  category: { type: "choice", choice: "complaint", probabilities: { complaint: 0.95, praise: 0.05 }, confidence: 0.95 },
  urgent: { type: "noul", noul: 0.8 },
});

describe("extractJson", () => {
  it("strips code fences and surrounding prose", () => {
    const out = extractJson('Here you go:\n```json\n{"a":1}\n```') as { a: number };
    expect(out.a).toBe(1);
  });
});

describe("classify", () => {
  beforeEach(() => vi.mocked(chat).mockReset());

  it("returns typed answers and sums usage", async () => {
    vi.mocked(chat).mockResolvedValue({
      text: validJson,
      model: "anthropic/claude-3-haiku",
      usage: { input_tokens: 50, output_tokens: 20 },
    });

    const res = await classify(req);
    expect(res.answers.category.type).toBe("choice");
    if (res.answers.category.type === "choice") expect(res.answers.category.choice).toBe("complaint");
    expect(res.answers.urgent.type).toBe("noul");
    expect(res.usage).toEqual({ input_tokens: 50, output_tokens: 20 });
  });

  it("repairs on a first invalid response then succeeds", async () => {
    vi.mocked(chat)
      .mockResolvedValueOnce({ text: "not json at all", model: "m", usage: { input_tokens: 10, output_tokens: 2 } })
      .mockResolvedValueOnce({ text: validJson, model: "m", usage: { input_tokens: 40, output_tokens: 18 } });

    const res = await classify(req);
    expect(res.answers.urgent.type).toBe("noul");
    // usage accumulates across both attempts
    expect(res.usage).toEqual({ input_tokens: 50, output_tokens: 20 });
    expect(vi.mocked(chat)).toHaveBeenCalledTimes(2);
  });
});
