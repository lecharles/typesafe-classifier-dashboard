import { classify } from "@/lib/classify";
import { compareResults, latencyLabel, type Agreement } from "@/lib/compare";
import { BATCH_LADDER } from "@/lib/dispatch";
import { emails, type Email } from "@/data/emails";
import { videos, type Video } from "@/data/youtube";
import { EMAIL_QUESTIONS, YOUTUBE_QUESTIONS } from "@/data/questions";
import type { Answer, ClassifyResult, Provider, Question, Usage } from "@/lib/schema";

/**
 * D14 (11-14 calendar row): the emulated-vs-Jev comparison harness.
 *
 * Runs the SAME state through BOTH backends — the real TypeSafe/Jev System
 * One API and the primitives emulated over the Vercel AI Gateway — and lets
 * CODE (lib/compare's answersMatch, never a free-model "do these agree?"
 * call) decide per question whether they match. The headline number is the
 * agreement rate: how much of the app's behavior survives swapping the
 * emulated primitives for the real API.
 *
 * Lane discipline holds: batch 5 → 10 → All, a failure on one item (or one
 * side of one item) is isolated to that item's report, and the full 90-item
 * corpus (40 emails + 50 YouTube) runs well under $0.10 of gateway credits.
 */

/* ------------------------------------------------------------------ *
 * Datasets + state builders (identical to the live dashboards).
 * ------------------------------------------------------------------ */

export type HarnessDatasetId = "emails" | "youtube";

export const HARNESS_DATASETS: { id: HarnessDatasetId; label: string }[] = [
  { id: "emails", label: "Email triage (40)" },
  { id: "youtube", label: "YouTube analyzer (50)" },
];

export type HarnessItem = {
  id: string;
  dataset: HarnessDatasetId;
  state: string;
};

/** Same email state the /emails dashboard classifies. */
export function emailState(e: Email): string {
  return `Subject: ${e.subject}\n\n${e.body}`;
}

/** Same video state the /youtube dashboard classifies. */
export function videoState(v: Video): string {
  return `Title: ${v.title}\nChannel: ${v.channel}\nDescription: ${v.description}`;
}

export function questionsForDataset(id: HarnessDatasetId): Record<string, Question> {
  return id === "emails" ? EMAIL_QUESTIONS : YOUTUBE_QUESTIONS;
}

/** The bundled comparison corpus: every email + every video. */
export function buildHarnessItems(
  datasets: HarnessDatasetId[] = ["emails", "youtube"],
): HarnessItem[] {
  const out: HarnessItem[] = [];
  if (datasets.includes("emails")) {
    for (const e of emails) out.push({ id: e.id, dataset: "emails", state: emailState(e) });
  }
  if (datasets.includes("youtube")) {
    for (const v of videos) out.push({ id: `yt-${v.id}`, dataset: "youtube", state: videoState(v) });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Per-side outcome + display decisions.
 * ------------------------------------------------------------------ */

export type HarnessSide = {
  provider: Provider;
  ok: boolean;
  answers?: Record<string, Answer>;
  model?: string;
  usage?: Usage;
  latency_ms?: number;
  error?: string;
};

/** Reduce one answer to a human label: the option key, the level name, yes/no. */
export function decisionLabel(q: Question | undefined, a: Answer | undefined): string | null {
  if (!a) return null;
  switch (a.type) {
    case "choice":
      return a.choice;
    case "score": {
      const levels = q && q.type === "score" ? q.criteria : undefined;
      const idx =
        levels && levels.length > 0
          ? Math.max(0, Math.min(Math.round(a.score), levels.length - 1))
          : Math.round(a.score);
      const name = levels?.[idx];
      return name ? `${idx} · ${name}` : String(idx);
    }
    case "noul":
      return a.noul >= 0.5 ? "yes" : "no";
  }
}

/** Display decisions for every question id a side answered. */
export function sideDecisions(
  side: HarnessSide,
  questions: Record<string, Question>,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const id of Object.keys(questions)) {
    out[id] = decisionLabel(questions[id], side.answers?.[id]);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Item-level comparison — pure, testable, CODE decides agreement.
 * ------------------------------------------------------------------ */

export type ItemStatus = "match" | "diff" | "na";

export type HarnessItemReport = {
  id: string;
  dataset: HarnessDatasetId;
  status: ItemStatus;
  agreement: Record<string, Agreement>;
  diffQuestions: string[];
  jev: HarnessSide;
  emulated: HarnessSide;
  jevDecisions: Record<string, string | null>;
  emulatedDecisions: ReportDecisions;
};

type ReportDecisions = Record<string, string | null>;

/**
 * Compare two (possibly missing) results: match when both sides answered and
 * every question agrees; diff when both answered but something disagrees;
 * n/a when either side failed or lacks the question. Reuses the exact
 * answersMatch semantics the Playground's ask-both mode uses.
 */
export function compareSides(
  jev: HarnessSide,
  emulated: HarnessSide,
): { status: ItemStatus; agreement: Record<string, Agreement>; diffQuestions: string[] } {
  if (!jev.ok || !emulated.ok) {
    return { status: "na", agreement: {}, diffQuestions: [] };
  }
  const jevResult: ClassifyResult = {
    answers: jev.answers ?? {},
    usage: jev.usage ?? { input_tokens: 0, output_tokens: 0 },
    model: jev.model ?? "",
    provider: "jev",
  };
  const gwResult: ClassifyResult = {
    answers: emulated.answers ?? {},
    usage: emulated.usage ?? { input_tokens: 0, output_tokens: 0 },
    model: emulated.model ?? "",
    provider: "gateway",
  };
  const agreement = compareResults(jevResult, gwResult);
  const diffQuestions = Object.keys(agreement).filter((id) => agreement[id] === "diff");
  const na = Object.keys(agreement).some((id) => agreement[id] === "n/a");
  const status: ItemStatus = na ? "na" : diffQuestions.length > 0 ? "diff" : "match";
  return { status, agreement, diffQuestions };
}

export function harnessStatusBadgeClass(s: ItemStatus): "good" | "warn" | "neutral" {
  return s === "match" ? "good" : s === "diff" ? "warn" : "neutral";
}

export function agreementBadgeClass(a: Agreement): "good" | "warn" | "neutral" {
  return a === "match" ? "good" : a === "diff" ? "warn" : "neutral";
}

/* ------------------------------------------------------------------ *
 * Totals — the agreement rate is the product answer of this page.
 * ------------------------------------------------------------------ */

export type QuestionAgreement = {
  match: number;
  diff: number;
  na: number;
  /** match / (match + diff), or null when nothing comparable. */
  rate: number | null;
};

export type HarnessTotals = {
  items: number;
  compared: number;
  matches: number;
  diffs: number;
  na: number;
  jevErrors: number;
  emulatedErrors: number;
  /** matches / compared, or null when no item completed on both sides. */
  agreementRate: number | null;
  perQuestion: Record<string, QuestionAgreement>;
  jevUsage: Usage;
  emulatedUsage: Usage;
  jevModel: string;
  emulatedModel: string;
  jevAvgLatency: number | null;
  emulatedAvgLatency: number | null;
  jevP95Latency: number | null;
  emulatedP95Latency: number | null;
};

function avg(xs: number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Nearest-rank p95 (no interpolation): ceil(0.95·n)th of the sorted list. */
export function p95(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.95 * sorted.length) - 1));
  return sorted[idx];
}

export function computeHarnessTotals(
  reports: HarnessItemReport[],
  questionsFor: (dataset: HarnessDatasetId) => Record<string, Question> = questionsForDataset,
): HarnessTotals {
  const totals: HarnessTotals = {
    items: reports.length,
    compared: 0,
    matches: 0,
    diffs: 0,
    na: 0,
    jevErrors: 0,
    emulatedErrors: 0,
    agreementRate: null,
    perQuestion: {},
    jevUsage: { input_tokens: 0, output_tokens: 0 },
    emulatedUsage: { input_tokens: 0, output_tokens: 0 },
    jevModel: "",
    emulatedModel: "",
    jevAvgLatency: null,
    emulatedAvgLatency: null,
    jevP95Latency: null,
    emulatedP95Latency: null,
  };
  const jevLat: number[] = [];
  const gwLat: number[] = [];

  for (const r of reports) {
    if (r.status === "match") totals.matches += 1;
    else if (r.status === "diff") totals.diffs += 1;
    else totals.na += 1;
    if (!r.jev.ok) totals.jevErrors += 1;
    if (!r.emulated.ok) totals.emulatedErrors += 1;
    if (r.jev.usage) {
      totals.jevUsage.input_tokens += r.jev.usage.input_tokens;
      totals.jevUsage.output_tokens += r.jev.usage.output_tokens;
    }
    if (r.emulated.usage) {
      totals.emulatedUsage.input_tokens += r.emulated.usage.input_tokens;
      totals.emulatedUsage.output_tokens += r.emulated.usage.output_tokens;
    }
    if (r.jev.model) totals.jevModel = r.jev.model;
    if (r.emulated.model) totals.emulatedModel = r.emulated.model;
    if (typeof r.jev.latency_ms === "number") jevLat.push(r.jev.latency_ms);
    if (typeof r.emulated.latency_ms === "number") gwLat.push(r.emulated.latency_ms);

    if (r.status === "match" || r.status === "diff") {
      totals.compared += 1;
      // Only questions both declared AND answered contribute to the rate.
      for (const qid of Object.keys(questionsFor(r.dataset))) {
        const a = r.agreement[qid];
        if (!a) continue;
        const row = (totals.perQuestion[qid] ??= { match: 0, diff: 0, na: 0, rate: null });
        if (a === "match") row.match += 1;
        else if (a === "diff") row.diff += 1;
        else row.na += 1;
      }
    }
  }

  totals.agreementRate = totals.compared > 0 ? totals.matches / totals.compared : null;
  for (const row of Object.values(totals.perQuestion)) {
    const denom = row.match + row.diff;
    row.rate = denom > 0 ? row.match / denom : null;
  }
  totals.jevAvgLatency = avg(jevLat);
  totals.emulatedAvgLatency = avg(gwLat);
  totals.jevP95Latency = p95(jevLat);
  totals.emulatedP95Latency = p95(gwLat);
  return totals;
}

export function agreementRateLabel(rate: number | null): string {
  return rate === null ? "—" : `${(rate * 100).toFixed(1)}%`;
}

/** Reuses lib/compare's latencyLabel so both pages speak the same units. */
export function sideLatencyLabel(side: HarnessSide): string {
  return latencyLabel(side.latency_ms);
}

/* ------------------------------------------------------------------ *
 * The live runner: every item through BOTH backends.
 * ------------------------------------------------------------------ */

export type HarnessReport = {
  items: HarnessItemReport[];
  totals: HarnessTotals;
  ladder: number[];
  generatedAt: string;
};

export type RunHarnessOptions = {
  classifyFn?: typeof classify;
  /** Ladder rung; null = All. Default 5 (first rung). */
  limit?: number | null;
  /** ITEMS in flight; each item fires 2 backend calls. Default 3. */
  concurrency?: number;
  now?: () => number;
};

async function runSide(
  provider: Provider,
  item: HarnessItem,
  run: typeof classify,
  now: () => number,
): Promise<HarnessSide> {
  const questions = questionsForDataset(item.dataset);
  const t0 = now();
  try {
    const res = await run(
      { state: item.state, questions },
      { provider }, // explicit backend; NO fallback — we want each side to answer as itself
    );
    return {
      provider,
      ok: true,
      answers: res.answers,
      model: res.model,
      usage: res.usage,
      latency_ms: Math.max(0, now() - t0),
    };
  } catch (err) {
    return {
      provider,
      ok: false,
      error: err instanceof Error ? err.message : `${provider} call failed`,
      latency_ms: Math.max(0, now() - t0),
    };
  }
}

/**
 * Run the corpus through Jev AND the emulated gateway, comparing every item
 * in code. Errors are isolated per side per item (a dead Jev key still
 * yields a full emulated column and n/a rows, not a dead batch).
 */
export async function runHarness(
  items: HarnessItem[],
  opts: RunHarnessOptions = {},
): Promise<HarnessReport> {
  const run = opts.classifyFn ?? classify;
  const now = opts.now ?? (() => Date.now());
  const limit =
    opts.limit === null ? items.length : (opts.limit ?? BATCH_LADDER[0]);
  const scoped = items.slice(0, Math.max(0, Math.min(limit, items.length)));
  const concurrency = Math.min(Math.max(1, opts.concurrency ?? 3), scoped.length || 1);

  const reports: (HarnessItemReport | undefined)[] = new Array(scoped.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= scoped.length) return;
      const item = scoped[i];
      const [jev, emulated] = await Promise.all([
        runSide("jev", item, run, now),
        runSide("gateway", item, run, now),
      ]);
      const { status, agreement, diffQuestions } = compareSides(jev, emulated);
      const questions = questionsForDataset(item.dataset);
      reports[i] = {
        id: item.id,
        dataset: item.dataset,
        status,
        agreement,
        diffQuestions,
        jev,
        emulated,
        jevDecisions: sideDecisions(jev, questions),
        emulatedDecisions: sideDecisions(emulated, questions),
      };
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const done = reports.filter((r): r is HarnessItemReport => !!r);
  return {
    items: done,
    totals: computeHarnessTotals(done),
    ladder: [...BATCH_LADDER],
    generatedAt: new Date(now()).toISOString(),
  };
}
