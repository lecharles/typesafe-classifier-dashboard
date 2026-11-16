import { classify } from "@/lib/classify";
import { BATCH_LADDER } from "@/lib/dispatch";
import { emailState, videoState } from "@/lib/harness";
import { emails } from "@/data/emails";
import { videos } from "@/data/youtube";
import type { ClassifyResult, Provider, Question, Usage } from "@/lib/schema";

/**
 * UC#7 (11-17 on the calendar, shipped 11-16 one day ahead): internet-BS
 * unified — ROADMAP-V2 Track C item 7, "merge email spam + YouTube
 * clickbait into one 'internet BS detector'".
 *
 * The lane has always screened these two species SEPARATELY: the emails
 * dashboard carries support mail, the YouTube dashboard asks a clickbait
 * Score. UC#7 welds them into ONE pipeline: a single typed question set
 * answers for both species of internet junk, over one merged corpus
 * (40 emails + 50 videos = 90 items), and CODE — never the free model —
 * decides clean / suspicious / bs:
 *
 *   bs      → Score  intensity, five rungs from straight talk to blatant BS
 *   malice  → Noul   is it TRYING to hurt you (scam ask, phishing, hidden links)
 *   payoff  → Noul   does the content deliver what the header promised?
 *
 * Rule order mirrors the guardrails/memory ladders: intensity ladder →
 * malice floor (absolute — a thing that lies at you is BS whatever the
 * ladder says) → payoff cap (an under-delivering headline is never
 * silently clean) → low-confidence demotion (uncertain CLEANS queue for a
 * human; nothing is escalated INTO bs by doubt, same inversion as memory).
 *
 * Batch discipline holds: 5 → 10 → All over the merged stream, with the
 * tallies split per source so "is email spam worse than YouTube bait?"
 * gets answered in data, not vibes.
 */

/* ------------------------------------------------------------------ *
 * Verdicts.
 * ------------------------------------------------------------------ */

export const BS_VERDICTS = ["clean", "suspicious", "bs"] as const;
export type BsVerdict = (typeof BS_VERDICTS)[number];

export const BS_RANK: Record<BsVerdict, number> = {
  clean: 0,
  suspicious: 1,
  bs: 2,
};

export const BS_NOTE: Record<BsVerdict, string> = {
  clean: "reads straight — nothing to squash",
  suspicious: "bait-adjacent; worth a human squint before amplifying",
  bs: "flagged internet junk — squash it",
};

export function bsBadgeClass(v: BsVerdict): "good" | "warn" | "bad" {
  return v === "clean" ? "good" : v === "suspicious" ? "warn" : "bad";
}

function clampRank(v: number): BsVerdict {
  return BS_VERDICTS[Math.min(Math.max(0, v), BS_VERDICTS.length - 1)];
}

/* ------------------------------------------------------------------ *
 * The typed questions — one set, both species.
 * ------------------------------------------------------------------ */

/** 0 straight talk … 4 blatant BS — the five-rung intensity ladder. */
export const BS_LEVELS = [
  "straight talk",
  "mild embellishment",
  "puffery & gloss",
  "classic bait",
  "blatant BS",
];

export function bsQuestions(): Record<string, Question> {
  return {
    bs: {
      type: "score",
      instructions:
        "How strong is the internet-BS in this piece — an email subject/body or a video title/description — from straight talk that says what it means, through mild embellishment and marketing puffery, to classic bait that overpromises, to blatant BS that is a scam or pure bait?",
      criteria: BS_LEVELS,
    },
    malice: {
      type: "noul",
      instructions:
        "Is this piece TRYING to hurt or defraud its reader — a scam ask, credential or payment phishing, deceptive hidden links, or a fabricated claim meant to manipulate? True = deceptive intent, false = at worst annoying.",
      criteria: { true: "deceptive intent", false: "no scam or fraud" },
    },
    payoff: {
      type: "noul",
      instructions:
        "Does the body or description actually DELIVER what the subject or title promises, rather than baiting a click with a payoff it never collects? True = the promise is kept, false = bait-and-switch.",
      criteria: { true: "delivers on the promise", false: "overpromises, under-delivers" },
    },
  };
}

/* ------------------------------------------------------------------ *
 * Signals + gates.
 * ------------------------------------------------------------------ */

export type BsSignals = {
  /** BS intensity level index (fractional values allowed, as Jev scores) */
  bs: number;
  /** probability of deceptive intent */
  malice: number;
  /** probability the content delivers on its promise */
  payoff: number;
  /** classification confidence (the BS Score's confidence) */
  confidence: number;
};

export type BsGates = {
  /** intensity at or above which the item is BS outright. */
  bsAt: number;
  /** intensity at or below which the item can be CLEAN. */
  cleanAt: number;
  /** malice probability at or above which the item is BS, whatever the ladder says. */
  maliceBlockAt: number;
  /** payoff probability below which CLEAN is capped to SUSPICIOUS. */
  payoffFloor: number;
  /** confidence below which a CLEAN is demoted to SUSPICIOUS (never silently clean). */
  lowConfBump: number;
};

export const DEFAULT_GATES: BsGates = {
  bsAt: 3.5,
  cleanAt: 1.0,
  maliceBlockAt: 0.6,
  payoffFloor: 0.5,
  lowConfBump: 0.6,
};

/** Merge partial slider values over the shipped gate defaults. */
export function normalizeGates(partial?: Partial<BsGates>): BsGates {
  return { ...DEFAULT_GATES, ...(partial ?? {}) };
}

export type BsDecision = {
  verdict: BsVerdict;
  reasons: string[];
};

/* ------------------------------------------------------------------ *
 * Answer validation — dispatcher discipline: anything outside the
 * declared level set or a non-probability Noul is a hard error.
 * ------------------------------------------------------------------ */

export function signalsFrom(answers: Record<string, unknown>): BsSignals {
  const bs = answers.bs as
    | { type?: string; score?: number; confidence?: number }
    | undefined;
  if (
    bs?.type !== "score" ||
    typeof bs.score !== "number" ||
    !Number.isFinite(bs.score) ||
    bs.score < 0 ||
    bs.score >= BS_LEVELS.length
  ) {
    throw new Error("bs: intensity score is outside the declared levels");
  }
  const malice = answers.malice as { type?: string; noul?: number } | undefined;
  if (
    malice?.type !== "noul" ||
    typeof malice.noul !== "number" ||
    !Number.isFinite(malice.noul) ||
    malice.noul < 0 ||
    malice.noul > 1
  ) {
    throw new Error("bs: malice answer missing or not a probability");
  }
  const payoff = answers.payoff as { type?: string; noul?: number } | undefined;
  if (
    payoff?.type !== "noul" ||
    typeof payoff.noul !== "number" ||
    !Number.isFinite(payoff.noul) ||
    payoff.noul < 0 ||
    payoff.noul > 1
  ) {
    throw new Error("bs: payoff answer missing or not a probability");
  }
  return {
    bs: bs.score,
    malice: malice.noul,
    payoff: payoff.noul,
    confidence: bs.confidence ?? 0,
  };
}

/* ------------------------------------------------------------------ *
 * Pure in-code verdict ladder.
 * ------------------------------------------------------------------ */

/**
 * clean / suspicious / bs decided in code. Rule order is the safety
 * story: intensity ladder → malice floor (absolute) → payoff cap →
 * confidence demotion. Uncertainty only ever demotes toward SUSPICIOUS
 * (the human squint lane) — doubt never escalates an item into bs.
 */
export function decideBsVerdict(
  s: BsSignals,
  gates: BsGates = DEFAULT_GATES,
): BsDecision {
  const reasons: string[] = [];

  // Intensity ladder — the base rung.
  let rank: number;
  if (s.bs >= gates.bsAt) {
    rank = BS_RANK.bs;
    reasons.push(
      `intensity ${s.bs.toFixed(1)} ≥ BS gate ${gates.bsAt} — this is internet junk`,
    );
  } else if (s.bs <= gates.cleanAt) {
    rank = BS_RANK.clean;
    reasons.push(
      `intensity ${s.bs.toFixed(1)} ≤ clean gate ${gates.cleanAt} — reads straight`,
    );
  } else {
    rank = BS_RANK.suspicious;
    reasons.push(
      `intensity ${s.bs.toFixed(1)} between clean ${gates.cleanAt} and BS ${gates.bsAt} — bait-adjacent, worth a squint`,
    );
  }

  // Malice floor is absolute — deceptive intent outranks any polite score.
  if (s.malice >= gates.maliceBlockAt) {
    reasons.push(
      `malice probability ${s.malice.toFixed(2)} ≥ floor ${gates.maliceBlockAt.toFixed(2)} — a thing that lies at you is BS whatever the intensity ladder says`,
    );
    rank = Math.max(rank, BS_RANK.bs);
  }

  // Payoff cap — a promise the content never collects is never silently clean.
  // A bs base is left alone: already squashed.
  if (s.payoff < gates.payoffFloor && rank === BS_RANK.clean) {
    rank = BS_RANK.suspicious;
    reasons.push(
      `payoff ${s.payoff.toFixed(2)} below floor ${gates.payoffFloor.toFixed(2)} — under-delivering headline caps clean to suspicious`,
    );
  }

  // Confidence demotion — an uncertain CLEAN queues for a human look.
  // It demotes toward suspicious, never escalates toward bs.
  if (s.confidence < gates.lowConfBump && rank === BS_RANK.clean) {
    rank = BS_RANK.suspicious;
    reasons.push(
      `intensity confidence ${s.confidence.toFixed(2)} below ${gates.lowConfBump.toFixed(2)} — uncertain cleans never pass silently`,
    );
  }

  const verdict = clampRank(rank);
  reasons.push(`BS verdict: ${verdict} (${BS_NOTE[verdict]})`);
  return { verdict, reasons };
}

/* ------------------------------------------------------------------ *
 * Live single item: one classify call, verdict decided in code.
 * ------------------------------------------------------------------ */

export type BsScreened = {
  label: string;
  state: string;
  signals: BsSignals;
  decision: BsDecision;
  gates: BsGates;
  model: string;
  provider: Provider;
  usage: Usage;
  trace?: unknown;
};

export type ScreenOptions = {
  classifyFn?: typeof classify;
  gates?: BsGates;
  trace?: boolean;
};

/**
 * Screen one arbitrary piece of internet text (subject/title + body/description
 * already composed into `state`). `label` is display-only metadata.
 */
export async function screenBsItem(
  state: string,
  label: string,
  opts: ScreenOptions = {},
): Promise<BsScreened> {
  const run = opts.classifyFn ?? classify;
  const gates = opts.gates ?? DEFAULT_GATES;

  const res: ClassifyResult = await run(
    { state: state.trim(), questions: bsQuestions() },
    opts.trace ? { trace: true } : {},
  );

  const signals = signalsFrom(res.answers);
  const decision = decideBsVerdict(signals, gates);

  return {
    label,
    state: state.trim(),
    signals,
    decision,
    gates,
    model: res.model,
    provider: res.provider,
    usage: res.usage,
    ...(opts.trace && res.trace ? { trace: res.trace } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * The merged corpus: every email + every video, one stream.
 * ------------------------------------------------------------------ */

export const BS_SOURCES = ["email", "video"] as const;
export type BsSource = (typeof BS_SOURCES)[number];

export type BsItem = {
  id: string;
  source: BsSource;
  /** subject or video title — display-only */
  label: string;
  /** the full state handed to the classifier */
  state: string;
};

/** Build the unified corpus: the same states the two live dashboards classify. */
export function buildBsCorpus(sources: BsSource[] = [...BS_SOURCES]): BsItem[] {
  const out: BsItem[] = [];
  if (sources.includes("email")) {
    for (const e of emails) {
      out.push({ id: e.id, source: "email", label: e.subject, state: emailState(e) });
    }
  }
  if (sources.includes("video")) {
    for (const v of videos) {
      out.push({ id: v.id, source: "video", label: v.title, state: videoState(v) });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Batched screening with the lane's 5 → 10 → All discipline, plus the
 * per-source tallies that make the unification measurable.
 * ------------------------------------------------------------------ */

export type BsBatchItemIn = {
  id: string;
  source?: BsSource;
  label?: string;
  state: string;
};

export type BsBatchItem = {
  id: string;
  source: BsSource;
  label: string;
  signals?: BsSignals;
  verdict?: BsVerdict;
  reasons?: string[];
  usage?: Usage;
  error?: string;
};

export type BsTally = Record<BsVerdict, number>;

export type BsTotals = {
  screened: number;
  errors: number;
  verdicts: BsTally;
  /** the unified question answered in data: same detector, per-source tallies */
  bySource: Record<BsSource, BsTally>;
  usage: Usage;
};

export type BsBatchReport = {
  items: BsBatchItem[];
  totals: BsTotals;
  gates: BsGates;
  model: string;
  provider: Provider;
};

export type RunBsBatchOptions = {
  classifyFn?: typeof classify;
  gates?: Partial<BsGates>;
  /** Cap on items processed; null = All. Default 5 (first ladder rung). */
  limit?: number | null;
  concurrency?: number;
};

function emptyTally(): BsTally {
  return { clean: 0, suspicious: 0, bs: 0 };
}

/**
 * Screen a corpus (default: the merged email+video stream). A failure on
 * one item is isolated to that item's report and never aborts the batch —
 * same contract as the memory/citations/rerank batches. Verdicts stay
 * code-side per item; the ladder is identical to the live single-screen path.
 */
export async function runBsBatch(
  corpus: BsBatchItemIn[] = buildBsCorpus(),
  opts: RunBsBatchOptions = {},
): Promise<BsBatchReport> {
  const run = opts.classifyFn ?? classify;
  const gates = normalizeGates(opts.gates);
  const limit =
    opts.limit === null ? corpus.length : (opts.limit ?? BATCH_LADDER[0]);
  const scoped = corpus.slice(
    0,
    Math.max(0, Math.min(limit, corpus.length)),
  );
  const concurrency = Math.min(
    Math.max(1, opts.concurrency ?? 3),
    scoped.length || 1,
  );

  const reports: (BsBatchItem | undefined)[] = new Array(scoped.length);
  let cursor = 0;
  let classifierModel = "";
  let classifierProvider: Provider = "gateway";

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= scoped.length) return;
      const c = scoped[i];
      const report: BsBatchItem = {
        id: c.id,
        source: c.source ?? "video",
        label: c.label ?? c.state.slice(0, 80),
      };
      try {
        const scr = await screenBsItem(c.state, report.label, {
          classifyFn: run,
          gates,
        });
        report.verdict = scr.decision.verdict;
        report.reasons = scr.decision.reasons;
        report.signals = scr.signals;
        report.usage = scr.usage;
        classifierModel = scr.model;
        classifierProvider = scr.provider;
      } catch (err) {
        report.error = err instanceof Error ? err.message : "BS screen failed";
      }
      reports[i] = report;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const totals: BsTotals = {
    screened: scoped.length,
    errors: 0,
    verdicts: emptyTally(),
    bySource: { email: emptyTally(), video: emptyTally() },
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  for (const r of reports.filter((x): x is BsBatchItem => !!x)) {
    if (r.error) {
      totals.errors += 1;
      continue;
    }
    if (r.verdict) {
      totals.verdicts[r.verdict] += 1;
      totals.bySource[r.source][r.verdict] += 1;
    }
    if (r.usage) {
      totals.usage.input_tokens += r.usage.input_tokens;
      totals.usage.output_tokens += r.usage.output_tokens;
    }
  }

  return {
    items: reports.filter((x): x is BsBatchItem => !!x),
    totals,
    gates,
    model: classifierModel,
    provider: classifierProvider,
  };
}
