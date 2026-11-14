import { describe, it, expect } from "vitest";
import {
  DEFAULT_GATES,
  MEMBERSHIP,
  MEMBERSHIP_NOTE,
  MEMBERSHIP_RANK,
  REUSE_LEVELS,
  curateExchange,
  curateState,
  decideMemoryVerdict,
  memoryQuestions,
  membershipBadgeClass,
  normalizeGates,
  signalsFrom,
  type MemoryGates,
  type MemorySignals,
} from "@/lib/memory";
import type { Answer, ClassifyResult } from "@/lib/schema";

const noul = (p: number): Answer => ({ type: "noul", noul: p });
const score = (s: number, conf = 0.9): Answer => ({
  type: "score",
  score: s,
  probabilities: { [String(Math.round(s))]: conf },
  confidence: conf,
});

function fakeResult(answers: Record<string, Answer>): ClassifyResult {
  return {
    answers,
    usage: { input_tokens: 10, output_tokens: 5 },
    model: "jev-test",
    provider: "gateway",
  };
}

const sig = (over: Partial<MemorySignals> = {}): MemorySignals => ({
  reuse: 3,
  durable: 0.9,
  pii: 0.02,
  confidence: 0.9,
  ...over,
});

function memoryAnswers(over: Partial<{ reuse: Answer; durable: Answer; pii: Answer }> = {}) {
  return {
    reuse: score(3, 0.9),
    durable: noul(0.9),
    pii: noul(0.02),
    ...over,
  } as Record<string, Answer>;
}

describe("UC#6 memory verdicts + questions", () => {
  it("membership is strictly ordered keep < review < forget", () => {
    expect(MEMBERSHIP).toEqual(["keep", "review", "forget"]);
    expect(MEMBERSHIP_RANK.keep).toBeLessThan(MEMBERSHIP_RANK.review);
    expect(MEMBERSHIP_RANK.review).toBeLessThan(MEMBERSHIP_RANK.forget);
  });

  it("every membership has a badge class and a note", () => {
    expect(membershipBadgeClass("keep")).toBe("good");
    expect(membershipBadgeClass("review")).toBe("warn");
    expect(membershipBadgeClass("forget")).toBe("bad");
    for (const m of MEMBERSHIP) expect(MEMBERSHIP_NOTE[m]).toMatch(/\w/);
  });

  it("questions declare one Score ladder (5 levels) + two Nouls", () => {
    const qs = memoryQuestions();
    expect(Object.keys(qs).sort()).toEqual(["durable", "pii", "reuse"]);
    expect(qs.reuse.type).toBe("score");
    expect(qs.reuse.type === "score" && qs.reuse.criteria).toEqual(REUSE_LEVELS);
    expect(REUSE_LEVELS).toHaveLength(5);
    expect(qs.durable.type).toBe("noul");
    expect(qs.pii.type).toBe("noul");
    expect(qs.durable.type === "noul" && qs.durable.criteria?.true).toMatch(/stable/i);
    expect(qs.pii.type === "noul" && qs.pii.criteria?.true).toMatch(/private/i);
  });

  it("default gates order the ladder sanely: forgetAt < keepAt", () => {
    expect(DEFAULT_GATES.forgetAt).toBeLessThan(DEFAULT_GATES.keepAt);
    expect(DEFAULT_GATES.keepAt).toBeGreaterThan(0);
    expect(DEFAULT_GATES.piiBlockAt).toBeGreaterThanOrEqual(0.5);
  });
});

describe("UC#6 signalsFrom validation — declared-set discipline", () => {
  it("extracts signals from a full answer set", () => {
    const s = signalsFrom(memoryAnswers({ reuse: score(4, 0.85) }));
    expect(s).toEqual({ reuse: 4, durable: 0.9, pii: 0.02, confidence: 0.85 });
  });

  it("accepts fractional scores inside the declared levels", () => {
    expect(signalsFrom(memoryAnswers({ reuse: score(2.5) })).reuse).toBe(2.5);
  });

  it("throws on out-of-range or wrong-type reuse", () => {
    expect(() => signalsFrom(memoryAnswers({ reuse: score(5) }))).toThrow(/outside the declared levels/);
    expect(() => signalsFrom(memoryAnswers({ reuse: score(-1) }))).toThrow(/outside the declared levels/);
    expect(() => signalsFrom(memoryAnswers({ reuse: score(Number.NaN) }))).toThrow(/outside the declared levels/);
    expect(() => signalsFrom(memoryAnswers({ reuse: noul(0.5) }))).toThrow(/outside the declared levels/);
    expect(() => signalsFrom({ ...memoryAnswers(), reuse: undefined })).toThrow(/outside the declared levels/);
  });

  it("throws on missing/non-probability nouls", () => {
    expect(() => signalsFrom(memoryAnswers({ durable: score(1) }))).toThrow(/durable/);
    expect(() => signalsFrom(memoryAnswers({ pii: score(1) }))).toThrow(/pii/);
    const bad = memoryAnswers();
    delete bad.pii;
    expect(() => signalsFrom(bad)).toThrow(/pii/);
    expect(() => signalsFrom(memoryAnswers({ pii: noul(1.5) }))).toThrow(/pii/);
  });
});

describe("UC#6 in-code membership ladder", () => {
  it("reusable + stable + clean → KEEP", () => {
    const d = decideMemoryVerdict(sig());
    expect(d.membership).toBe("keep");
    expect(d.reasons[d.reasons.length - 1]).toContain("keep (written to long-term memory)");
  });

  it("reuse at or above keepAt keeps; below it does not", () => {
    expect(decideMemoryVerdict(sig({ reuse: DEFAULT_GATES.keepAt })).membership).toBe("keep");
    expect(decideMemoryVerdict(sig({ reuse: DEFAULT_GATES.keepAt - 0.1 })).membership).toBe("review");
  });

  it("mid reuse → REVIEW (held for a human look)", () => {
    const d = decideMemoryVerdict(sig({ reuse: 1.5 }));
    expect(d.membership).toBe("review");
    expect(d.reasons.join(" ")).toMatch(/held for a human look/);
  });

  it("reuse at or below forgetAt → FORGET", () => {
    const d = decideMemoryVerdict(sig({ reuse: 0.5 }));
    expect(d.membership).toBe("forget");
    expect(d.reasons.join(" ")).toMatch(/nothing here compounds/);
  });

  it("PII floor is absolute — forget even at evergreen reuse", () => {
    const d = decideMemoryVerdict(sig({ reuse: 4, pii: 0.6 }));
    expect(d.membership).toBe("forget");
    expect(d.reasons.join(" ")).toMatch(/private data never reaches long-term memory/);
  });

  it("pii exactly at the floor trips the forget", () => {
    expect(decideMemoryVerdict(sig({ pii: DEFAULT_GATES.piiBlockAt })).membership).toBe("forget");
  });

  it("volatile knowledge is never silently kept — keep caps to review", () => {
    const d = decideMemoryVerdict(sig({ reuse: 4, durable: 0.2 }));
    expect(d.membership).toBe("review");
    expect(d.reasons.join(" ")).toMatch(/keep is capped to review/);
  });

  it("durability cap does not rescue a forget base", () => {
    expect(decideMemoryVerdict(sig({ reuse: 0.2, durable: 0.1 })).membership).toBe("forget");
  });

  it("low confidence demotes keep to review, never to forget", () => {
    const d = decideMemoryVerdict(sig({ reuse: 4, confidence: 0.3 }));
    expect(d.membership).toBe("review");
    expect(d.reasons.join(" ")).toMatch(/never pass into memory silently/);
  });

  it("low confidence leaves review/forget bases alone (no destructive bump)", () => {
    expect(decideMemoryVerdict(sig({ reuse: 1.5, confidence: 0.2 })).membership).toBe("review");
    expect(decideMemoryVerdict(sig({ reuse: 0, confidence: 0.2 })).membership).toBe("forget");
  });

  it("sliders are honored: raising keepAt demotes a keep, lowering forgetAt spares a one-off", () => {
    const gates: MemoryGates = { ...DEFAULT_GATES, keepAt: 3.5 };
    expect(decideMemoryVerdict(sig({ reuse: 3 }), gates).membership).toBe("review");
    const relaxed: MemoryGates = { ...DEFAULT_GATES, forgetAt: 0 };
    expect(decideMemoryVerdict(sig({ reuse: 0.2 }), relaxed).membership).toBe("review");
  });

  it("normalizeGates merges partial slider values over defaults", () => {
    expect(normalizeGates({ piiBlockAt: 0.9 })).toEqual({ ...DEFAULT_GATES, piiBlockAt: 0.9 });
    expect(normalizeGates()).toEqual(DEFAULT_GATES);
  });
});

describe("UC#6 live single-exchange curation (scaffold)", () => {
  it("curateState frames request + answer for the classifier", () => {
    expect(curateState("What is 2+2?", "  4  ")).toBe("REQUEST:\nWhat is 2+2?\n\nANSWER:\n4");
    expect(curateState("What is 2+2?")).toBe("REQUEST:\nWhat is 2+2?");
    expect(curateState("What is 2+2?", "   ")).toBe("REQUEST:\nWhat is 2+2?");
  });

  it("curates one exchange end-to-end with the injected classifier", async () => {
    let asked: Record<string, unknown> | undefined;
    const classifyFn = (async (req: { state: string; questions: Record<string, unknown> }) => {
      asked = req.questions;
      return fakeResult(memoryAnswers({ reuse: score(4, 0.95) }));
    }) as never;

    const out = await curateExchange("Always use npm, not pnpm, in this repo.", "Noted — npm it is.", {
      classifyFn,
    });
    expect(out.decision.membership).toBe("keep");
    expect(out.signals.reuse).toBe(4);
    expect(out.model).toBe("jev-test");
    expect(out.provider).toBe("gateway");
    expect(out.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    expect(out.answer).toBe("Noted — npm it is.");
    expect(Object.keys(asked ?? {}).sort()).toEqual(["durable", "pii", "reuse"]);
  });

  it("PII in the pair is FORGOT live, not kept", async () => {
    const classifyFn = (async () =>
      fakeResult(memoryAnswers({ reuse: score(4), pii: noul(0.8) }))) as never;
    const out = await curateExchange(
      "My card is 4111 1111 1111 1111 — remember my billing preference.",
      undefined,
      { classifyFn },
    );
    expect(out.decision.membership).toBe("forget");
    expect(out.answer).toBeUndefined();
  });

  it("passes gates through and reports the effective set", async () => {
    const classifyFn = (async () => fakeResult(memoryAnswers())) as never;
    const gates = normalizeGates({ keepAt: 3.5 });
    const out = await curateExchange("anything", "reply", { classifyFn, gates });
    expect(out.gates).toEqual(gates);
    expect(out.decision.membership).toBe("review"); // reuse 3 < keepAt 3.5
  });

  it("attaches the dev trace when asked, and omits it otherwise", async () => {
    const traceResult = (answers: Record<string, Answer>): ClassifyResult => ({
      ...fakeResult(answers),
      trace: { provider_used: "gateway", endpoint: "x", request: {}, attempts: [], retries: 0 },
    });
    const classifyFn = (async () => traceResult(memoryAnswers())) as never;
    const dev = await curateExchange("q", "a", { classifyFn, trace: true });
    expect(dev.trace).toBeDefined();
    const plain = await curateExchange("q", "a", { classifyFn });
    expect(plain.trace).toBeUndefined();
  });

  it("propagates classifier errors and validator hard-fails — no silent keeps", async () => {
    const boom = (async () => {
      throw new Error("gateway down");
    }) as never;
    await expect(curateExchange("q", undefined, { classifyFn: boom })).rejects.toThrow(/gateway down/);

    const bad = (async () => fakeResult({ reuse: noul(0.5) })) as never;
    await expect(curateExchange("q", undefined, { classifyFn: bad })).rejects.toThrow(/outside the declared levels/);
  });
});
