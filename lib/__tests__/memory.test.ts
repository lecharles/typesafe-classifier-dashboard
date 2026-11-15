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
  runMemoryBatch,
  signalsFrom,
  type MemoryGates,
  type MemorySignals,
} from "@/lib/memory";
import { memoryCandidates } from "@/data/memory-candidates";
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

describe("UC#6-live runMemoryBatch (candidate ladder 5 → 10 → All)", () => {
  // 12 synthetic candidates exercising every rung of the ladder.
  const candidates = Array.from({ length: 12 }, (_, i) => {
    const n = i + 1;
    if (n === 3) return { id: `m${n}`, request: "boom — gateway dies on this candidate", answer: "x" };
    if (n === 5) return { id: `m${n}`, request: "pii leak: card 4111 1111 1111", answer: "x" };
    if (n === 7) return { id: `m${n}`, request: "volatile price fact", answer: "x" };
    if (n === 9) return { id: `m${n}`, request: "one-off arithmetic", answer: "x" };
    return { id: `m${n}`, request: `durable preference #${n}`, answer: `noted ${n}` };
  });

  const fakeFn = (async (req: { state: string }) => {
    if (req.state.includes("boom")) throw new Error("gateway down for m3");
    if (req.state.includes("pii")) {
      return fakeResult(memoryAnswers({ reuse: score(4, 0.95), pii: noul(0.9) }));
    }
    if (req.state.includes("volatile")) {
      return fakeResult(memoryAnswers({ reuse: score(4, 0.9), durable: noul(0.1) }));
    }
    if (req.state.includes("arithmetic")) {
      return fakeResult(memoryAnswers({ reuse: score(0, 0.95) }));
    }
    return fakeResult(memoryAnswers({ reuse: score(3.5, 0.9) }));
  }) as never;

  it("processes the first ladder rung by default", async () => {
    const report = await runMemoryBatch(candidates, { classifyFn: fakeFn });
    expect(report.totals.candidates).toBe(5);
    expect(report.items).toHaveLength(5);
    expect(report.items.map((x) => x.id)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
  });

  it("limit 10 widens the ladder; limit null runs All", async () => {
    const ten = await runMemoryBatch(candidates, { classifyFn: fakeFn, limit: 10 });
    expect(ten.totals.candidates).toBe(10);
    const all = await runMemoryBatch(candidates, { classifyFn: fakeFn, limit: null });
    expect(all.totals.candidates).toBe(12);
    expect(all.items).toHaveLength(12);
  });

  it("a limit past the corpus is clamped, not padded", async () => {
    const report = await runMemoryBatch(candidates, { classifyFn: fakeFn, limit: 40 });
    expect(report.totals.candidates).toBe(12);
  });

  it("errors are isolated per candidate — one boom never aborts the batch", async () => {
    const report = await runMemoryBatch(candidates, { classifyFn: fakeFn, limit: null });
    expect(report.totals.errors).toBe(1);
    const failed = report.items.find((x) => x.error);
    expect(failed?.id).toBe("m3");
    expect(failed?.membership).toBeUndefined();
    expect(report.items.filter((x) => !x.error)).toHaveLength(11);
  });

  it("keep / review / forget tallies are decided IN CODE per candidate", async () => {
    const report = await runMemoryBatch(candidates, { classifyFn: fakeFn, limit: null });
    // m5 pii floor overrides evergreen reuse → forget; m7 volatile → review cap;
    // m9 one-off → forget; the other 8 durable preferences → keep.
    expect(report.totals.verdicts).toEqual({ keep: 8, review: 1, forget: 2 });
    expect(report.totals.verdicts.keep + report.totals.verdicts.review + report.totals.verdicts.forget).toBe(
      report.totals.candidates - report.totals.errors,
    );
    const byId = (id: string) => report.items.find((x) => x.id === id);
    expect(byId("m5")?.membership).toBe("forget");
    expect(byId("m5")?.reasons?.join(" ")).toMatch(/private data never reaches long-term memory/);
    expect(byId("m7")?.membership).toBe("review");
    expect(byId("m7")?.reasons?.join(" ")).toMatch(/keep is capped to review/);
    expect(byId("m9")?.membership).toBe("forget");
  });

  it("usage sums across candidates and the model/provider are reported", async () => {
    const report = await runMemoryBatch(candidates, { classifyFn: fakeFn, limit: null });
    // 11 successes × {10↑, 5↓}
    expect(report.totals.usage).toEqual({ input_tokens: 110, output_tokens: 55 });
    expect(report.model).toBe("jev-test");
    expect(report.provider).toBe("gateway");
  });

  it("gates pass through to every candidate and the effective set is reported", async () => {
    const report = await runMemoryBatch(candidates, {
      classifyFn: fakeFn,
      limit: null,
      gates: { keepAt: 3.6 },
    });
    expect(report.gates).toEqual(normalizeGates({ keepAt: 3.6 }));
    // reuse 3.5 no longer clears the raised keep gate → all demote to review
    expect(report.totals.verdicts.keep).toBe(0);
    expect(report.totals.verdicts.review).toBe(9); // 8 demoted keepers + the volatile cap
  });

  it("items carry request/answer/signals for the dashboard rows", async () => {
    const report = await runMemoryBatch(candidates, { classifyFn: fakeFn, limit: 5 });
    const keeper = report.items.find((x) => x.membership === "keep");
    expect(keeper?.signals?.reuse).toBe(3.5);
    expect(keeper?.answer).toBe("noted 1");
    expect(keeper?.request).toContain("durable preference");
  });

  it("empty corpus is an empty report, not a crash", async () => {
    const report = await runMemoryBatch([], { classifyFn: fakeFn });
    expect(report.totals.candidates).toBe(0);
    expect(report.items).toEqual([]);
    expect(report.totals.verdicts).toEqual({ keep: 0, review: 0, forget: 0 });
  });
});

describe("UC#6-live shipped candidate corpus", () => {
  it("has unique ids, >10 pairs so the All rung exceeds 10, and non-empty requests", () => {
    expect(memoryCandidates.length).toBeGreaterThan(10);
    const ids = memoryCandidates.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of memoryCandidates) {
      expect(c.request.trim().length).toBeGreaterThan(0);
    }
  });

  it("contains PII carriers for the floor to catch, and clean evergreen pairs", () => {
    const piiish = memoryCandidates.filter((c) =>
      /card number|home address|medication/i.test(`${c.request} ${c.answer ?? ""}`),
    );
    expect(piiish.length).toBeGreaterThanOrEqual(3);
    const clean = memoryCandidates.filter(
      (c) => !/card number|home address|medication/i.test(`${c.request} ${c.answer ?? ""}`),
    );
    expect(clean.length).toBeGreaterThan(piiish.length);
  });
});
