import { classify } from "@/lib/classify";
import { BATCH_LADDER } from "@/lib/dispatch";
import type { ClassifyResult, Provider, Question, Usage } from "@/lib/schema";

/**
 * UC#2 (11-11 on the calendar, burned 11-10): model router dashboard.
 *
 * Every inbound request is scored with the three Jev primitives —
 *   intent     → Choice ("what kind of work is this?")
 *   difficulty → Score  (5 ordered levels, trivial..expert)
 *   risk       → Noul   ("irreversible / money / legal / safety?")
 * — and CODE then decides which model actually answers it: cheap, mid, or
 * frontier. High-risk requests never touch a cheap model; low classification
 * confidence raises the tier one step as a safety margin. The dashboard
 * reports the routing mix and the estimated $ saved versus "everything to
 * frontier".
 */

/* ------------------------------------------------------------------ *
 * The tier ladder. Cost figures are illustrative $/1M-token rates for
 * the gateway models on each rung — enough to make savings tangible.
 * ------------------------------------------------------------------ */

export type TierId = "cheap" | "mid" | "frontier";

export type ModelTier = {
  id: TierId;
  label: string;
  model: string;
  /** rung on the ladder: 0 cheap, 1 mid, 2 frontier */
  rank: number;
  inputCostPerMtok: number;
  outputCostPerMtok: number;
};

export const TIERS: ModelTier[] = [
  {
    id: "cheap",
    label: "Cheap / fast",
    model: "amazon/nova-micro",
    rank: 0,
    inputCostPerMtok: 0.06,
    outputCostPerMtok: 0.24,
  },
  {
    id: "mid",
    label: "Mid",
    model: "anthropic/claude-3-haiku",
    rank: 1,
    inputCostPerMtok: 0.25,
    outputCostPerMtok: 1.25,
  },
  {
    id: "frontier",
    label: "Frontier",
    model: "anthropic/claude-3-5-sonnet",
    rank: 2,
    inputCostPerMtok: 3.0,
    outputCostPerMtok: 15.0,
  },
];

export const FRONTIER_TIER = TIERS[TIERS.length - 1];

export function tierById(id: TierId): ModelTier {
  const t = TIERS.find((x) => x.id === id);
  if (!t) throw new Error(`router: unknown tier ${id}`);
  return t;
}

function tierByRank(rank: number): ModelTier {
  return TIERS[Math.min(Math.max(0, rank), TIERS.length - 1)];
}

/** Estimated USD for a token usage on a given tier. */
export function estimateCost(usage: Usage, tier: ModelTier): number {
  return (
    (usage.input_tokens / 1e6) * tier.inputCostPerMtok +
    (usage.output_tokens / 1e6) * tier.outputCostPerMtok
  );
}

/* ------------------------------------------------------------------ *
 * The three typed questions.
 * ------------------------------------------------------------------ */

export const INTENTS = ["code", "qa", "creative", "triage", "other"] as const;
export type Intent = (typeof INTENTS)[number];

export const DIFFICULTY_LEVELS = [
  "trivial",
  "easy",
  "moderate",
  "hard",
  "expert",
];

export function routerQuestions(): Record<string, Question> {
  return {
    intent: {
      type: "choice",
      instructions:
        "What kind of work does this request need the answering model to do?",
      criteria: {
        code: "write / read / debug code",
        qa: "factual question answering or explanation",
        creative: "open-ended creative generation",
        triage: "label, route, or summarize a support item",
        other: "none of the above",
      },
    },
    difficulty: {
      type: "score",
      instructions:
        "How hard is this request for a language model, from trivial to expert?",
      criteria: DIFFICULTY_LEVELS,
    },
    risk: {
      type: "noul",
      instructions:
        "Is this request high-risk: irreversible actions, money movement, legal or safety exposure?",
      criteria: { true: "high-risk", false: "routine" },
    },
  };
}

/* ------------------------------------------------------------------ *
 * Signals + pure in-code routing decision.
 * ------------------------------------------------------------------ */

export type RouteSignals = {
  intent: Intent;
  /** difficulty level index (fractional values allowed, as Jev scores) */
  difficulty: number;
  /** probability the request is high-risk */
  risk: number;
  /** classification confidence: min of the intent/difficulty confidences */
  confidence: number;
};

export type RouteGates = {
  /** risk probability at or above which ONLY the frontier tier is allowed. */
  riskFloor: number;
  /** difficulty score at or above which the cheap tier is out of bounds. */
  midAt: number;
  /** difficulty score at or above which the frontier tier is required. */
  frontierAt: number;
  /** confidence below which the chosen tier is raised one rung. */
  lowConfBump: number;
};

export const DEFAULT_GATES: RouteGates = {
  riskFloor: 0.5,
  midAt: 1.5,
  frontierAt: 3,
  lowConfBump: 0.75,
};

export type RouteDecision = {
  tier: TierId;
  model: string;
  signals: RouteSignals;
  /** one line per rule that fired — what the dashboard shows as "why" */
  reasons: string[];
};

/**
 * Turn answers into validated signals. Mirrors the dispatcher's discipline:
 * anything outside the declared option set is a hard error, not a shrug.
 */
export function signalsFromAnswers(answers: Record<string, unknown>): RouteSignals {
  const intent = answers.intent as { type?: string; choice?: string; confidence?: number } | undefined;
  const difficulty = answers.difficulty as { type?: string; score?: number; confidence?: number } | undefined;
  const risk = answers.risk as { type?: string; noul?: number } | undefined;

  if (intent?.type !== "choice" || !INTENTS.includes(intent.choice as Intent)) {
    throw new Error(
      `router: intent "${String(intent?.choice)}" is outside the declared set`,
    );
  }
  if (
    difficulty?.type !== "score" ||
    typeof difficulty.score !== "number" ||
    !Number.isFinite(difficulty.score) ||
    difficulty.score < 0 ||
    difficulty.score >= DIFFICULTY_LEVELS.length
  ) {
    throw new Error("router: difficulty score is outside the declared levels");
  }
  if (risk?.type !== "noul" || typeof risk.noul !== "number") {
    throw new Error("router: risk answer missing or not a noul");
  }

  return {
    intent: intent.choice as Intent,
    difficulty: difficulty.score,
    risk: risk.noul,
    confidence: Math.min(
      intent.confidence ?? 0,
      difficulty.confidence ?? 0,
    ),
  };
}

/**
 * Pure, in-code tier decision from the signals. Rule order is the safety
 * story: risk floor > difficulty ladder > intent bump > confidence bump.
 */
export function decideTier(
  signals: RouteSignals,
  gates: RouteGates = DEFAULT_GATES,
): RouteDecision {
  const reasons: string[] = [];
  const s = signals;
  let tier: ModelTier;

  if (s.risk >= gates.riskFloor) {
    reasons.push(
      `risk ${s.risk.toFixed(2)} ≥ floor ${gates.riskFloor.toFixed(2)} — high-risk never runs on a cheap model`,
    );
    tier = FRONTIER_TIER;
  } else {
    let rank = 0;
    if (s.difficulty >= gates.frontierAt) {
      rank = 2;
      reasons.push(
        `difficulty ${s.difficulty.toFixed(1)} ≥ frontier gate ${gates.frontierAt}` ,
      );
    } else if (s.difficulty >= gates.midAt) {
      rank = 1;
      reasons.push(
        `difficulty ${s.difficulty.toFixed(1)} ≥ mid gate ${gates.midAt}`,
      );
    } else {
      reasons.push(
        `difficulty ${s.difficulty.toFixed(1)} below mid gate ${gates.midAt} — cheap tier allowed`,
      );
    }
    if (s.intent === "code" && rank < 1) {
      rank = 1;
      reasons.push("intent=code never runs on the cheapest model");
    }
    if (s.confidence < gates.lowConfBump && rank < 2) {
      rank += 1;
      reasons.push(
        `classification confidence ${s.confidence.toFixed(2)} below bump gate ${gates.lowConfBump.toFixed(2)} — raised one tier as a safety margin`,
      );
    }
    tier = tierByRank(rank);
  }

  reasons.push(`routed to ${tier.label}: ${tier.model}`);
  return { tier: tier.id, model: tier.model, signals: s, reasons };
}

/* ------------------------------------------------------------------ *
 * Live single-request route.
 * ------------------------------------------------------------------ */

export type RouteResult = {
  prompt: string;
  decision: RouteDecision;
  model: string;
  provider: Provider;
  usage: Usage;
  trace?: unknown;
};

export type RouteOptions = {
  classifyFn?: typeof classify;
  gates?: RouteGates;
  trace?: boolean;
};

export async function routePrompt(
  prompt: string,
  opts: RouteOptions = {},
): Promise<RouteResult> {
  const run = opts.classifyFn ?? classify;
  const res = await run(
    { state: prompt, questions: routerQuestions() },
    opts.trace ? { trace: true } : {},
  );
  const signals = signalsFromAnswers(res.answers);
  const decision = decideTier(signals, opts.gates ?? DEFAULT_GATES);
  const result: RouteResult = {
    prompt,
    decision,
    model: res.model,
    provider: res.provider,
    usage: res.usage,
  };
  if (opts.trace && res.trace) result.trace = res.trace;
  return result;
}

/* ------------------------------------------------------------------ *
 * Batched routing with the lane's 5 → 10 → All discipline.
 * ------------------------------------------------------------------ */

export type RouterItem = { id: string; prompt: string };

export type RouterItemReport = {
  id: string;
  prompt: string;
  decision?: RouteDecision;
  usage?: Usage;
  costRoutedUsd?: number;
  costAllFrontierUsd?: number;
  error?: string;
};

export type RouterTotals = {
  items: number;
  errors: number;
  routed: Record<TierId, number>;
  usage: Usage;
  costRoutedUsd: number;
  costAllFrontierUsd: number;
  savingsUsd: number;
  savingsPct: number;
};

export type RouterBatchReport = {
  items: RouterItemReport[];
  totals: RouterTotals;
  gates: RouteGates;
  model: string;
  provider: Provider;
};

export type RunRouterBatchOptions = {
  classifyFn?: typeof classify;
  gates?: Partial<RouteGates>;
  /** Cap on items processed; null = All. Default 5 (first ladder rung). */
  limit?: number | null;
  concurrency?: number;
};

/** Merge partial slider values over the shipped gate defaults. */
export function normalizeGates(partial?: Partial<RouteGates>): RouteGates {
  return { ...DEFAULT_GATES, ...(partial ?? {}) };
}

/**
 * Route many prompts at once. A failure on one item is isolated to that
 * item's report and never aborts the batch (same contract as the
 * dispatcher batch).
 */
export async function runRouterBatch(
  items: RouterItem[],
  opts: RunRouterBatchOptions = {},
): Promise<RouterBatchReport> {
  const run = opts.classifyFn ?? classify;
  const gates = normalizeGates(opts.gates);
  const limit =
    opts.limit === null ? items.length : (opts.limit ?? BATCH_LADDER[0]);
  const scoped = items.slice(0, Math.max(0, Math.min(limit, items.length)));
  const concurrency = Math.min(
    Math.max(1, opts.concurrency ?? 3),
    scoped.length || 1,
  );

  const reports: (RouterItemReport | undefined)[] = new Array(scoped.length);
  let cursor = 0;
  let classifierModel = "";
  let classifierProvider: Provider = "gateway";
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= scoped.length) return;
      const item = scoped[i];
      const report: RouterItemReport = { id: item.id, prompt: item.prompt };
      try {
        const routed = await routePrompt(item.prompt, { classifyFn: run, gates });
        report.decision = routed.decision;
        report.usage = routed.usage;
        report.costRoutedUsd = estimateCost(routed.usage, tierById(routed.decision.tier));
        report.costAllFrontierUsd = estimateCost(routed.usage, FRONTIER_TIER);
        classifierModel = routed.model;
        classifierProvider = routed.provider;
      } catch (err) {
        report.error = err instanceof Error ? err.message : "routing failed";
      }
      reports[i] = report;
    }
  }
  await Promise.all(
    Array.from({ length: concurrency }, () => worker()),
  );

  const totals: RouterTotals = {
    items: scoped.length,
    errors: 0,
    routed: { cheap: 0, mid: 0, frontier: 0 },
    usage: { input_tokens: 0, output_tokens: 0 },
    costRoutedUsd: 0,
    costAllFrontierUsd: 0,
    savingsUsd: 0,
    savingsPct: 0,
  };
  for (const r of reports.filter((x): x is RouterItemReport => !!x)) {
    if (r.error) totals.errors += 1;
    if (r.decision) totals.routed[r.decision.tier] += 1;
    if (r.usage) {
      totals.usage.input_tokens += r.usage.input_tokens;
      totals.usage.output_tokens += r.usage.output_tokens;
      totals.costRoutedUsd += r.costRoutedUsd ?? 0;
      totals.costAllFrontierUsd += r.costAllFrontierUsd ?? 0;
    }
  }
  totals.costRoutedUsd = round4(totals.costRoutedUsd);
  totals.costAllFrontierUsd = round4(totals.costAllFrontierUsd);
  totals.savingsUsd = round4(totals.costAllFrontierUsd - totals.costRoutedUsd);
  totals.savingsPct =
    totals.costAllFrontierUsd > 0 ? totals.savingsUsd / totals.costAllFrontierUsd : 0;

  return {
    items: reports.filter((x): x is RouterItemReport => !!x),
    totals,
    gates,
    model: classifierModel,
    provider: classifierProvider,
  };
}

function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}
