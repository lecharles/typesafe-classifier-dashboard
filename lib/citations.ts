import { classify } from "@/lib/classify";
import { BATCH_LADDER } from "@/lib/dispatch";
import type { ClassifyResult, Provider, Question, Usage } from "@/lib/schema";

/**
 * UC#4 (11-13 calendar row, shipped 11-12 one day ahead): citation checker.
 *
 * Does the quote actually support the claim? The three Jev primitives split
 * the question:
 *
 *   support      → Choice  ("establishes / partial / irrelevant / contradicts")
 *   specificity  → Score   ("vague / generic / specific / exact")
 *   fabricated   → Noul    ("could this quote be missing from the source?")
 *
 * and CODE — never the free model — turns the answers into one of three
 * verdicts: pass (the citation holds), review (a human must eyeball it),
 * flag (broken citation, never ship it). Rule order mirrors the router and
 * guardrails ladders: support floor → specificity gate → fabrication floor
 * → confidence bump. An uncertain check never passes silently, and a vague
 * quote can never carry a precise claim.
 */

/* ------------------------------------------------------------------ *
 * Verdicts.
 * ------------------------------------------------------------------ */

export const CITATION_VERDICTS = ["pass", "review", "flag"] as const;
export type CitationVerdict = (typeof CITATION_VERDICTS)[number];

export const CITATION_VERDICT_RANK: Record<CitationVerdict, number> = {
  pass: 0,
  review: 1,
  flag: 2,
};

export const CITATION_VERDICT_NOTE: Record<CitationVerdict, string> = {
  pass: "citation holds",
  review: "held for a human check",
  flag: "broken citation — never ship",
};

export function citationBadgeClass(v: CitationVerdict): "good" | "warn" | "bad" {
  return v === "pass" ? "good" : v === "review" ? "warn" : "bad";
}

/** Highest-severity verdict wins; undefined entries are ignored. */
export function worstCitationVerdict(vs: (CitationVerdict | undefined)[]): CitationVerdict {
  let worst: CitationVerdict = "pass";
  for (const v of vs) {
    if (v && CITATION_VERDICT_RANK[v] > CITATION_VERDICT_RANK[worst]) worst = v;
  }
  return worst;
}

/* ------------------------------------------------------------------ *
 * The typed questions.
 * ------------------------------------------------------------------ */

export const SUPPORTS = ["supports", "partial", "irrelevant", "contradicts"] as const;
export type Support = (typeof SUPPORTS)[number];

/** Verdicts these support levels can NEVER fall below, whatever the score says. */
export const SUPPORT_FLOORS: Record<Support, CitationVerdict> = {
  supports: "pass",
  partial: "review",
  irrelevant: "flag",
  contradicts: "flag",
};

/** 0 vague … 3 exact. */
export const SPECIFICITY_LEVELS = ["vague", "generic", "specific", "exact"];

export function citationQuestions(): Record<string, Question> {
  return {
    support: {
      type: "choice",
      instructions:
        "Given the CLAIM and the QUOTE in the state, does the quoted passage support the claim as stated?",
      criteria: {
        supports: "the quote establishes the claim it is attached to",
        partial: "the quote touches the claim but leaves its key part unsaid",
        irrelevant: "the quote is about a different subject than the claim",
        contradicts: "the quote states the opposite of, or something incompatible with, the claim",
      },
    },
    specificity: {
      type: "score",
      instructions:
        "How specifically does the quote carry the claim, from vague paraphrase to exact wording?",
      criteria: SPECIFICITY_LEVELS,
    },
    fabricated: {
      type: "noul",
      instructions:
        "Could this quote be fabricated — wording, figures, or attributions that would not actually be found in the cited source?",
      criteria: { true: "the quote may not be genuine", false: "the quote looks genuine" },
    },
  };
}

/** The single state the classifier sees: claim + quote, plainly labelled. */
export function citationState(claim: string, quote: string): string {
  return `CLAIM: ${claim}\nQUOTE: "${quote}"`;
}

/* ------------------------------------------------------------------ *
 * Signals + gates.
 * ------------------------------------------------------------------ */

export type CitationSignals = {
  support: Support;
  /** specificity level index (fractional values allowed, as Jev scores) */
  specificity: number;
  /** probability the quote is fabricated rather than found in the source */
  fabrication: number;
  /** classification confidence: min of the choice/score confidences */
  confidence: number;
};

export type CitationGates = {
  /** specificity level below which a "supports" quote is still only REVIEWed. */
  specificAt: number;
  /** fabrication probability at or above which the citation is at least REVIEWed. */
  fabricationReviewAt: number;
  /** fabrication probability at or above which the citation is FLAGged. */
  fabricationFlagAt: number;
  /** confidence below which the verdict is raised one rung. */
  lowConfBump: number;
};

export const DEFAULT_CITATION_GATES: CitationGates = {
  specificAt: 2,
  fabricationReviewAt: 0.5,
  fabricationFlagAt: 0.8,
  lowConfBump: 0.6,
};

/** Merge partial slider values over the shipped gate defaults. */
export function normalizeCitationGates(partial?: Partial<CitationGates>): CitationGates {
  return { ...DEFAULT_CITATION_GATES, ...(partial ?? {}) };
}

export type CitationDecision = {
  verdict: CitationVerdict;
  reasons: string[];
};

/* ------------------------------------------------------------------ *
 * Answer validation — dispatcher/router discipline: anything outside
 * the declared option set is a hard error, not a shrug.
 * ------------------------------------------------------------------ */

export function citationSignalsFrom(answers: Record<string, unknown>): CitationSignals {
  const support = answers.support as
    | { type?: string; choice?: string; confidence?: number }
    | undefined;
  if (
    support?.type !== "choice" ||
    !SUPPORTS.includes(support.choice as Support)
  ) {
    throw new Error(
      `citations: support "${String(support?.choice)}" is outside the declared set`,
    );
  }
  const spec = answers.specificity as
    | { type?: string; score?: number; confidence?: number }
    | undefined;
  if (
    spec?.type !== "score" ||
    typeof spec.score !== "number" ||
    !Number.isFinite(spec.score) ||
    spec.score < 0 ||
    spec.score >= SPECIFICITY_LEVELS.length
  ) {
    throw new Error("citations: specificity score is outside the declared levels");
  }
  const fab = answers.fabricated as { type?: string; noul?: number } | undefined;
  if (fab?.type !== "noul" || typeof fab.noul !== "number") {
    throw new Error("citations: fabricated answer missing or not a noul");
  }
  return {
    support: support.choice as Support,
    specificity: spec.score,
    fabrication: fab.noul,
    confidence: Math.min(support.confidence ?? 0, spec.confidence ?? 0),
  };
}

/* ------------------------------------------------------------------ *
 * Pure in-code verdict ladder.
 * ------------------------------------------------------------------ */

export function decideCitationVerdict(
  s: CitationSignals,
  gates: CitationGates = DEFAULT_CITATION_GATES,
): CitationDecision {
  const reasons: string[] = [];
  let rank = CITATION_VERDICT_RANK[SUPPORT_FLOORS[s.support]];
  if (SUPPORT_FLOORS[s.support] !== "pass") {
    reasons.push(
      `support=${s.support} carries a floor of ${SUPPORT_FLOORS[s.support]} — it can never drop below that`,
    );
  }
  if (s.support === "supports" && s.specificity < gates.specificAt) {
    const level = SPECIFICITY_LEVELS[Math.floor(s.specificity)] ?? "vague";
    reasons.push(
      `quote is only "${level}" (level ${s.specificity.toFixed(1)}) below specificity gate ${gates.specificAt} — a vague quote cannot carry a precise claim`,
    );
    rank = Math.max(rank, 1);
  }
  if (s.fabrication >= gates.fabricationFlagAt) {
    reasons.push(
      `fabrication probability ${s.fabrication.toFixed(2)} ≥ ${gates.fabricationFlagAt.toFixed(2)} — a quote that may not exist in the source is a broken citation`,
    );
    rank = Math.max(rank, 2);
  } else if (s.fabrication >= gates.fabricationReviewAt) {
    reasons.push(
      `fabrication probability ${s.fabrication.toFixed(2)} ≥ ${gates.fabricationReviewAt.toFixed(2)} — at least a human look`,
    );
    rank = Math.max(rank, 1);
  }
  if (s.confidence < gates.lowConfBump) {
    reasons.push(
      `check confidence ${s.confidence.toFixed(2)} below ${gates.lowConfBump.toFixed(2)} — raised one rung; an uncertain citation never passes silently`,
    );
    rank += 1;
  }
  const verdict = CITATION_VERDICTS[Math.min(Math.max(0, rank), CITATION_VERDICTS.length - 1)];
  reasons.push(`citation verdict: ${verdict} (${CITATION_VERDICT_NOTE[verdict]})`);
  return { verdict, reasons };
}

/* ------------------------------------------------------------------ *
 * Live single check.
 * ------------------------------------------------------------------ */

export type CitationCheck = {
  claim: string;
  quote: string;
  signals: CitationSignals;
  decision: CitationDecision;
  gates: CitationGates;
  model: string;
  provider: Provider;
  usage: Usage;
  trace?: ClassifyResult["trace"];
};

export type CitationCheckOptions = {
  classifyFn?: typeof classify;
  gates?: CitationGates;
  trace?: boolean;
};

export async function checkCitation(
  claim: string,
  quote: string,
  opts: CitationCheckOptions = {},
): Promise<CitationCheck> {
  const run = opts.classifyFn ?? classify;
  const gates = opts.gates ?? DEFAULT_CITATION_GATES;
  const res: ClassifyResult = await run(
    { state: citationState(claim, quote), questions: citationQuestions() },
    opts.trace ? { trace: true } : {},
  );
  const signals = citationSignalsFrom(res.answers);
  return {
    claim,
    quote,
    signals,
    decision: decideCitationVerdict(signals, gates),
    gates,
    model: res.model,
    provider: res.provider,
    usage: res.usage,
    ...(res.trace ? { trace: res.trace } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Batched checking with the lane's 5 → 10 → All discipline.
 * ------------------------------------------------------------------ */

export type ClaimItem = { id: string; claim: string; quote: string };

export type ClaimReport = {
  id: string;
  claim: string;
  quote: string;
  verdict?: CitationVerdict;
  signals?: CitationSignals;
  usage?: Usage;
  error?: string;
};

export type CitationTotals = {
  items: number;
  errors: number;
  checksRun: number;
  verdicts: Record<CitationVerdict, number>;
  usage: Usage;
};

export type CitationBatchReport = {
  items: ClaimReport[];
  totals: CitationTotals;
  gates: CitationGates;
  model: string;
  provider: Provider;
};

export type RunCitationsBatchOptions = {
  classifyFn?: typeof classify;
  gates?: Partial<CitationGates>;
  /** Cap on items processed; null = All. Default 5 (first ladder rung). */
  limit?: number | null;
  concurrency?: number;
};

/**
 * Check many claim/quote pairs at once. A failure on one item is isolated
 * to that item's report and never aborts the batch (same contract as the
 * router and guardrails batches).
 */
export async function runCitationsBatch(
  items: ClaimItem[],
  opts: RunCitationsBatchOptions = {},
): Promise<CitationBatchReport> {
  const run = opts.classifyFn ?? classify;
  const gates = normalizeCitationGates(opts.gates);
  const limit =
    opts.limit === null ? items.length : (opts.limit ?? BATCH_LADDER[0]);
  const scoped = items.slice(0, Math.max(0, Math.min(limit, items.length)));
  const concurrency = Math.min(
    Math.max(1, opts.concurrency ?? 3),
    scoped.length || 1,
  );

  const reports: (ClaimReport | undefined)[] = new Array(scoped.length);
  let cursor = 0;
  let classifierModel = "";
  let classifierProvider: Provider = "gateway";

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= scoped.length) return;
      const item = scoped[i];
      const report: ClaimReport = { id: item.id, claim: item.claim, quote: item.quote };
      try {
        const check = await checkCitation(item.claim, item.quote, {
          classifyFn: run,
          gates,
        });
        report.verdict = check.decision.verdict;
        report.signals = check.signals;
        report.usage = check.usage;
        classifierModel = check.model;
        classifierProvider = check.provider;
      } catch (err) {
        report.error = err instanceof Error ? err.message : "citation check failed";
      }
      reports[i] = report;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const verdicts: Record<CitationVerdict, number> = { pass: 0, review: 0, flag: 0 };
  const totals: CitationTotals = {
    items: scoped.length,
    errors: 0,
    checksRun: 0,
    verdicts,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  for (const r of reports.filter((x): x is ClaimReport => !!x)) {
    if (r.error) {
      totals.errors += 1;
      continue;
    }
    if (r.verdict) {
      totals.verdicts[r.verdict] += 1;
      totals.checksRun += 1;
    }
    if (r.usage) {
      totals.usage.input_tokens += r.usage.input_tokens;
      totals.usage.output_tokens += r.usage.output_tokens;
    }
  }

  return {
    items: reports.filter((x): x is ClaimReport => !!x),
    totals,
    gates,
    model: classifierModel,
    provider: classifierProvider,
  };
}
