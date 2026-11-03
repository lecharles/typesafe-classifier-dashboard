import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { systemOne, listModels, defaultJevModel, JevError } from "@/lib/jev";
import { classify, defaultProvider } from "@/lib/classify";
import type { Question } from "@/lib/schema";

const questions: Record<string, Question> = {
  tone: { type: "choice", instructions: "What is the tone?", criteria: { angry: "upset", calm: "neutral" } },
  urgency: { type: "score", instructions: "How urgent?", criteria: ["Can wait", "Needs attention today"] },
  billing: { type: "noul", instructions: "Is this about billing?" },
};

const answers = {
  tone: { type: "choice", choice: "calm", probabilities: { angry: 0.1, calm: 0.9 }, confidence: 0.9 },
  // Jev returns fractional scores plus a legend; zod keeps the typed fields.
  urgency: {
    type: "score",
    score: 1.4,
    probabilities: { "0": 0.2, "1": 0.8 },
    confidence: 0.6,
    legend: { "0": "Can wait", "1": "Needs attention today" },
  },
  billing: { type: "noul", noul: 0.98 },
};

function okJev(ans: Record<string, unknown>, model = "jev-1.14.0") {
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

describe("jev.systemOne", () => {
  beforeEach(() => {
    process.env.TYPESAFE_API_KEY="test-typesafe-key";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TYPESAFE_API_KEY;
  });

  it("posts to /v1/systemone with bearer auth and parses answers + usage", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJev(answers));
    vi.stubGlobal("fetch", fetchMock);

    const res = await systemOne({ model: "jev-latest", state: "hello", questions });

    expect(res.model).toBe("jev-1.14.0");
    expect(res.usage).toEqual({ input_tokens: 120, output_tokens: 12 });
    expect(res.answers.billing).toBeTruthy();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/v1/systemone");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-typesafe-key");
    const sent = JSON.parse(init.body as string);
    expect(sent.model).toBe("jev-latest");
    expect(Object.keys(sent.questions)).toEqual(["tone", "urgency", "billing"]);
  });

  it("throws 401 when no key is configured", async () => {
    delete process.env.TYPESAFE_API_KEY;
    await expect(systemOne({ model: "m", state: "s", questions })).rejects.toBeInstanceOf(JevError);
  });

  it("retries 429 honoring Retry-After, then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errJev(429, { retryAfter: "0" }))
      .mockResolvedValueOnce(okJev(answers));
    vi.stubGlobal("fetch", fetchMock);

    const res = await systemOne({ model: "m", state: "s", questions });

    expect(res.answers.tone).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries 529 overloaded with backoff", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errJev(529, { retryAfter: "0" }))
      .mockResolvedValueOnce(okJev(answers));
    vi.stubGlobal("fetch", fetchMock);

    const res = await systemOne({ model: "m", state: "s", questions });

    expect(res.usage.input_tokens).toBe(120);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry 422 validation errors and surfaces the failing field", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      errJev(422, {
        body: {
          detail: [
            { loc: ["body", "questions", "urgency", "score", "criteria"], msg: "Field required", type: "missing" },
          ],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(systemOne({ model: "m", state: "s", questions })).rejects.toThrow(
      "422 at questions.urgency.score.criteria: Field required",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("routes through the Vercel AI Gateway using the gateway key when TYPESAFE_API_BASE is set", async () => {
    process.env.TYPESAFE_API_BASE = "https://ai-gateway.vercel.sh/typesafe";
    delete process.env.TYPESAFE_API_KEY;
    process.env.AI_GATEWAY_API_KEY="***";
    const fetchMock = vi.fn().mockResolvedValue(okJev(answers, "typesafe-ai/jev-1.14.0"));
    vi.stubGlobal("fetch", fetchMock);

    const res = await systemOne({ model: defaultJevModel(), state: "s", questions });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://ai-gateway.vercel.sh/typesafe/v1/systemone");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer vck-gateway-key");
    expect(JSON.parse(init.body as string).model).toBe("typesafe-ai/jev");
    expect(res.model).toBe("typesafe-ai/jev-1.14.0");

    delete process.env.TYPESAFE_API_BASE;
    delete process.env.AI_GATEWAY_API_KEY;
  });
});

describe("gateway-routed defaults", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_BASE;
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.CLASSIFIER_PROVIDER;
  });

  it("defaultProvider picks jev when only a gateway key + gateway base exist", () => {
    process.env.TYPESAFE_API_BASE = "https://ai-gateway.vercel.sh/typesafe";
    process.env.AI_GATEWAY_API_KEY="***";
    expect(defaultProvider()).toBe("jev");
    // direct route without a Typesafe key falls back to the emulation
    delete process.env.TYPESAFE_API_BASE;
    expect(defaultProvider()).toBe("gateway");
  });

  it("defaultJevModel names differ per route", () => {
    process.env.TYPESAFE_API_BASE = "https://ai-gateway.vercel.sh/typesafe";
    expect(defaultJevModel()).toBe("typesafe-ai/jev");
    delete process.env.TYPESAFE_API_BASE;
    expect(defaultJevModel()).toBe("jev-latest");
  });
});

describe("listModels", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TYPESAFE_API_KEY;
  });

  it("returns model names from GET /v1/models", async () => {
    process.env.TYPESAFE_API_KEY="test-typesafe-key";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: [{ name: "jev-latest", description: "General-purpose system one model." }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const models = await listModels();
    expect(models[0].name).toBe("jev-latest");
  });
});

describe("classify via the real Jev provider", () => {
  beforeEach(() => {
    process.env.TYPESAFE_API_KEY="test-typesafe-key";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.CLASSIFIER_PROVIDER;
  });

  it("answers every question in ONE request and validates typed results", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJev(answers));
    vi.stubGlobal("fetch", fetchMock);

    const res = await classify({ state: "I was charged twice.", questions }, { provider: "jev" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.provider).toBe("jev");
    expect(res.model).toBe("jev-1.14.0");
    if (res.answers.tone.type === "choice") expect(res.answers.tone.choice).toBe("calm");
    if (res.answers.urgency.type === "score") expect(res.answers.urgency.score).toBeCloseTo(1.4);
    // zod strips API extras like the score legend
    expect(JSON.stringify(res.answers.urgency)).not.toContain("legend");
    if (res.answers.billing.type === "noul") expect(res.answers.billing.noul).toBe(0.98);
  });

  it("rejects an out-of-range answer from the API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJev({ ...answers, billing: { type: "noul", noul: 1.7 } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(classify({ state: "s", questions }, { provider: "jev" })).rejects.toThrow(/billing/);
  });

  it("defaultProvider picks jev with a key, gateway without; env overrides", () => {
    delete process.env.TYPESAFE_API_KEY;
    expect(defaultProvider()).toBe("gateway");
    process.env.TYPESAFE_API_KEY="test-typesafe-key";
    expect(defaultProvider()).toBe("jev");
    process.env.CLASSIFIER_PROVIDER = "gateway";
    expect(defaultProvider()).toBe("gateway");
  });
});
