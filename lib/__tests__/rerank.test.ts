import { describe, it, expect } from "vitest";
import {
  COVERAGE_NOTE,
  COVERAGES,
  DEFAULT_RERANK_GATES,
  DISPOSITIONS,
  DISPOSITION_NOTE,
  DISPOSITION_RANK,
  GROUNDINGS,
  RELEVANCE_LEVELS,
  dispositionBadgeClass,
  decidePassage,
  normalizeRerankGates,
  rankPassages,
  rerankPassages,
  rerankQuestions,
  rerankSignalsFrom,
  rerankState,
  runRerankBatch,
  summarizeCoverage,
  type RerankSignals,
  type ScoredPassage,
} from "@/lib/rerank";
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

const sig = (over: Partial<RerankSignals> = {}): RerankSignals => ({
  relevance: 3,
  grounding: "self-contained",
  conflict: 0.1,
  confidence: 0.9,
  ...over,
});

function scored(id: string, over: Partial<RerankSignals> = {}): ScoredPassage {
  const signals = sig(over);
  return {
    id,
    text: `passage ${id}`,
    signals,
    decision: decidePassage(signals),
  };
}

describe("UC#5 dispositions + questions", () => {
  it("dispositions are strictly ordered ship < bench < drop", () => {
    expect(DISPOSITIONS).toEqual(["ship", "bench", "drop"]);
    expect(DISPOSITION_RANK.ship).toBeLessThan(DISPOSITION_RANK.bench);
    expect(DISPOSITION_RANK.bench).toBeLessThan(DISPOSITION_RANK.drop);
    expect(dispositionBadgeClass("ship")).toBe("good");
    expect(dispositionBadgeClass("bench")).toBe("warn");
    expect(dispositionBadgeClass("drop")).toBe("bad");
    for (const d of DISPOSITIONS) expect(DISPOSITION_NOTE[d]).toBeTruthy();
  });

  it("asks relevance (score), grounding (choice), conflict (noul)", () => {
    const qs = rerankQuestions("how do I set up sso?");
    expect(Object.keys(qs).sort()).toEqual(["conflict", "grounding", "relevance"]);
    if (qs.relevance.type === "score") {
      expect(qs.relevance.criteria).toEqual(RELEVANCE_LEVELS);
      expect(qs.relevance.instructions).toContain("how do I set up sso?");
    }
    expect(qs.grounding.type === "choice" &&
      Object.keys(qs.grounding.criteria).sort()).toEqual([...GROUNDINGS].sort());
    expect(qs.conflict.type).toBe("noul");
  });

  it("state labels query and passage plainly", () => {
    expect(rerankState("Q?", "P.")).toBe('QUERY: Q?\nPASSAGE: "P."');
  });
});

describe("UC#5 decidePassage (picking what reaches the model, in code)", () => {
  it("a strongly relevant, self-contained, fresh passage ships", () => {
    const d = decidePassage(sig({ relevance: 4 }));
    expect(d.disposition).toBe("ship");
    expect(d.reasons[d.reasons.length - 1]).toBe(
      "passage disposition: ship (reaches the answering model)",
    );
  });

  it("relevance ladder: ship gate, bench gate, drop; boundaries inclusive", () => {
    expect(decidePassage(sig({ relevance: DEFAULT_RERANK_GATES.shipAt })).disposition).toBe("ship");
    expect(decidePassage(sig({ relevance: DEFAULT_RERANK_GATES.benchAt })).disposition).toBe("bench");
    expect(decidePassage(sig({ relevance: 1.9 })).disposition).toBe("drop");
    expect(decidePassage(sig({ relevance: 0 })).disposition).toBe("drop");
  });

  it("grounding caps: noise always drops; needs-context alone never ships", () => {
    expect(decidePassage(sig({ relevance: 4, grounding: "noise" })).disposition).toBe("drop");
    expect(decidePassage(sig({ relevance: 4, grounding: "needs-context" })).disposition).toBe("bench");
    // needs-context does not worsen an already-benched passage beyond its rung
    expect(decidePassage(sig({ relevance: 2, grounding: "needs-context" })).disposition).toBe("bench");
  });

  it("conflict ladder: capped at bench at conflictBenchAt, dropped at conflictDropAt", () => {
    expect(
      decidePassage(sig({ relevance: 4, conflict: DEFAULT_RERANK_GATES.conflictBenchAt })).disposition,
    ).toBe("bench");
    expect(
      decidePassage(sig({ relevance: 4, conflict: DEFAULT_RERANK_GATES.conflictDropAt - 0.01 })).disposition,
    ).toBe("bench");
    expect(
      decidePassage(sig({ relevance: 4, conflict: DEFAULT_RERANK_GATES.conflictDropAt })).disposition,
    ).toBe("drop");
  });

  it("low confidence raises exactly one rung, capped at drop", () => {
    expect(decidePassage(sig({ relevance: 4, confidence: 0.3 })).disposition).toBe("bench");
    expect(decidePassage(sig({ relevance: 2, confidence: 0.3 })).disposition).toBe("drop");
    expect(decidePassage(sig({ relevance: 0, confidence: 0.3 })).disposition).toBe("drop");
    expect(decidePassage(sig({ relevance: 4, confidence: DEFAULT_RERANK_GATES.lowConfBump })).disposition).toBe("ship");
  });

  it("honors custom gates", () => {
    const strict = { ...DEFAULT_RERANK_GATES, shipAt: 4, benchAt: 3 };
    expect(decidePassage(sig({ relevance: 3.5 }), strict).disposition).toBe("bench");
    const paranoid = { ...DEFAULT_RERANK_GATES, conflictDropAt: 0.4 };
    expect(decidePassage(sig({ conflict: 0.5 }), paranoid).disposition).toBe("drop");
  });

  it("normalizeRerankGates merges partial slider values over defaults", () => {
    expect(normalizeRerankGates()).toEqual(DEFAULT_RERANK_GATES);
    expect(normalizeRerankGates({ topK: 5, shipAt: 4 })).toEqual({
      ...DEFAULT_RERANK_GATES,
      topK: 5,
      shipAt: 4,
    });
  });
});

describe("UC#5 rankPassages + summarizeCoverage", () => {
  it("sorts best-relevance-first and demotes ships beyond top-k to bench", () => {
    const ranked = rankPassages([
      scored("p3", { relevance: 3.2 }),
      scored("p1", { relevance: 4 }),
      scored("p4", { relevance: 3.1 }),
      scored("p2", { relevance: 3.5 }),
    ]);
    expect(ranked.map((r) => r.id)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(ranked[0].finalDisposition).toBe("ship");
    expect(ranked[1].finalDisposition).toBe("ship");
    expect(ranked[2].finalDisposition).toBe("ship");
    expect(ranked[3].finalDisposition).toBe("bench");
    expect(ranked[3].finalReasons.join(" ")).toMatch(/beyond top-3 .* demoted to bench/);
  });

  it("breaks relevance ties by higher confidence", () => {
    const ranked = rankPassages([
      scored("lo", { relevance: 4, confidence: 0.6 }),
      scored("hi", { relevance: 4, confidence: 0.95 }),
    ]);
    expect(ranked.map((r) => r.id)).toEqual(["hi", "lo"]);
  });

  it("coverage: grounded when anything ships, thin when only benches, none when all dropped", () => {
    const g = summarizeCoverage(rankPassages([scored("a", { relevance: 4 })]));
    expect(g.coverage).toBe("grounded");
    const t = summarizeCoverage(rankPassages([scored("b", { relevance: 2 })]));
    expect(t.coverage).toBe("thin");
    const n = summarizeCoverage(rankPassages([scored("c", { relevance: 0 })]));
    expect(n.coverage).toBe("none");
    expect(n.reasons.join(" ")).toMatch(/refuse or retrieve again/);
    for (const c of COVERAGES) expect(COVERAGE_NOTE[c]).toBeTruthy();
  });

  it("top-k = 0 benches every ship", () => {
    const ranked = rankPassages([scored("x", { relevance: 4 })], {
      ...DEFAULT_RERANK_GATES,
      topK: 0,
    });
    expect(ranked[0].finalDisposition).toBe("bench");
  });
});

describe("UC#5 signal validation", () => {
  it("accepts well-formed answers and takes min confidence", () => {
    const s = rerankSignalsFrom({
      relevance: score(2, 0.8),
      grounding: choice("needs-context", 0.55),
      conflict: noul(0.3),
    });
    expect(s).toEqual({
      relevance: 2,
      grounding: "needs-context",
      conflict: 0.3,
      confidence: 0.55,
    });
  });

  it("rejects relevance outside the declared levels", () => {
    expect(() =>
      rerankSignalsFrom({ relevance: score(5), grounding: choice("noise"), conflict: noul(0) }),
    ).toThrow(/relevance .* outside the declared levels/);
    expect(() =>
      rerankSignalsFrom({ relevance: score(-1), grounding: choice("noise"), conflict: noul(0) }),
    ).toThrow(/relevance .* outside the declared levels/);
  });

  it("rejects grounding outside the set, and a missing or non-noul conflict", () => {
    expect(() =>
      rerankSignalsFrom({ relevance: score(2), grounding: choice("sparkly"), conflict: noul(0) }),
    ).toThrow(/grounding .* outside the declared set/);
    expect(() =>
      rerankSignalsFrom({ relevance: score(2), grounding: choice("noise") }),
    ).toThrow(/conflict answer missing/);
    expect(() =>
      rerankSignalsFrom({ relevance: score(2), grounding: choice("noise"), conflict: choice("yes") }),
    ).toThrow(/conflict answer missing/);
  });
});

describe("UC#5 rerankPassages (live single query)", () => {
  const fakeFn = (async (req: { state: string }) => {
    if (req.state.includes("AAAA")) {
      return fakeResult({ relevance: score(4, 0.95), grounding: choice("self-contained", 0.9), conflict: noul(0.05) });
    }
    if (req.state.includes("BBBB")) {
      return fakeResult({ relevance: score(3, 0.9), grounding: choice("self-contained", 0.9), conflict: noul(0.1) });
    }
    if (req.state.includes("CCCC")) {
      return fakeResult({ relevance: score(2, 0.9), grounding: choice("self-contained", 0.9), conflict: noul(0.1) });
    }
    return fakeResult({ relevance: score(0, 0.9), grounding: choice("noise", 0.9), conflict: noul(0.1) });
  }) as never;

  it("ranks, disposes, and summarizes coverage in code", async () => {
    const r = await rerankPassages(
      "How do I set up SSO?",
      [
        { id: "p4", text: "DDDD off-topic noise." },
        { id: "p1", text: "AAAA direct steps." },
        { id: "p3", text: "CCCC tangential blurb." },
        { id: "p2", text: "BBBB strong guide excerpt." },
      ],
      { classifyFn: fakeFn },
    );
    expect(r.ranked.map((x) => x.id)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(r.ranked.map((x) => x.finalDisposition)).toEqual(["ship", "ship", "bench", "drop"]);
    expect(r.coverage.coverage).toBe("grounded");
    expect(r.usage.input_tokens).toBe(40);
    expect(r.usage.output_tokens).toBe(20);
    expect(r.model).toBe("jev-test");
  });

  it("nothing shipping yields a none/thin coverage the UI can act on", async () => {
    const r = await rerankPassages("How do I set up SSO?", [{ id: "p4", text: "DDDD off-topic." }], {
      classifyFn: fakeFn,
    });
    expect(r.coverage.coverage).toBe("none");
    expect(r.coverage.shipped).toBe(0);
  });
});

describe("UC#5 runRerankBatch (passage ladder 5 → 10 → All)", () => {
  const passages = Array.from({ length: 12 }, (_, i) => ({
    id: `r${i + 1}`,
    text:
      i === 5 ? "stale v1.8 doc snippet" : i === 8 ? "boom gateway error snippet" : "fresh useful snippet",
  }));

  const fakeFn = (async (req: { state: string }) => {
    if (req.state.includes("boom")) throw new Error("gateway down for r9");
    if (req.state.includes("stale")) {
      return fakeResult({ relevance: score(3, 0.9), grounding: choice("self-contained", 0.9), conflict: noul(0.9) });
    }
    return fakeResult({ relevance: score(4, 0.95), grounding: choice("self-contained", 0.9), conflict: noul(0.05) });
  }) as never;

  it("processes the first ladder rung by default", async () => {
    const report = await runRerankBatch("Q?", passages, { classifyFn: fakeFn });
    expect(report.totals.passages).toBe(5);
    expect(report.items).toHaveLength(5);
  });

  it("limit null processes All and errors are isolated per passage", async () => {
    const report = await runRerankBatch("Q?", passages, { classifyFn: fakeFn, limit: null });
    expect(report.totals.passages).toBe(12);
    expect(report.totals.errors).toBe(1);
    const failed = report.items.find((x) => x.error);
    expect(failed?.id).toBe("r9");
    // top-k 3 ships; the stale one is dropped; the rest are benched
    expect(report.totals.shipped).toBe(3);
    expect(report.totals.dropped).toBe(1);
    expect(report.totals.benched).toBe(7);
    expect(report.totals.coverage).toBe("grounded");
    expect(report.items[0].disposition).toBe("ship");
    expect(report.items[report.items.length - 1].id).toBe("r9");
    expect(report.totals.usage.input_tokens).toBe(110);
  });

  it("widen to 10 keeps the ladder discipline", async () => {
    const report = await runRerankBatch("Q?", passages, { classifyFn: fakeFn, limit: 10 });
    expect(report.totals.passages).toBe(10);
    expect(report.totals.errors).toBe(1);
    expect(report.items.filter((x) => !x.error)).toHaveLength(9);
  });
});
