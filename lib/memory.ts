import { classify } from "@/lib/classify";
import type { ClassifyResult, Provider, Question, Usage } from "@/lib/schema";

/**
 * UC#6 (11-15 on the calendar, shipped 11-14): memory curator scaffold.
 * ROADMAP-V2 Track C item 6 — "which requests/answers are worth
 * remembering (Noul + Score)".
 *
 * A conversation agent has to decide what it writes into long-term memory.
 * The same three primitives the lane already uses answer the question:
 *
 *   reuse    → Score  one-off … evergreen: will this pay off again?
 *   durable  → Noul   is it stable knowledge or a fact that goes stale?
 *   pii      → Noul   is there private data that must NEVER be persisted?
 *
 * and CODE — never the free model — decides keep / review / forget. Rule
 * order mirrors the guardrails/rerank ladders: PII floor (absolute) →
 * reuse ladder → durability cap → low-confidence demotion. Two inversions
 * make memory safe: private material is forgotten outright no matter how
 * reusable it is, and an uncertain candidate is never KEPT silently — it
 * is demoted to the human queue, never escalated to a destructive forget.
 *
 * 11-16 (UC#6 memory curator live) adds the batch discipline 5 → 10 → All
 * over a memory-candidate corpus, same ladder as every "after D14" row.
 */

/* ------------------------------------------------------------------ *
 * Verdicts (memory membership).
 * ------------------------------------------------------------------ */

export const MEMBERSHIP = ["keep", "review", "forget"] as const;
export type Membership = (typeof MEMBERSHIP)[number];

export const MEMBERSHIP_RANK: Record<Membership, number> = {
  keep: 0,
  review: 1,
  forget: 2,
};

export const MEMBERSHIP_NOTE: Record<Membership, string> = {
  keep: "written to long-term memory",
  review: "held in the short-term queue for a human look",
  forget: "discarded — never persisted",
};

export function membershipBadgeClass(m: Membership): "good" | "warn" | "bad" {
  return m === "keep" ? "good" : m === "review" ? "warn" : "bad";
}

function clampRank(v: number): Membership {
  return MEMBERSHIP[Math.min(Math.max(0, v), MEMBERSHIP.length - 1)];
}

/* ------------------------------------------------------------------ *
 * The typed questions.
 * ------------------------------------------------------------------ */

/** 0 one-off … 4 evergreen — a five-rung usefulness ladder. */
export const REUSE_LEVELS = [
  "one-off",
  "session-local",
  "recurring pattern",
  "durable preference",
  "evergreen knowledge",
];

export function memoryQuestions(): Record<string, Question> {
  return {
    reuse: {
      type: "score",
      instructions:
        "How useful would this exchange be for FUTURE conversations, from a one-off nobody will ask again to evergreen knowledge that compounds?",
      criteria: REUSE_LEVELS,
    },
    durable: {
      type: "noul",
      instructions:
        "Is the answer stable knowledge that will still be true tomorrow and next month, rather than volatile facts (prices, versions, inventory, schedules, current status)?",
      criteria: { true: "stable over time", false: "goes stale quickly" },
    },
    pii: {
      type: "noul",
      instructions:
        "Does this exchange contain personal or private data — names tied to account numbers, card or bank digits, home addresses, health details, credentials, or other identifiers that must never be persisted to long-term memory?",
      criteria: { true: "contains private data", false: "clean of private data" },
    },
  };
}

/* ------------------------------------------------------------------ *
 * Signals + gates.
 * ------------------------------------------------------------------ */

export type MemorySignals = {
  /** reuse level index (fractional values allowed, as Jev scores) */
  reuse: number;
  /** probability the answer is stable over time */
  durable: number;
  /** probability the exchange contains private data */
  pii: number;
  /** classification confidence (the reuse Score's confidence) */
  confidence: number;
};

export type MemoryGates = {
  /** reuse at or above which a clean, stable candidate is KEPT. */
  keepAt: number;
  /** reuse at or below which the candidate is FORGOT — nothing compounds. */
  forgetAt: number;
  /** pii probability at or above which the candidate is FORGOT outright. */
  piiBlockAt: number;
  /** durable probability below which KEEP is capped to REVIEW. */
  durableFloor: number;
  /** confidence below which a KEEP is demoted to REVIEW (never silently kept). */
  lowConfBump: number;
};

export const DEFAULT_GATES: MemoryGates = {
  keepAt: 2.5,
  forgetAt: 0.5,
  piiBlockAt: 0.5,
  durableFloor: 0.5,
  lowConfBump: 0.6,
};

/** Merge partial slider values over the shipped gate defaults. */
export function normalizeGates(partial?: Partial<MemoryGates>): MemoryGates {
  return { ...DEFAULT_GATES, ...(partial ?? {}) };
}

export type MembershipDecision = {
  membership: Membership;
  reasons: string[];
};

/* ------------------------------------------------------------------ *
 * Answer validation — dispatcher discipline: anything outside the
 * declared level set or a non-probability Noul is a hard error.
 * ------------------------------------------------------------------ */

export function signalsFrom(answers: Record<string, unknown>): MemorySignals {
  const reuse = answers.reuse as
    | { type?: string; score?: number; confidence?: number }
    | undefined;
  if (
    reuse?.type !== "score" ||
    typeof reuse.score !== "number" ||
    !Number.isFinite(reuse.score) ||
    reuse.score < 0 ||
    reuse.score >= REUSE_LEVELS.length
  ) {
    throw new Error("memory: reuse score is outside the declared levels");
  }
  const durable = answers.durable as { type?: string; noul?: number } | undefined;
  if (
    durable?.type !== "noul" ||
    typeof durable.noul !== "number" ||
    !Number.isFinite(durable.noul) ||
    durable.noul < 0 ||
    durable.noul > 1
  ) {
    throw new Error("memory: durable answer missing or not a probability");
  }
  const pii = answers.pii as { type?: string; noul?: number } | undefined;
  if (
    pii?.type !== "noul" ||
    typeof pii.noul !== "number" ||
    !Number.isFinite(pii.noul) ||
    pii.noul < 0 ||
    pii.noul > 1
  ) {
    throw new Error("memory: pii answer missing or not a probability");
  }
  return {
    reuse: reuse.score,
    durable: durable.noul,
    pii: pii.noul,
    confidence: reuse.confidence ?? 0,
  };
}

/* ------------------------------------------------------------------ *
 * Pure in-code membership ladder.
 * ------------------------------------------------------------------ */

/**
 * keep / review / forget decided in code. Rule order is the safety story:
 * PII floor (absolute) → reuse ladder → durability cap → confidence demotion.
 */
export function decideMemoryVerdict(
  s: MemorySignals,
  gates: MemoryGates = DEFAULT_GATES,
): MembershipDecision {
  const reasons: string[] = [];

  // Reuse ladder — the base rung.
  let rank: number;
  if (s.reuse >= gates.keepAt) {
    rank = MEMBERSHIP_RANK.keep;
    reasons.push(
      `reuse ${s.reuse.toFixed(1)} ≥ keep gate ${gates.keepAt} — this pays off again`,
    );
  } else if (s.reuse <= gates.forgetAt) {
    rank = MEMBERSHIP_RANK.forget;
    reasons.push(
      `reuse ${s.reuse.toFixed(1)} ≤ forget gate ${gates.forgetAt} — nothing here compounds; discard`,
    );
  } else {
    rank = MEMBERSHIP_RANK.review;
    reasons.push(
      `reuse ${s.reuse.toFixed(1)} between forget ${gates.forgetAt} and keep ${gates.keepAt} — held for a human look`,
    );
  }

  // PII floor is absolute — private data never gets persisted, however reusable.
  if (s.pii >= gates.piiBlockAt) {
    reasons.push(
      `pii probability ${s.pii.toFixed(2)} ≥ floor ${gates.piiBlockAt.toFixed(2)} — private data never reaches long-term memory, whatever the reuse ladder says`,
    );
    rank = Math.max(rank, MEMBERSHIP_RANK.forget);
  }

  // Durability cap — volatile facts are never silently kept; they queue.
  // A forget base is left alone: dropping stale data is already safe.
  if (s.durable < gates.durableFloor && rank === MEMBERSHIP_RANK.keep) {
    rank = MEMBERSHIP_RANK.review;
    reasons.push(
      `durability ${s.durable.toFixed(2)} below floor ${gates.durableFloor.toFixed(2)} — volatile knowledge goes stale, so keep is capped to review`,
    );
  }

  // Confidence demotion — an uncertain candidate is never kept silently.
  // It demotes toward review, never toward destructive forget.
  if (s.confidence < gates.lowConfBump && rank === MEMBERSHIP_RANK.keep) {
    rank = MEMBERSHIP_RANK.review;
    reasons.push(
      `reuse confidence ${s.confidence.toFixed(2)} below ${gates.lowConfBump.toFixed(2)} — uncertain candidates never pass into memory silently`,
    );
  }

  const membership = clampRank(rank);
  reasons.push(`memory verdict: ${membership} (${MEMBERSHIP_NOTE[membership]})`);
  return { membership, reasons };
}

/* ------------------------------------------------------------------ *
 * Live single exchange: one classify call, verdict decided in code.
 * ------------------------------------------------------------------ */

/** Wire-state for the classifier: request + optional assistant answer. */
export function curateState(request: string, answer?: string): string {
  const a = answer && answer.trim().length > 0 ? answer.trim() : undefined;
  return a
    ? `REQUEST:\n${request.trim()}\n\nANSWER:\n${a}`
    : `REQUEST:\n${request.trim()}`;
}

export type CuratedMemory = {
  request: string;
  answer?: string;
  signals: MemorySignals;
  decision: MembershipDecision;
  gates: MemoryGates;
  model: string;
  provider: Provider;
  usage: Usage;
  trace?: unknown;
};

export type CurateOptions = {
  classifyFn?: typeof classify;
  gates?: MemoryGates;
  trace?: boolean;
};

export async function curateExchange(
  request: string,
  answer?: string,
  opts: CurateOptions = {},
): Promise<CuratedMemory> {
  const run = opts.classifyFn ?? classify;
  const gates = opts.gates ?? DEFAULT_GATES;

  const res: ClassifyResult = await run(
    { state: curateState(request, answer), questions: memoryQuestions() },
    opts.trace ? { trace: true } : {},
  );

  const signals = signalsFrom(res.answers);
  const decision = decideMemoryVerdict(signals, gates);

  const a = answer && answer.trim().length > 0 ? answer.trim() : undefined;
  return {
    request,
    ...(a ? { answer: a } : {}),
    signals,
    decision,
    gates,
    model: res.model,
    provider: res.provider,
    usage: res.usage,
    ...(opts.trace && res.trace ? { trace: res.trace } : {}),
  };
}
