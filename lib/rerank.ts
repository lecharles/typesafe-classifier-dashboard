import { classify } from "@/lib/classify";
import { BATCH_LADDER } from "@/lib/dispatch";
import type { ClassifyResult, Provider, Question, Usage } from "@/lib/schema";

/**
 * UC#5 (11-13 calendar row, shipped 11-12 one day ahead): RAG passage
 * re-ranker — score retrieved passages and pick, IN CODE, what reaches
 * the answering model.
 *
 * Every candidate passage is scored with the three Jev primitives:
 *
 *   relevance → Score  (off-topic / tangential / related / strong / direct)
 *   grounding → Choice (self-contained / needs-context / noise)
 *   conflict  → Noul   (probability the passage is stale or contradicts facts)
 *
 * and CODE assigns each passage a disposition — ship (reaches the model),
 * bench (fallback only), drop (never sent) — walking the lane's ladder:
 * relevance rungs → grounding cap → conflict floor → confidence bump, then
 * a top-k demotion so the context budget stays finite. An uncertain
 * retrieval never ships silently, and if nothing ships the dashboard says
 * so: refuse or retrieve again.
 */

/* ------------------------------------------------------------------ *
 * Dispositions.
 * ------------------------------------------------------------------ */

export const DISPOSITIONS = ["ship", "bench", "drop"] as const;
export type PassageDisposition = (typeof DISPOSITIONS)[number];

export const DISPOSITION_RANK: Record<PassageDisposition, number> = {
  ship: 0,
  bench: 1,
  drop: 2,
};

export const DISPOSITION_NOTE: Record<PassageDisposition, string> = {
  ship: "reaches the answering model",
  bench: "held as fallback only",
  drop: "never reaches the model",
};

export function dispositionBadgeClass(d: PassageDisposition): "good" | "warn" | "bad" {
  return d === "ship" ? "good" : d === "bench" ? "warn" : "bad";
}

/* ------------------------------------------------------------------ *
 * The typed questions.
 * ------------------------------------------------------------------ */

export const RELEVANCE_LEVELS = ["off-topic", "tangential", "related", "strong", "direct"];

export const GROUNDINGS = ["self-contained", "needs-context", "noise"] as const;
export type Grounding = (typeof GROUNDINGS)[number];

export function rerankQuestions(query: string): Record<string, Question> {
  return {
    relevance: {
      type: "score",
      instructions: `How relevant is the PASSAGE to answering the QUERY: "${query}"?`,
      criteria: RELEVANCE_LEVELS,
    },
    grounding: {
      type: "choice",
      instructions:
        "Judging the passage on its own, can it be handed to an answering model as retrieval context?",
      criteria: {
        "self-contained": "states usable facts with enough context to use them",
        "needs-context": "useful but relies on other passages to make sense",
        noise: "carries no usable information for this query",
      },
    },
    conflict: {
      type: "noul",
      instructions:
        "Does the passage look outdated, or in conflict with what currently holds — old versions, deprecated behavior, contradicted facts?",
      criteria: { true: "stale or conflicting", false: "current and consistent" },
    },
  };
}

/** The single state the classifier sees: query + passage, plainly labelled. */
export function rerankState(query: string, text: string): string {
  return `QUERY: ${query}\nPASSAGE: "${text}"`;
}

/* ------------------------------------------------------------------ *
 * Signals + gates.
 * ------------------------------------------------------------------ */

export type RerankSignals = {
  /** relevance level index (fractional values allowed, as Jev scores) */
  relevance: number;
  grounding: Grounding;
  /** probability the passage is stale or conflicting */
  conflict: number;
  /** classification confidence: min of the score/choice confidences */
  confidence: number;
};

export type RerankGates = {
  /** relevance level at or above which a passage may ship. */
  shipAt: number;
  /** relevance level at or above which a passage may at least bench. */
  benchAt: number;
  /** conflict probability at or above which a passage cannot ship. */
  conflictBenchAt: number;
  /** conflict probability at or above which the passage is dropped. */
  conflictDropAt: number;
  /** confidence below which the disposition is raised one rung. */
  lowConfBump: number;
  /** at most this many passages ship; the overflow is benched. */
  topK: number;
};

export const DEFAULT_RERANK_GATES: RerankGates = {
  shipAt: 3,
  benchAt: 2,
  conflictBenchAt: 0.5,
  conflictDropAt: 0.8,
  lowConfBump: 0.55,
  topK: 3,
};

/** Merge partial slider values over the shipped gate defaults. */
export function normalizeRerankGates(partial?: Partial<RerankGates>): RerankGates {
  return { ...DEFAULT_RERANK_GATES, ...(partial ?? {}) };
}

/* ------------------------------------------------------------------ *
 * Answer validation — dispatcher/router discipline: anything outside
 * the declared option set is a hard error, not a shrug.
 * ------------------------------------------------------------------ */

export function rerankSignalsFrom(answers: Record<string, unknown>): RerankSignals {
  const rel = answers.relevance as
    | { type?: string; score?: number; confidence?: number }
    | undefined;
  if (
    rel?.type !== "score" ||
    typeof rel.score !== "number" ||
    !Number.isFinite(rel.score) ||
    rel.score < 0 ||
    rel.score >= RELEVANCE_LEVELS.length
  ) {
    throw new Error("rerank: relevance score is outside the declared levels");
  }
  const g = answers.grounding as
    | { type?: string; choice?: string; confidence?: number }
    | undefined;
  if (g?.type !== "choice" || !GROUNDINGS.includes(g.choice as Grounding)) {
    throw new Error(
      `rerank: grounding "${String(g?.choice)}" is outside the declared set`,
    );
  }
  const c = answers.conflict as { type?: string; noul?: number } | undefined;
  if (c?.type !== "noul" || typeof c.noul !== "number") {
    throw new Error("rerank: conflict answer missing or not a noul");
  }
  return {
    relevance: rel.score,
    grounding: g.choice as Grounding,
    conflict: c.noul,
    confidence: Math.min(rel.confidence ?? 0, g.confidence ?? 0),
  };
}

/* ------------------------------------------------------------------ *
 * Pure in-code disposition ladder.
 * ------------------------------------------------------------------ */

export type DispositionDecision = {
  disposition: PassageDisposition;
  reasons: string[];
};

export function decidePassage(
  s: RerankSignals,
  gates: RerankGates = DEFAULT_RERANK_GATES,
): DispositionDecision {
  const reasons: string[] = [];
  let rank: number;
  if (s.relevance >= gates.shipAt) {
    reasons.push(
      `relevance ${s.relevance.toFixed(1)} ("${RELEVANCE_LEVELS[Math.min(4, Math.floor(s.relevance))] ?? "?"}") ≥ ship gate ${gates.shipAt} — ships on the ladder`,
    );
    rank = DISPOSITION_RANK.ship;
  } else if (s.relevance >= gates.benchAt) {
    reasons.push(
      `relevance ${s.relevance.toFixed(1)} ≥ bench gate ${gates.benchAt} but below ship gate ${gates.shipAt} — benched as fallback`,
    );
    rank = DISPOSITION_RANK.bench;
  } else {
    reasons.push(
      `relevance ${s.relevance.toFixed(1)} below bench gate ${gates.benchAt} — dropped`,
    );
    rank = DISPOSITION_RANK.drop;
  }
  if (s.grounding === "noise") {
    reasons.push("grounding=noise — the passage carries nothing the model can use");
    rank = DISPOSITION_RANK.drop;
  } else if (s.grounding === "needs-context" && rank < DISPOSITION_RANK.bench) {
    reasons.push("grounding=needs-context — cannot carry the answer alone, capped at bench");
    rank = DISPOSITION_RANK.bench;
  }
  if (s.conflict >= gates.conflictDropAt) {
    reasons.push(
      `conflict probability ${s.conflict.toFixed(2)} ≥ ${gates.conflictDropAt.toFixed(2)} — a stale or contradicted passage never reaches the model`,
    );
    rank = DISPOSITION_RANK.drop;
  } else if (s.conflict >= gates.conflictBenchAt && rank < DISPOSITION_RANK.bench) {
    reasons.push(
      `conflict probability ${s.conflict.toFixed(2)} ≥ ${gates.conflictBenchAt.toFixed(2)} — cannot ship unverified, benched`,
    );
    rank = DISPOSITION_RANK.bench;
  }
  if (s.confidence < gates.lowConfBump) {
    reasons.push(
      `passage confidence ${s.confidence.toFixed(2)} below ${gates.lowConfBump.toFixed(2)} — raised one rung; an uncertain retrieval never ships silently`,
    );
    rank += 1;
  }
  rank = Math.min(Math.max(0, rank), DISPOSITION_RANK.drop);
  const disposition = DISPOSITIONS[rank];
  reasons.push(`passage disposition: ${disposition} (${DISPOSITION_NOTE[disposition]})`);
  return { disposition, reasons };
}

/* ------------------------------------------------------------------ *
 * Ranking + top-k demotion + coverage — all in code.
 * ------------------------------------------------------------------ */

export type ScoredPassage = {
  id: string;
  text: string;
  signals: RerankSignals;
  decision: DispositionDecision;
};

export type RankedPassage = ScoredPassage & {
  /** final disposition after the top-k demotion. */
  finalDisposition: PassageDisposition;
  finalReasons: string[];
};

/**
 * Best-relevance-first order (ties: higher confidence first), then a
 * top-k cut: the (k+1)-th ship and beyond are demoted to bench, because
 * retrieval context is a scarce budget.
 */
export function rankPassages(
  scored: ScoredPassage[],
  gates: RerankGates = DEFAULT_RERANK_GATES,
): RankedPassage[] {
  const sorted = [...scored].sort(
    (a, b) =>
      b.signals.relevance - a.signals.relevance ||
      b.signals.confidence - a.signals.confidence,
  );
  let shipped = 0;
  return sorted.map((p) => {
    let finalDisposition = p.decision.disposition;
    const finalReasons = [...p.decision.reasons];
    if (finalDisposition === "ship") {
      shipped += 1;
      if (shipped > gates.topK) {
        finalDisposition = "bench";
        finalReasons.push(
          `beyond top-${gates.topK} (this was ship #${shipped}) — demoted to bench; the context budget is finite`,
        );
      }
    }
    return { ...p, finalDisposition, finalReasons };
  });
}

export const COVERAGES = ["grounded", "thin", "none"] as const;
export type Coverage = (typeof COVERAGES)[number];

export const COVERAGE_NOTE: Record<Coverage, string> = {
  grounded: "shipping passages exist — the answer can cite real retrieval",
  thin: "no passage ships outright — answer carefully or not at all",
  none: "no grounding — the model should refuse or retrieve again",
};

export type CoverageSummary = {
  coverage: Coverage;
  shipped: number;
  benched: number;
  dropped: number;
  reasons: string[];
};

export function summarizeCoverage(ranked: RankedPassage[]): CoverageSummary {
  const shipped = ranked.filter((r) => r.finalDisposition === "ship").length;
  const benched = ranked.filter((r) => r.finalDisposition === "bench").length;
  const dropped = ranked.filter((r) => r.finalDisposition === "drop").length;
  const reasons: string[] = [];
  let coverage: Coverage;
  if (shipped > 0) {
    coverage = "grounded";
    reasons.push(`${shipped} passage(s) ship — grounded answer is possible`);
  } else if (benched > 0) {
    coverage = "thin";
    reasons.push(`${benched} benched passage(s) only — no clean grounding`);
  } else {
    coverage = "none";
    reasons.push("nothing reaches the model — refuse or retrieve again");
  }
  return { coverage, shipped, benched, dropped, reasons };
}

/* ------------------------------------------------------------------ *
 * Live single query.
 * ------------------------------------------------------------------ */

export type Passage = { id: string; text: string };

export type RerankResult = {
  query: string;
  ranked: RankedPassage[];
  coverage: CoverageSummary;
  gates: RerankGates;
  model: string;
  provider: Provider;
  usage: Usage;
  trace?: Record<string, unknown>;
};

export type RerankOptions = {
  classifyFn?: typeof classify;
  gates?: RerankGates;
  trace?: boolean;
};

function addUsage(a: Usage, b: Usage): Usage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
  };
}

export async function scorePassage(
  query: string,
  p: Passage,
  run: typeof classify,
  gates: RerankGates,
  trace?: boolean,
): Promise<{ scored: ScoredPassage; usage: Usage; model: string; provider: Provider; wire?: unknown }> {
  const res: ClassifyResult = await run(
    { state: rerankState(query, p.text), questions: rerankQuestions(query) },
    trace ? { trace: true } : {},
  );
  const signals = rerankSignalsFrom(res.answers);
  const scored: ScoredPassage = {
    id: p.id,
    text: p.text,
    signals,
    decision: decidePassage(signals, gates),
  };
  return {
    scored,
    usage: res.usage,
    model: res.model,
    provider: res.provider,
    ...(res.trace ? { wire: res.trace } : {}),
  };
}

/**
 * Rerank every passage for one query. Each passage is its own typed
 * classification; the ranking, top-k cut, and coverage are computed in
 * code. A failure here aborts (this is the interactive path); the batch
 * path isolates failures per passage.
 */
export async function rerankPassages(
  query: string,
  passages: Passage[],
  opts: RerankOptions = {},
): Promise<RerankResult> {
  const run = opts.classifyFn ?? classify;
  const gates = opts.gates ?? DEFAULT_RERANK_GATES;
  let usage: Usage = { input_tokens: 0, output_tokens: 0 };
  let model = "";
  let provider: Provider = "gateway";
  const trace: Record<string, unknown> | undefined = opts.trace ? {} : undefined;
  const scored: ScoredPassage[] = [];
  for (const p of passages) {
    const s = await scorePassage(query, p, run, gates, opts.trace);
    scored.push(s.scored);
    usage = addUsage(usage, s.usage);
    model = s.model;
    provider = s.provider;
    if (trace && s.wire) trace[s.scored.id] = s.wire;
  }
  const ranked = rankPassages(scored, gates);
  return {
    query,
    ranked,
    coverage: summarizeCoverage(ranked),
    gates,
    model,
    provider,
    usage,
    ...(trace ? { trace } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Batched reranking with the lane's 5 → 10 → All discipline. The unit
 * of the ladder here is the PASSAGE: score the first 5, widen to 10,
 * then All — exactly the discipline every other dashboard uses.
 * ------------------------------------------------------------------ */

export type RerankBatchItem = {
  id: string;
  text: string;
  signals?: RerankSignals;
  disposition?: PassageDisposition;
  reasons?: string[];
  usage?: Usage;
  error?: string;
};

export type RerankTotals = {
  passages: number;
  errors: number;
  shipped: number;
  benched: number;
  dropped: number;
  coverage: Coverage;
  usage: Usage;
};

export type RerankBatchReport = {
  query: string;
  items: RerankBatchItem[];
  totals: RerankTotals;
  gates: RerankGates;
  model: string;
  provider: Provider;
};

export type RunRerankBatchOptions = {
  classifyFn?: typeof classify;
  gates?: Partial<RerankGates>;
  /** Cap on passages processed; null = All. Default 5 (first ladder rung). */
  limit?: number | null;
  concurrency?: number;
};

/**
 * Rerank a corpus of passages for one query. A failure on one passage is
 * isolated to that passage's report and never aborts the batch (same
 * contract as the router and guardrails batches).
 */
export async function runRerankBatch(
  query: string,
  passages: Passage[],
  opts: RunRerankBatchOptions = {},
): Promise<RerankBatchReport> {
  const run = opts.classifyFn ?? classify;
  const gates = normalizeRerankGates(opts.gates);
  const limit =
    opts.limit === null ? passages.length : (opts.limit ?? BATCH_LADDER[0]);
  const scoped = passages.slice(0, Math.max(0, Math.min(limit, passages.length)));
  const concurrency = Math.min(
    Math.max(1, opts.concurrency ?? 3),
    scoped.length || 1,
  );

  const reports: (RerankBatchItem | undefined)[] = new Array(scoped.length);
  const scoredOk: ScoredPassage[] = [];
  const usageOf: Record<string, Usage> = {};
  let cursor = 0;
  let classifierModel = "";
  let classifierProvider: Provider = "gateway";

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= scoped.length) return;
      const p = scoped[i];
      const report: RerankBatchItem = { id: p.id, text: p.text };
      try {
        const s = await scorePassage(query, p, run, gates);
        report.signals = s.scored.signals;
        report.usage = s.usage;
        classifierModel = s.model;
        classifierProvider = s.provider;
        scoredOk.push(s.scored);
        usageOf[p.id] = s.usage;
      } catch (err) {
        report.error = err instanceof Error ? err.message : "passage scoring failed";
      }
      reports[i] = report;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // Top-k demotion runs over the scored passages; results are merged back
  // into per-passage reports in ladder order (best first, errors last).
  const ranked = rankPassages(scoredOk, gates);
  const okItems: RerankBatchItem[] = ranked.map((r) => ({
    id: r.id,
    text: r.text,
    signals: r.signals,
    disposition: r.finalDisposition,
    reasons: r.finalReasons,
    usage: usageOf[r.id],
  }));
  const errorItems: RerankBatchItem[] = reports
    .filter((x): x is RerankBatchItem => !!x && !!x.error)
    .map((x) => ({ id: x.id, text: x.text, error: x.error }));

  const summary = summarizeCoverage(ranked);
  const totals: RerankTotals = {
    passages: scoped.length,
    errors: errorItems.length,
    shipped: summary.shipped,
    benched: summary.benched,
    dropped: summary.dropped,
    coverage: summary.coverage,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  for (const r of [...okItems, ...errorItems]) {
    if (r.usage) {
      totals.usage.input_tokens += r.usage.input_tokens;
      totals.usage.output_tokens += r.usage.output_tokens;
    }
  }

  return {
    query,
    items: [...okItems, ...errorItems],
    totals,
    gates,
    model: classifierModel,
    provider: classifierProvider,
  };
}
