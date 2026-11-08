import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the gateway module: the emulated chat is stubbed per test.
vi.mock("@/lib/gateway", () => ({
  chat: vi.fn(),
}));

import { classify } from "@/lib/classify";
import { classifyBatch } from "@/lib/batch";
import { chat } from "@/lib/gateway";
import type { ClassifyRequest, Question } from "@/lib/schema";

const questions: Record<string, Question> = {
  category: {
    type: "choice",
    instructions: "Pick the category",
    criteria: { complaint: "an angry complaint", praise: "positive feedback" },
  },
  urgent: { type: "noul", instructions: "Is it urgent?" },
};

const req: ClassifyRequest = { state: "I am furious, this broke again!", questions };

const validJson = JSON.stringify({
  category: { type: "choice", choice: "complaint", probabilities: { complaint: 0.95, praise: 0.05 }, confidence: 0.95 },
  urgent: { type: "noul", noul: 0.8 },
});

function okJev(ans: Record<string, unknown>, model = "jev-latest") {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => null },
    json: async () => ({ model, answers: ans, usage: { input_tokens: 120, output_tokens: 12 } }),
  };
}

function errJev(status: number, opts: { retryAfter?: string; body?: unknown } = {}) {
  return {
    ok: false,
    status,
    statusText: "ERR",
    headers: { get: (h: string) => (h.toLowerCase() === "retry-after" ? opts.retryAfter ?? null : null) },
    json: async () => opts.body ?? { detail: `boom ${status}` },
  };
}

const jevAnswers = {
  category: { type: "choice", choice: "complaint", probabilities: { complaint: 0.9, praise: 0.1 }, confidence: 0.9 },
  urgent: { type: "noul", noul: 0.9 },
};

describe("dev trace (D7)", () => {
  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = "***";
    vi.mocked(chat).mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("jev: attaches raw request/response and a clean attempt log", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJev(jevAnswers));
    vi.stubGlobal("fetch", fetchMock);

    const res = await classify(req, { provider: "jev", trace: true });
    const t = res.trace!;
    expect(t.provider_used).toBe("jev");
    expect(t.endpoint).toContain("/v1/systemone");
    expect((t.request as { state: string }).state).toBe(req.state);
    expect((t.response as { answers: unknown }).answers).toBeTruthy();
    expect(t.attempts).toEqual([{ status: 200 }]);
    expect(t.retries).toBe(0);
    expect(t.fallback_from).toBeUndefined();
  });

  it("jev: logs a 429 retry with Retry-After wait", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errJev(429, { retryAfter: "0" }))
      .mockResolvedValueOnce(okJev(jevAnswers));
    vi.stubGlobal("fetch", fetchMock);

    const res = await classify(req, { provider: "jev", trace: true });
    const t = res.trace!;
    expect(t.attempts.length).toBe(2);
    expect(t.attempts[0].status).toBe(429);
    expect(t.attempts[0].error).toContain("boom 429");
    expect(t.attempts[0].waited_ms).toBe(0);
    expect(t.retries).toBe(1);
  });

  it("jev: falls back to gateway on hard failure and records why", async () => {
    const fetchMock = vi.fn().mockResolvedValue(errJev(401));
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(chat).mockResolvedValue({ text: validJson, model: "m", usage: { input_tokens: 5, output_tokens: 2 } });

    const res = await classify(req, { provider: "jev", trace: true, fallback: true });
    expect(res.provider).toBe("gateway");
    const t = res.trace!;
    expect(t.fallback_from).toBe("jev");
    expect(t.fallback_reason).toContain("boom 401");
  });

  it("jev: without fallback the error still throws (old behavior intact)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(errJev(401));
    vi.stubGlobal("fetch", fetchMock);
    await expect(classify(req, { provider: "jev" })).rejects.toThrow(/boom 401/);
  });

  it("gateway: traces the repair retry with prompt + raw text", async () => {
    vi.mocked(chat)
      .mockResolvedValueOnce({ text: "not json at all", model: "m", usage: { input_tokens: 10, output_tokens: 2 } })
      .mockResolvedValueOnce({ text: validJson, model: "m", usage: { input_tokens: 12, output_tokens: 15 } });

    const res = await classify(req, { provider: "gateway", trace: true });
    const t = res.trace!;
    expect(t.provider_used).toBe("gateway");
    expect(t.retries).toBe(1);
    expect(t.attempts[0].status).toBe(0);
    expect(t.attempts[1].status).toBe(200);
    expect(t.response).toBe(validJson);
    expect(JSON.stringify(t.request)).toContain("previous output was invalid");
  });

  it("batch: passes trace/fallback opts down to every classify call", async () => {
    const classifyFn = vi.fn().mockResolvedValue({
      answers: { category: { type: "choice", choice: "complaint", probabilities: {}, confidence: 0.9 }, urgent: { type: "noul", noul: 0.5 } },
      usage: { input_tokens: 1, output_tokens: 1 },
      model: "m",
      provider: "gateway",
    });
    await classifyBatch([{ id: "a", state: "x" }], questions, {
      trace: true,
      fallback: true,
      classifyFn,
    });
    expect(classifyFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ trace: true, fallback: true }),
    );
  });
});
