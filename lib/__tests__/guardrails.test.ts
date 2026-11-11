import { describe, it, expect } from "vitest";
import {
  DEFAULT_GATES,
  INBOUND_CATEGORIES,
  INBOUND_FLOORS,
  OUTBOUND_DISPOSITIONS,
  OUTBOUND_FLOORS,
  SEVERITY_LEVELS,
  VERDICTS,
  VERDICT_RANK,
  decideInboundVerdict,
  decideOutboundVerdict,
  inboundSignalsFrom,
  normalizeGates,
  outboundSignalsFrom,
  runGuardrailsBatch,
  screenExchange,
  screenInQuestions,
  screenOutQuestions,
  verdictBadgeClass,
  worstVerdict,
  type InboundSignals,
  type OutboundSignals,
} from "@/lib/guardrails";
import type { Answer, ClassifyResult } from "@/lib/schema";

const noul = (p: number): Answer => ({ type: "noul", noul: p });
const choice = (c: string, conf = 0.9): Answer => ({
  type: "choice",
  choice: c,
  probabilities: { [c]: conf },
  confidence: conf,
});
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

const inSig = (over: Partial<InboundSignals> = {}): InboundSignals => ({
  category: "benign",
  severity: 0,
  jailbreak: 0.02,
  confidence: 0.9,
  ...over,
});

const outSig = (over: Partial<OutboundSignals> = {}): OutboundSignals => ({
  disposition: "helpful",
  harm: 0,
  leak: 0.01,
  confidence: 0.9,
  ...over,
});

describe("UC#3 verdict ladder + questions", () => {
  it("verdicts are strictly ordered pass < review < block", () => {
    expect(VERDICTS).toEqual(["pass", "review", "block"]);
    expect(VERDICT_RANK.pass).toBeLessThan(VERDICT_RANK.review);
    expect(VERDICT_RANK.review).toBeLessThan(VERDICT_RANK.block);
    expect(verdictBadgeClass("pass")).toBe("good");
    expect(verdictBadgeClass("review")).toBe("warn");
    expect(verdictBadgeClass("block")).toBe("bad");
  });

  it("worstVerdict takes the highest rank and ignores undefined", () => {
    expect(worstVerdict(["pass", undefined, "review"])).toBe("review");
    expect(worstVerdict(["review", "block"])).toBe("block");
    expect(worstVerdict([])).toBe("pass");
    expect(worstVerdict([undefined])).toBe("pass");
  });

  it("screen-in asks category (choice), severity (score), jailbreak (noul)", () => {
    const qs = screenInQuestions();
    expect(Object.keys(qs).sort()).toEqual(["category", "jailbreak", "severity"]);
    expect(qs.category.type).toBe("choice");
    if (qs.category.type === "choice") {
      expect(Object.keys(qs.category.criteria).sort()).toEqual(
        [...INBOUND_CATEGORIES].sort(),
      );
    }
    expect(qs.severity.type).toBe("score");
    if (qs.severity.type === "score") {
      expect(qs.severity.criteria).toEqual(SEVERITY_LEVELS);
    }
    expect(qs.jailbreak.type).toBe("noul");
  });

  it("screen-out asks disposition (choice), harm (score), leak (noul)", () => {
    const qs = screenOutQuestions();
    expect(Object.keys(qs).sort()).toEqual(["disposition", "harm", "leak"]);
    expect(qs.disposition.type).toBe("choice");
    if (qs.disposition.type === "choice") {
      expect(Object.keys(qs.disposition.criteria).sort()).toEqual(
        [...OUTBOUND_DISPOSITIONS].sort(),
      );
    }
    expect(qs.harm.type).toBe("score");
    expect(qs.leak.type).toBe("noul");
  });

  it("every declared category/disposition has a valid floor", () => {
    for (const c of INBOUND_CATEGORIES) {
      expect(VERDICTS).toContain(INBOUND_FLOORS[c]);
    }
    for (const d of OUTBOUND_DISPOSITIONS) {
      expect(VERDICTS).toContain(OUTBOUND_FLOORS[d]);
    }
    expect(INBOUND_FLOORS.violence).toBe("block");
    expect(OUTBOUND_FLOORS["pii-leak"]).toBe("block");
  });
});

describe("UC#3 decideInboundVerdict (screening in code)", () => {
  it("benign + low severity + no jailbreak passes", () => {
    const d = decideInboundVerdict(inSig());
    expect(d.verdict).toBe("pass");
    expect(d.reasons[d.reasons.length - 1]).toBe("screen-in verdict: pass (let through)");
  });

  it("severity ladder: review gate then block gate, boundary inclusive", () => {
    expect(decideInboundVerdict(inSig({ severity: DEFAULT_GATES.reviewAt })).verdict).toBe("review");
    expect(
      decideInboundVerdict(inSig({ severity: DEFAULT_GATES.blockAt - 0.01 })).verdict,
    ).toBe("review");
    expect(decideInboundVerdict(inSig({ severity: DEFAULT_GATES.blockAt })).verdict).toBe("block");
    expect(decideInboundVerdict(inSig({ severity: 4 })).verdict).toBe("block");
  });

  it("category floors never drop: spam reviews, violence/illegal block at zero severity", () => {
    expect(decideInboundVerdict(inSig({ category: "spam" })).verdict).toBe("review");
    expect(
      decideInboundVerdict(inSig({ category: "harassment", severity: 0 })).verdict,
    ).toBe("review");
    expect(
      decideInboundVerdict(inSig({ category: "self-harm", severity: 0 })).verdict,
    ).toBe("review");
    expect(
      decideInboundVerdict(inSig({ category: "violence", severity: 0 })).verdict,
    ).toBe("block");
    expect(
      decideInboundVerdict(inSig({ category: "illegal", severity: 4 })).verdict,
    ).toBe("block");
  });

  it("jailbreak floor holds content for a human even at zero severity", () => {
    const d = decideInboundVerdict(
      inSig({ category: "benign", severity: 0, jailbreak: DEFAULT_GATES.jailbreakFloor }),
    );
    expect(d.verdict).toBe("review");
    expect(d.reasons.join(" ")).toMatch(/jailbreak probability .* at least a human look/);
    // jailbreak + severe still blocks via the ladder
    expect(
      decideInboundVerdict(inSig({ jailbreak: 0.8, severity: 3.5 })).verdict,
    ).toBe("block");
  });

  it("low confidence raises exactly one rung, capped at block", () => {
    // pass -> review
    expect(decideInboundVerdict(inSig({ confidence: 0.4 })).verdict).toBe("review");
    // review -> block
    expect(
      decideInboundVerdict(inSig({ category: "spam", confidence: 0.4 })).verdict,
    ).toBe("block");
    // block stays block
    expect(
      decideInboundVerdict(inSig({ severity: 4, confidence: 0.1 })).verdict,
    ).toBe("block");
    // high confidence keeps pass
    expect(
      decideInboundVerdict(inSig({ confidence: DEFAULT_GATES.lowConfBump })).verdict,
    ).toBe("pass");
  });

  it("honors custom gates", () => {
    const strict = { ...DEFAULT_GATES, reviewAt: 1, blockAt: 2 };
    expect(decideInboundVerdict(inSig({ severity: 2.5 }), strict).verdict).toBe("block");
    const trusting = { ...DEFAULT_GATES, jailbreakFloor: 0.95 };
    expect(
      decideInboundVerdict(inSig({ jailbreak: 0.9 }), trusting).verdict,
    ).toBe("pass");
  });
});

describe("UC#3 decideOutboundVerdict (screening replies)", () => {
  it("helpful + clean reply passes", () => {
    const d = decideOutboundVerdict(outSig());
    expect(d.verdict).toBe("pass");
    expect(d.reasons[d.reasons.length - 1]).toBe("screen-out verdict: pass (let through)");
  });

  it("leak ladder: review at leakReviewAt, block at leakBlockAt", () => {
    expect(
      decideOutboundVerdict(outSig({ leak: DEFAULT_GATES.leakReviewAt })).verdict,
    ).toBe("review");
    expect(
      decideOutboundVerdict(
        outSig({ leak: DEFAULT_GATES.leakBlockAt - 0.01, disposition: "helpful" }),
      ).verdict,
    ).toBe("review");
    expect(
      decideOutboundVerdict(outSig({ leak: DEFAULT_GATES.leakBlockAt })).verdict,
    ).toBe("block");
  });

  it("disposition floors block pii/secret leaks at zero harm", () => {
    expect(
      decideOutboundVerdict(outSig({ disposition: "pii-leak", harm: 0, leak: 0 })).verdict,
    ).toBe("block");
    expect(
      decideOutboundVerdict(outSig({ disposition: "secret-leak", leak: 0 })).verdict,
    ).toBe("block");
    expect(
      decideOutboundVerdict(outSig({ disposition: "off-policy" })).verdict,
    ).toBe("review");
    expect(
      decideOutboundVerdict(outSig({ disposition: "unsafe-advice", harm: 3.5 })).verdict,
    ).toBe("block");
  });

  it("low-confidence reply is raised one rung", () => {
    expect(decideOutboundVerdict(outSig({ confidence: 0.2 })).verdict).toBe("review");
    expect(
      decideOutboundVerdict(outSig({ disposition: "off-policy", confidence: 0.2 })).verdict,
    ).toBe("block");
  });
});

describe("UC#3 signal validation", () => {
  it("inbound: accepts well-formed answers and takes min confidence", () => {
    const s = inboundSignalsFrom({
      category: choice("harassment", 0.7),
      severity: score(2, 0.55),
      jailbreak: noul(0.1),
    });
    expect(s).toEqual({
      category: "harassment",
      severity: 2,
      jailbreak: 0.1,
      confidence: 0.55,
    });
  });

  it("inbound: rejects category outside the declared set", () => {
    expect(() =>
      inboundSignalsFrom({
        category: choice("launch_missiles"),
        severity: score(1),
        jailbreak: noul(0.1),
      }),
    ).toThrow(/outside the declared set/);
  });

  it("inbound: rejects severity outside the levels or malformed", () => {
    expect(() =>
      inboundSignalsFrom({ category: choice("benign"), severity: score(5), jailbreak: noul(0) }),
    ).toThrow(/severity .* outside the declared levels/);
    expect(() =>
      inboundSignalsFrom({ category: choice("benign"), severity: score(-1), jailbreak: noul(0) }),
    ).toThrow(/severity .* outside the declared levels/);
    expect(() =>
      inboundSignalsFrom({
        category: choice("benign"),
        severity: { type: "choice", choice: "x", probabilities: {}, confidence: 1 } as Answer,
        jailbreak: noul(0),
      }),
    ).toThrow(/severity .* outside the declared levels/);
  });

  it("inbound: rejects a missing or non-noul jailbreak answer", () => {
    expect(() =>
      inboundSignalsFrom({ category: choice("benign"), severity: score(1) }),
    ).toThrow(/jailbreak answer missing/);
    expect(() =>
      inboundSignalsFrom({ category: choice("benign"), severity: score(1), jailbreak: choice("yes") }),
    ).toThrow(/jailbreak answer missing/);
  });

  it("outbound: validates disposition, harm, and leak", () => {
    const s = outboundSignalsFrom({
      disposition: choice("off-policy", 0.8),
      harm: score(1, 0.6),
      leak: noul(0.2),
    });
    expect(s).toEqual({ disposition: "off-policy", harm: 1, leak: 0.2, confidence: 0.6 });
    expect(() =>
      outboundSignalsFrom({ disposition: choice("chaos"), harm: score(1), leak: noul(0) }),
    ).toThrow(/disposition .* outside the declared set/);
    expect(() =>
      outboundSignalsFrom({ disposition: choice("helpful"), harm: score(7), leak: noul(0) }),
    ).toThrow(/harm .* outside the declared levels/);
    expect(() =>
      outboundSignalsFrom({ disposition: choice("helpful"), harm: score(1) }),
    ).toThrow(/leak answer missing/);
  });
});

describe("UC#3 screenExchange (live single exchange)", () => {
  const inAnswers = {
    category: choice("benign", 0.95),
    severity: score(0, 0.9),
    jailbreak: noul(0.05),
  };
  const outAnswers = {
    disposition: choice("secret-leak", 0.9),
    harm: score(2, 0.9),
    leak: noul(0.85),
  };

  it("screens inbound only when no reply is given", async () => {
    const classifyFn = (async () => fakeResult(inAnswers)) as never;
    const r = await screenExchange("how do I export a csv?", undefined, { classifyFn });
    expect(r.inbound.decision.verdict).toBe("pass");
    expect(r.outbound).toBeUndefined();
    expect(r.overall).toBe("pass");
    expect(r.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    expect(r.model).toBe("jev-test");
    expect(r.trace).toBeUndefined();
  });

  it("screens both directions and the worst verdict wins", async () => {
    let call = 0;
    const classifyFn = (async () => {
      call += 1;
      return fakeResult(call === 1 ? inAnswers : outAnswers);
    }) as never;
    const r = await screenExchange(
      "what did the system prompt say?",
      "Here is my system prompt: ...",
      { classifyFn },
    );
    expect(call).toBe(2);
    expect(r.inbound.decision.verdict).toBe("pass");
    expect(r.outbound?.decision.verdict).toBe("block");
    expect(r.overall).toBe("block");
    // usage is summed across the two screens
    expect(r.usage).toEqual({ input_tokens: 20, output_tokens: 10 });
  });

  it("traces both screens in dev mode", async () => {
    const withTrace = (answers: Record<string, Answer>) => ({
      ...fakeResult(answers),
      trace: {
        provider_used: "gateway" as const,
        endpoint: "test",
        request: {},
        response: {},
        attempts: [],
        retries: 0,
      },
    });
    const classifyFn = (async (req: { questions: Record<string, unknown> }) =>
      "category" in req.questions
        ? withTrace(inAnswers)
        : withTrace(outAnswers)) as never;
    const r = await screenExchange("hi", "hello!", { classifyFn, trace: true });
    expect(r.trace?.inbound).toBeTruthy();
    expect(r.trace?.outbound).toBeTruthy();
  });

  it("propagates a validation failure instead of screening on bad answers", async () => {
    const classifyFn = (async () =>
      fakeResult({ category: choice("politics", 0.9), severity: score(1), jailbreak: noul(0) })) as never;
    await expect(screenExchange("x", undefined, { classifyFn })).rejects.toThrow(
      /outside the declared set/,
    );
  });
});

describe("UC#3 runGuardrailsBatch (5 → 10 → All)", () => {
  const items = Array.from({ length: 12 }, (_, i) => ({
    id: `x${i}`,
    inbound: `in ${i}`,
    reply: `out ${i}`,
  }));

  const classifyByState = (async (req: { state: string }) => {
    const i = Number(req.state.replace(/^(in|out) /, ""));
    if (i === 11) throw new Error("gateway exploded");
    if (req.state.startsWith("in")) {
      if (i % 4 === 3)
        return fakeResult({ category: choice("violence"), severity: score(3.5), jailbreak: noul(0.1) });
      if (i % 4 === 2)
        return fakeResult({ category: choice("spam"), severity: score(0), jailbreak: noul(0.1) });
      return fakeResult({ category: choice("benign"), severity: score(0), jailbreak: noul(0.05) });
    }
    if (i % 4 === 2)
      return fakeResult({ disposition: choice("pii-leak"), harm: score(1), leak: noul(0.8) });
    return fakeResult({ disposition: choice("helpful"), harm: score(0), leak: noul(0.02) });
  }) as never;

  it("defaults to the first ladder rung (5 items, both screens each)", async () => {
    let calls = 0;
    const fn = (async (req: { state: string }) => {
      calls += 1;
      return req.state.startsWith("in")
        ? fakeResult({ category: choice("benign"), severity: score(0), jailbreak: noul(0) })
        : fakeResult({ disposition: choice("helpful"), harm: score(0), leak: noul(0) });
    }) as never;
    const rep = await runGuardrailsBatch(items, { classifyFn: fn });
    expect(calls).toBe(10); // 5 items × screen-in + screen-out
    expect(rep.totals.items).toBe(5);
    expect(rep.totals.screensRun).toBe(10);
    expect(rep.totals.inbound).toEqual({ pass: 5, review: 0, block: 0 });
    expect(rep.totals.outbound).toEqual({ pass: 5, review: 0, block: 0 });
    expect(rep.totals.overall.pass).toBe(5);
  });

  it("walks the ladder with correct verdict mix and isolated errors", async () => {
    const b5 = await runGuardrailsBatch(items, { classifyFn: classifyByState, limit: 5 });
    expect(b5.items.map((x) => x.id)).toEqual(["x0", "x1", "x2", "x3", "x4"]);

    const ball = await runGuardrailsBatch(items, { classifyFn: classifyByState, limit: null });
    expect(ball.totals.items).toBe(12);
    expect(ball.totals.errors).toBe(1);
    expect(ball.items[11].error).toMatch(/gateway exploded/);
    // inbound: i%4===3 violent → block (i=3,7); i%4===2 spam → review (i=2,6,10); rest pass (6)
    expect(ball.totals.inbound).toEqual({ pass: 6, review: 3, block: 2 });
    // outbound: i%4===2 pii-leak → block (i=2,6,10); rest pass
    expect(ball.totals.outbound).toEqual({ pass: 8, review: 0, block: 3 });
    // overall: worst of the two screens wins — {2,3,6,7,10} block, rest pass
    expect(ball.totals.overall).toEqual({ pass: 6, review: 0, block: 5 });
    expect(ball.totals.overall.pass + ball.totals.overall.review + ball.totals.overall.block).toBe(
      ball.totals.items - ball.totals.errors,
    );
    // errored item keeps its id and reports no verdicts
    expect(ball.items[11].overall).toBeUndefined();
    // two screens × 11 surviving items = 22 screens
    expect(ball.totals.screensRun).toBe(22);
    expect(ball.model).toBe("jev-test");
  });

  it("scales with the 10-rung without rerunning earlier semantics", async () => {
    const b10 = await runGuardrailsBatch(items, { classifyFn: classifyByState, limit: 10 });
    expect(b10.totals.items).toBe(10);
    expect(b10.totals.errors).toBe(0);
    expect(b10.totals.inbound.block).toBe(2);
    expect(b10.totals.outbound.block).toBe(2);
  });

  it("inbound-only items run one screen each", async () => {
    const inOnly = Array.from({ length: 6 }, (_, i) => ({ id: `i${i}`, inbound: `in ${i}` }));
    const rep = await runGuardrailsBatch(inOnly, {
      classifyFn: classifyByState,
      limit: null,
    });
    expect(rep.totals.screensRun).toBe(6);
    expect(rep.totals.outbound).toEqual({ pass: 0, review: 0, block: 0 });
  });

  it("normalizes partial gates over the shipped defaults", () => {
    expect(normalizeGates()).toEqual(DEFAULT_GATES);
    expect(normalizeGates({ blockAt: 4 })).toEqual({ ...DEFAULT_GATES, blockAt: 4 });
    expect(
      normalizeGates({
        reviewAt: 1,
        blockAt: 2,
        jailbreakFloor: 0.3,
        leakReviewAt: 0.2,
        leakBlockAt: 0.6,
        lowConfBump: 0.8,
      }),
    ).toEqual({
      reviewAt: 1,
      blockAt: 2,
      jailbreakFloor: 0.3,
      leakReviewAt: 0.2,
      leakBlockAt: 0.6,
      lowConfBump: 0.8,
    });
  });

  it("batch honors tightened gates end-to-end", async () => {
    const rep = await runGuardrailsBatch(items.slice(0, 4), {
      classifyFn: classifyByState,
      limit: null,
      gates: { jailbreakFloor: 0.04 }, // every benign item has jailbreak 0.05 ≥ floor
    });
    // pass verdicts are pulled up to review by the jailbreak floor
    expect(rep.totals.overall.pass).toBe(0);
    expect(rep.totals.inbound.review).toBeGreaterThan(0);
  });
});
