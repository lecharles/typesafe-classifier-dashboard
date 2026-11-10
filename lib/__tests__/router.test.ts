import { describe, it, expect } from "vitest";
import {
  DEFAULT_GATES,
  DIFFICULTY_LEVELS,
  FRONTIER_TIER,
  INTENTS,
  TIERS,
  decideTier,
  estimateCost,
  normalizeGates,
  routerQuestions,
  routePrompt,
  runRouterBatch,
  signalsFromAnswers,
  tierById,
  type RouteSignals,
} from "@/lib/router";
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
    usage: { input_tokens: 12, output_tokens: 6 },
    model: "jev-test",
    provider: "gateway",
  };
}

const sig = (over: Partial<RouteSignals> = {}): RouteSignals => ({
  intent: "qa",
  difficulty: 1,
  risk: 0.05,
  confidence: 0.9,
  ...over,
});

describe("UC#2 tier ladder + questions", () => {
  it("has 3 uniquely-ranked tiers with frontier most expensive", () => {
    expect(TIERS.map((t) => t.id)).toEqual(["cheap", "mid", "frontier"]);
    expect(TIERS.map((t) => t.rank)).toEqual([0, 1, 2]);
    const costs = TIERS.map((t) => t.inputCostPerMtok + t.outputCostPerMtok);
    expect(costs[2]).toBeGreaterThan(costs[1]);
    expect(costs[1]).toBeGreaterThan(costs[0]);
    expect(FRONTIER_TIER.id).toBe("frontier");
    expect(tierById("mid").label).toBe("Mid");
    expect(() => tierById("quantum" as never)).toThrow(/unknown tier/);
  });

  it("asks exactly intent (choice), difficulty (score), risk (noul)", () => {
    const qs = routerQuestions();
    expect(Object.keys(qs).sort()).toEqual(["difficulty", "intent", "risk"]);
    expect(qs.intent.type).toBe("choice");
    if (qs.intent.type === "choice") {
      expect(Object.keys(qs.intent.criteria).sort()).toEqual([...INTENTS].sort());
    }
    expect(qs.difficulty.type).toBe("score");
    if (qs.difficulty.type === "score") {
      expect(qs.difficulty.criteria).toEqual(DIFFICULTY_LEVELS);
    }
    expect(qs.risk.type).toBe("noul");
  });

  it("estimateCost multiplies tokens by the tier's $/Mtok rates", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 500_000 };
    expect(estimateCost(usage, tierById("cheap"))).toBeCloseTo(0.06 + 0.5 * 0.24, 10);
    expect(estimateCost(usage, FRONTIER_TIER)).toBeCloseTo(3.0 + 0.5 * 15.0, 10);
    expect(estimateCost({ input_tokens: 0, output_tokens: 0 }, FRONTIER_TIER)).toBe(0);
  });
});

describe("UC#2 decideTier (routing in code)", () => {
  it("risk at or above the floor forces frontier regardless of difficulty", () => {
    const d = decideTier(sig({ risk: 0.5, difficulty: 0 })); // exactly at floor
    expect(d.tier).toBe("frontier");
    expect(d.reasons.join(" ")).toMatch(/high-risk never runs on a cheap model/);
    expect(decideTier(sig({ risk: 0.9 })).tier).toBe("frontier");
    // just below the floor → normal ladder applies
    expect(decideTier(sig({ risk: 0.49, difficulty: 0 })).tier).toBe("cheap");
  });

  it("walks the difficulty ladder: trivial→cheap, moderate→mid, hard→frontier", () => {
    expect(decideTier(sig({ difficulty: 1 })).tier).toBe("cheap");
    expect(decideTier(sig({ difficulty: DEFAULT_GATES.midAt })).tier).toBe("mid");
    expect(decideTier(sig({ difficulty: 2.5 })).tier).toBe("mid");
    expect(decideTier(sig({ difficulty: DEFAULT_GATES.frontierAt })).tier).toBe("frontier");
    expect(decideTier(sig({ difficulty: 4 })).tier).toBe("frontier");
  });

  it("code intent never runs on the cheapest model", () => {
    const d = decideTier(sig({ intent: "code", difficulty: 0 }));
    expect(d.tier).toBe("mid");
    expect(d.reasons.join(" ")).toMatch(/intent=code never runs on the cheapest model/);
    // does not double-bump when difficulty already earned the mid rung
    expect(decideTier(sig({ intent: "code", difficulty: 2 })).tier).toBe("mid");
  });

  it("low classification confidence raises exactly one rung, capped at frontier", () => {
    expect(decideTier(sig({ difficulty: 0, confidence: 0.5 })).tier).toBe("mid");
    expect(decideTier(sig({ difficulty: 2, confidence: 0.5 })).tier).toBe("frontier");
    expect(decideTier(sig({ difficulty: 3.5, confidence: 0.5 })).tier).toBe("frontier");
    expect(decideTier(sig({ difficulty: 2, confidence: 0.95 })).tier).toBe("mid");
  });

  it("honors custom gates", () => {
    const d = decideTier(sig({ risk: 0.3, difficulty: 3 }), {
      ...DEFAULT_GATES,
      riskFloor: 0.25,
    });
    expect(d.tier).toBe("frontier");
    const loose = decideTier(
      sig({ difficulty: 2.5 }),
      { ...DEFAULT_GATES, frontierAt: 3.5, midAt: 3 },
    );
    expect(loose.tier).toBe("cheap");
  });

  it("last reason always names the target tier and model", () => {
    const d = decideTier(sig({ difficulty: 0 }));
    const t = TIERS.find((x) => x.id === d.tier)!;
    expect(d.reasons[d.reasons.length - 1]).toBe(`routed to ${t.label}: ${d.model}`);
    expect(d.model).toBe(t.model);
  });
});

describe("UC#2 signalsFromAnswers", () => {
  it("accepts a well-formed answer set and takes the min confidence", () => {
    const s = signalsFromAnswers({
      intent: choice("triage", 0.8),
      difficulty: score(2, 0.65),
      risk: noul(0.2),
    });
    expect(s).toEqual({ intent: "triage", difficulty: 2, risk: 0.2, confidence: 0.65 });
  });

  it("rejects intent outside the declared set", () => {
    expect(() =>
      signalsFromAnswers({ intent: choice("launch_missiles"), difficulty: score(1), risk: noul(0.1) }),
    ).toThrow(/outside the declared set/);
  });

  it("rejects a difficulty score outside the levels or malformed", () => {
    expect(() =>
      signalsFromAnswers({ intent: choice("qa"), difficulty: score(5), risk: noul(0.1) }),
    ).toThrow(/outside the declared levels/);
    expect(() =>
      signalsFromAnswers({ intent: choice("qa"), difficulty: score(-1), risk: noul(0.1) }),
    ).toThrow(/outside the declared levels/);
    expect(() =>
      signalsFromAnswers({
        intent: choice("qa"),
        difficulty: { type: "choice", choice: "x", probabilities: {}, confidence: 1 } as Answer,
        risk: noul(0.1),
      }),
    ).toThrow(/outside the declared levels/);
  });

  it("rejects a missing or non-noul risk answer", () => {
    expect(() =>
      signalsFromAnswers({ intent: choice("qa"), difficulty: score(1) }),
    ).toThrow(/risk answer missing/);
    expect(() =>
      signalsFromAnswers({ intent: choice("qa"), difficulty: score(1), risk: choice("yes") }),
    ).toThrow(/risk answer missing/);
  });
});

describe("UC#2 routePrompt (live single request)", () => {
  it("routes a well-formed classify result to a tier, echoing usage/model", async () => {
    const classifyFn = (async () =>
      fakeResult({ intent: choice("creative", 0.92), difficulty: score(1, 0.88), risk: noul(0.02) })) as never;
    const r = await routePrompt("write a haiku about trains", { classifyFn });
    expect(r.decision.tier).toBe("cheap");
    expect(r.usage).toEqual({ input_tokens: 12, output_tokens: 6 });
    expect(r.model).toBe("jev-test");
    expect(r.provider).toBe("gateway");
    expect(r.trace).toBeUndefined();
  });

  it("propagates a validation failure instead of routing on bad answers", async () => {
    const classifyFn = (async () =>
      fakeResult({ intent: choice("quantum_tunneling", 0.9), difficulty: score(1), risk: noul(0.1) })) as never;
    await expect(routePrompt("x", { classifyFn })).rejects.toThrow(/outside the declared set/);
  });

  it("attaches the raw trace in dev mode", async () => {
    const classifyFn = (async () => ({
      ...fakeResult({ intent: choice("qa"), difficulty: score(0), risk: noul(0.1) }),
      trace: {
        provider_used: "gateway",
        endpoint: "test",
        request: {},
        response: {},
        attempts: [],
        retries: 0,
      },
    })) as never;
    const r = await routePrompt("hello", { classifyFn, trace: true });
    expect(r.trace).toBeTruthy();
  });
});

describe("UC#2 runRouterBatch (5 → 10 → All)", () => {
  const items = Array.from({ length: 12 }, (_, i) => ({
    id: `r${i}`,
    prompt: `prompt ${i}`,
  }));

  function resultFor(i: number): ClassifyResult {
    if (i % 4 === 3) return fakeResult({ intent: choice("qa"), difficulty: score(1), risk: noul(0.9) });
    if (i % 4 === 2) return fakeResult({ intent: choice("code"), difficulty: score(2), risk: noul(0.1) });
    return fakeResult({ intent: choice("qa"), difficulty: score(0), risk: noul(0.05) });
  }

  const classifyFnByReq = (async (req: { state: string }) => {
    const i = Number(req.state.replace("prompt ", ""));
    if (i === 11) throw new Error("gateway exploded");
    return resultFor(i);
  }) as never;

  it("defaults to the first ladder rung (5 items)", async () => {
    let calls = 0;
    const fn = (async () => {
      calls += 1;
      return fakeResult({ intent: choice("qa"), difficulty: score(0), risk: noul(0.05) });
    }) as never;
    const rep = await runRouterBatch(items, { classifyFn: fn });
    expect(calls).toBe(5);
    expect(rep.totals.items).toBe(5);
    expect(rep.totals.routed.cheap).toBe(5);
  });

  it("walks 5 → 10 → All with correct tier mix and isolated errors", async () => {
    const b5 = await runRouterBatch(items, { classifyFn: classifyFnByReq, limit: 5 });
    expect(b5.totals.items).toBe(5);
    expect(b5.items.map((x) => x.id)).toEqual(["r0", "r1", "r2", "r3", "r4"]);

    const b10 = await runRouterBatch(items, { classifyFn: classifyFnByReq, limit: 10 });
    expect(b10.totals.items).toBe(10);

    const ball = await runRouterBatch(items, { classifyFn: classifyFnByReq, limit: null });
    expect(ball.totals.items).toBe(12);
    expect(ball.totals.errors).toBe(1);
    expect(ball.items[11].error).toMatch(/gateway exploded/);
    // i%4===3 risky (i=3,7) → frontier; i=11 errored first
    // i%4===2 code+d2 (i=2,6,10) → mid
    // rest (i=0,1,4,5,8,9) → cheap
    expect(ball.totals.routed).toEqual({ cheap: 6, mid: 3, frontier: 2 });
    expect(ball.totals.items).toBe(
      ball.totals.routed.cheap + ball.totals.routed.mid + ball.totals.routed.frontier + ball.totals.errors,
    );
  });

  it("computes savings vs all-frontier from per-item costs", async () => {
    // realistic token volume so the 4-decimal rounding of USD totals can't
    // collapse cheap-vs-frontier to identical numbers
    const bigUsage = { input_tokens: 100_000, output_tokens: 100_000 };
    const classifyFn = (async () => ({
      ...fakeResult({ intent: choice("triage"), difficulty: score(0), risk: noul(0.05) }),
      usage: bigUsage,
    })) as never;
    const rep = await runRouterBatch(items.slice(0, 4), { classifyFn, limit: null });
    expect(rep.totals.routed.cheap).toBe(4);
    expect(rep.totals.costAllFrontierUsd).toBeGreaterThan(rep.totals.costRoutedUsd);
    expect(rep.totals.savingsUsd).toBeCloseTo(
      rep.totals.costAllFrontierUsd - rep.totals.costRoutedUsd,
      4,
    );
    expect(rep.totals.savingsPct).toBeGreaterThan(0);
    expect(rep.totals.savingsPct).toBeLessThan(1);
    expect(rep.totals.usage).toEqual({ input_tokens: 400_000, output_tokens: 400_000 });
    // each item: 0.1Mtok in + 0.1Mtok out → cheap 0.03, frontier 1.8 → x4
    expect(rep.totals.costRoutedUsd).toBeCloseTo(0.12, 4);
    expect(rep.totals.costAllFrontierUsd).toBeCloseTo(7.2, 4);
    expect(rep.totals.savingsUsd).toBeCloseTo(7.08, 4);
    expect(rep.model).toBe("jev-test");
  });

  it("normalizes partial gates over the shipped defaults", () => {
    expect(normalizeGates()).toEqual(DEFAULT_GATES);
    expect(normalizeGates({ riskFloor: 0.8 })).toEqual({ ...DEFAULT_GATES, riskFloor: 0.8 });
    expect(
      normalizeGates({ midAt: 2, frontierAt: 3.5, riskFloor: 0.4, lowConfBump: 0.6 }),
    ).toEqual({ midAt: 2, frontierAt: 3.5, riskFloor: 0.4, lowConfBump: 0.6 });
  });
});
