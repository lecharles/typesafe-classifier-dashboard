import { describe, it, expect } from "vitest";
import {
  CITATION_VERDICTS,
  CITATION_VERDICT_RANK,
  DEFAULT_CITATION_GATES,
  SPECIFICITY_LEVELS,
  SUPPORTS,
  SUPPORT_FLOORS,
  citationBadgeClass,
  citationQuestions,
  citationSignalsFrom,
  citationState,
  checkCitation,
  decideCitationVerdict,
  normalizeCitationGates,
  runCitationsBatch,
  worstCitationVerdict,
  type CitationSignals,
} from "@/lib/citations";
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

const sig = (over: Partial<CitationSignals> = {}): CitationSignals => ({
  support: "supports",
  specificity: 2,
  fabrication: 0.05,
  confidence: 0.9,
  ...over,
});

describe("UC#4 verdict ladder + questions", () => {
  it("verdicts are strictly ordered pass < review < flag", () => {
    expect(CITATION_VERDICTS).toEqual(["pass", "review", "flag"]);
    expect(CITATION_VERDICT_RANK.pass).toBeLessThan(CITATION_VERDICT_RANK.review);
    expect(CITATION_VERDICT_RANK.review).toBeLessThan(CITATION_VERDICT_RANK.flag);
    expect(citationBadgeClass("pass")).toBe("good");
    expect(citationBadgeClass("review")).toBe("warn");
    expect(citationBadgeClass("flag")).toBe("bad");
  });

  it("worstCitationVerdict takes the highest rank and ignores undefined", () => {
    expect(worstCitationVerdict(["pass", undefined, "review"])).toBe("review");
    expect(worstCitationVerdict(["review", "flag"])).toBe("flag");
    expect(worstCitationVerdict([])).toBe("pass");
  });

  it("asks support (choice), specificity (score), fabricated (noul)", () => {
    const qs = citationQuestions();
    expect(Object.keys(qs).sort()).toEqual(["fabricated", "specificity", "support"]);
    expect(qs.support.type).toBe("choice");
    if (qs.support.type === "choice") {
      expect(Object.keys(qs.support.criteria).sort()).toEqual([...SUPPORTS].sort());
    }
    expect(qs.specificity.type).toBe("score");
    if (qs.specificity.type === "score") {
      expect(qs.specificity.criteria).toEqual(SPECIFICITY_LEVELS);
    }
    expect(qs.fabricated.type).toBe("noul");
  });

  it("every declared support level has a valid floor", () => {
    for (const s of SUPPORTS) {
      expect(CITATION_VERDICTS).toContain(SUPPORT_FLOORS[s]);
    }
    expect(SUPPORT_FLOORS.contradicts).toBe("flag");
    expect(SUPPORT_FLOORS.irrelevant).toBe("flag");
    expect(SUPPORT_FLOORS.partial).toBe("review");
  });

  it("state labels claim and quote plainly", () => {
    expect(citationState("A claim.", "A quote.")).toBe(
      'CLAIM: A claim.\nQUOTE: "A quote."',
    );
  });
});

describe("UC#4 decideCitationVerdict (checking in code)", () => {
  it("a supporting, specific, genuine quote passes", () => {
    const d = decideCitationVerdict(sig());
    expect(d.verdict).toBe("pass");
    expect(d.reasons[d.reasons.length - 1]).toBe(
      "citation verdict: pass (citation holds)",
    );
  });

  it("support floors never drop: partial reviews, contradicts/irrelevant flag even at exact wording", () => {
    expect(decideCitationVerdict(sig({ support: "partial", specificity: 3 })).verdict).toBe("review");
    expect(decideCitationVerdict(sig({ support: "contradicts", specificity: 3 })).verdict).toBe("flag");
    expect(decideCitationVerdict(sig({ support: "irrelevant", specificity: 3 })).verdict).toBe("flag");
  });

  it("specificity gate: a vague quote cannot carry a precise claim", () => {
    expect(decideCitationVerdict(sig({ specificity: 1 })).verdict).toBe("review");
    expect(
      decideCitationVerdict(sig({ specificity: 1 })).reasons.join(" "),
    ).toMatch(/a vague quote cannot carry a precise claim/);
    // boundary inclusive at the gate
    expect(decideCitationVerdict(sig({ specificity: DEFAULT_CITATION_GATES.specificAt })).verdict).toBe("pass");
    // only applies to "supports" — partial is already floored at review
    expect(decideCitationVerdict(sig({ support: "partial", specificity: 0 })).verdict).toBe("review");
  });

  it("fabrication ladder: review at fabricationReviewAt, flag at fabricationFlagAt", () => {
    expect(
      decideCitationVerdict(sig({ fabrication: DEFAULT_CITATION_GATES.fabricationReviewAt })).verdict,
    ).toBe("review");
    expect(
      decideCitationVerdict(sig({ fabrication: DEFAULT_CITATION_GATES.fabricationFlagAt - 0.01 })).verdict,
    ).toBe("review");
    expect(
      decideCitationVerdict(sig({ fabrication: DEFAULT_CITATION_GATES.fabricationFlagAt })).verdict,
    ).toBe("flag");
    // fabrication overrides even a supporting exact quote
    const d = decideCitationVerdict(sig({ specificity: 3, fabrication: 0.9 }));
    expect(d.verdict).toBe("flag");
    expect(d.reasons.join(" ")).toMatch(/broken citation/);
  });

  it("low confidence raises exactly one rung, capped at flag", () => {
    expect(decideCitationVerdict(sig({ confidence: 0.4 })).verdict).toBe("review");
    expect(decideCitationVerdict(sig({ support: "partial", confidence: 0.4 })).verdict).toBe("flag");
    expect(decideCitationVerdict(sig({ support: "contradicts", confidence: 0.1 })).verdict).toBe("flag");
    expect(decideCitationVerdict(sig({ confidence: DEFAULT_CITATION_GATES.lowConfBump })).verdict).toBe("pass");
  });

  it("honors custom gates", () => {
    const loose = { ...DEFAULT_CITATION_GATES, specificAt: 0 };
    expect(decideCitationVerdict(sig({ specificity: 1 }), loose).verdict).toBe("pass");
    const trusting = { ...DEFAULT_CITATION_GATES, fabricationFlagAt: 0.95 };
    expect(decideCitationVerdict(sig({ fabrication: 0.9 }), trusting).verdict).toBe("review");
  });

  it("normalizeCitationGates merges partial slider values over defaults", () => {
    expect(normalizeCitationGates()).toEqual(DEFAULT_CITATION_GATES);
    expect(normalizeCitationGates({ specificAt: 3, lowConfBump: 0.2 })).toEqual({
      ...DEFAULT_CITATION_GATES,
      specificAt: 3,
      lowConfBump: 0.2,
    });
  });
});

describe("UC#4 signal validation", () => {
  it("accepts well-formed answers and takes min confidence", () => {
    const s = citationSignalsFrom({
      support: choice("partial", 0.7),
      specificity: score(1, 0.55),
      fabricated: noul(0.2),
    });
    expect(s).toEqual({
      support: "partial",
      specificity: 1,
      fabrication: 0.2,
      confidence: 0.55,
    });
  });

  it("rejects support outside the declared set", () => {
    expect(() =>
      citationSignalsFrom({
        support: choice("probably_fine"),
        specificity: score(2),
        fabricated: noul(0),
      }),
    ).toThrow(/support .* outside the declared set/);
  });

  it("rejects specificity outside the levels or malformed", () => {
    expect(() =>
      citationSignalsFrom({ support: choice("supports"), specificity: score(4), fabricated: noul(0) }),
    ).toThrow(/specificity .* outside the declared levels/);
    expect(() =>
      citationSignalsFrom({ support: choice("supports"), specificity: score(-1), fabricated: noul(0) }),
    ).toThrow(/specificity .* outside the declared levels/);
    expect(() =>
      citationSignalsFrom({
        support: choice("supports"),
        specificity: { type: "choice", choice: "x", probabilities: {}, confidence: 1 } as Answer,
        fabricated: noul(0),
      }),
    ).toThrow(/specificity .* outside the declared levels/);
  });

  it("rejects a missing or non-noul fabricated answer", () => {
    expect(() =>
      citationSignalsFrom({ support: choice("supports"), specificity: score(2) }),
    ).toThrow(/fabricated answer missing/);
    expect(() =>
      citationSignalsFrom({
        support: choice("supports"),
        specificity: score(2),
        fabricated: choice("yes"),
      }),
    ).toThrow(/fabricated answer missing/);
  });
});

describe("UC#4 checkCitation (live single check)", () => {
  const goodAnswers = {
    support: choice("supports", 0.95),
    specificity: score(3, 0.9),
    fabricated: noul(0.05),
  };

  it("passes the verdict through from typed answers", async () => {
    const classifyFn = (async () => fakeResult(goodAnswers)) as never;
    const r = await checkCitation(
      "The Enterprise plan includes SSO with Okta.",
      "Enterprise supports SAML and OIDC single sign-on, including Okta.",
      { classifyFn },
    );
    expect(r.decision.verdict).toBe("pass");
    expect(r.signals.support).toBe("supports");
    expect(r.model).toBe("jev-test");
    expect(r.provider).toBe("gateway");
    expect(r.usage.input_tokens).toBe(10);
  });

  it("a malformed answer aborts the single check (hard error, not a shrug)", async () => {
    const classifyFn = (async () =>
      fakeResult({ support: choice("maybe"), specificity: score(2), fabricated: noul(0) })) as never;
    await expect(
      checkCitation("claim", "quote", { classifyFn }),
    ).rejects.toThrow(/outside the declared set/);
  });
});

describe("UC#4 runCitationsBatch (5 → 10 → All)", () => {
  const items = Array.from({ length: 12 }, (_, i) => ({
    id: `k${i + 1}`,
    claim: `claim ${i + 1}`,
    quote: `quote ${i + 1}`,
  }));

  const fakeFn = (async (req: { state: string }) => {
    if (req.state.includes("claim 7")) {
      throw new Error("gateway down for k7");
    }
    if (req.state.includes("claim 3")) {
      return fakeResult({
        support: choice("contradicts", 0.9),
        specificity: score(2, 0.9),
        fabricated: noul(0.1),
      });
    }
    return fakeResult({
      support: choice("supports", 0.9),
      specificity: score(2, 0.9),
      fabricated: noul(0.1),
    });
  }) as never;

  it("processes the first ladder rung by default", async () => {
    const report = await runCitationsBatch(items, { classifyFn: fakeFn });
    expect(report.totals.items).toBe(5);
    expect(report.items).toHaveLength(5);
  });

  it("limit null processes All", async () => {
    const report = await runCitationsBatch(items, { classifyFn: fakeFn, limit: null });
    expect(report.totals.items).toBe(12);
    expect(report.items).toHaveLength(12);
  });

  it("totals tally verdicts and isolate per-item errors", async () => {
    const report = await runCitationsBatch(items, { classifyFn: fakeFn, limit: null });
    expect(report.totals.errors).toBe(1);
    const failed = report.items.find((x) => x.error);
    expect(failed?.id).toBe("k7");
    expect(report.totals.verdicts.flag).toBe(1);
    expect(report.totals.verdicts.pass).toBe(10);
    expect(report.totals.checksRun).toBe(11);
    expect(report.totals.usage.input_tokens).toBe(110);
    expect(report.model).toBe("jev-test");
  });

  it("custom gates flow through the batch", async () => {
    const report = await runCitationsBatch(items.slice(0, 2), {
      classifyFn: fakeFn,
      gates: { specificAt: 3 },
    });
    expect(report.gates.specificAt).toBe(3);
    expect(report.gates.fabricationFlagAt).toBe(DEFAULT_CITATION_GATES.fabricationFlagAt);
  });
});
