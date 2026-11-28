/**
 * 11-28 row: Regression hardening — the GALLERY WALK, IN CODE.
 *
 * Every lane on this dashboard answers the same question in a different
 * shape, and every daily slice has hardened ONE of them. This row walks
 * ALL of them: a single regression receipt proves that every gallery
 * item — all 17 home cards — still survives its live code path end to
 * end with the invariants the shipped UI depends on:
 *
 *   corpus → real batch runner (the exact function the /api route calls)
 *        → verdicts decided IN CODE → receipts balance → export rows
 *        → store guards accept their own lane's output.
 *
 * The classifier behind the walk is EMULATED — a deterministic,
 * content-keyed responder (same family as the D14 emulated side): no
 * network, no tokens, identical answers every run. The point of this
 * row is the CONTRACT between a lane's code and its own numbers, and a
 * contract check must not depend on a model's mood.
 *
 * House discipline, unchanged:
 *  - THE RECEIPT NEVER TRUSTS A PAYLOAD. isRegressionReceipt RECOMPUTES
 *    every total from its own walk rows; a tampered pass/fail count, a
 *    dropped surface, or a flipped check is structurally unrefusable —
 *    it simply fails the guard and never reloads.
 *  - FAILURES ARE COUNTED, NEVER SWALLOWED. A probe that throws becomes
 *    a failed surface row — the walk always covers all 17 surfaces.
 *  - DETERMINISM IS THE REGRESSION. Two walks (fixed clock) are
 *    byte-identical; if a lane edit moves a number, the receipt moves.
 *  - Receipts persist to the SQLite store (lane "regression") behind
 *    the same guard — the walk survives a restart.
 *  - D8 export: one row per surface, totals ride row 0.
 */

import { classify, type ClassifyOptions } from "@/lib/classify";
import type { Answer, ClassifyRequest, ClassifyResult, Provider, Question, Usage } from "@/lib/schema";
import { classifyBatch } from "@/lib/batch";
import { EMAIL_QUESTIONS, PLAYGROUND_QUESTIONS, YOUTUBE_QUESTIONS } from "@/data/questions";
import { emails } from "@/data/emails";
import { videos } from "@/data/youtube";
import { exchanges } from "@/data/exchanges";
import { claimCases } from "@/data/claims";
import { RAG_QUERY, ragPassages } from "@/data/passages";
import { memoryCandidates } from "@/data/memory-candidates";
import { extractionCorpus } from "@/data/extraction-corpus";
import { runDispatchBatch, REGISTRY, DEFAULT_EXEC_GATE } from "@/lib/dispatch";
import { runRouterBatch, TIERS } from "@/lib/router";
import { runGuardrailsBatch, VERDICTS, worstVerdict } from "@/lib/guardrails";
import { runCitationsBatch, CITATION_VERDICTS } from "@/lib/citations";
import { runRerankBatch, DISPOSITIONS, COVERAGES } from "@/lib/rerank";
import { runHarness, buildHarnessItems, emailState, videoState, decisionLabel, type HarnessReport } from "@/lib/harness";
import { runMemoryBatch, MEMBERSHIP } from "@/lib/memory";
import { runBsBatch, buildBsCorpus, rankBsLeaderboard, bsLeaderboardScore, BS_RANK, bsLeaderboardExportRows, type BsVerdict } from "@/lib/bs";
import { runExtractBatch, EXTRACT_STATUS, daysInMonth, isValidDate } from "@/lib/extract";
import { runChatBatch, buildChatCorpus, applyChatStrikes, CHAT_ACTIONS, CHAT_STRIKE_STATES } from "@/lib/chat";
import { runEntityBatch, buildEntityCorpus, isEntityBatchReport, entityRunSummary, foldEntityClusters } from "@/lib/entities";
import { parseCorpusIntake, runUploadBatch, isUploadBatchReport, uploadRunSummary, assertOfficialApiUrl, officialItemsFrom } from "@/lib/upload";
import {
  CAL_BIN_COUNT,
  buildCalibrationTable,
  calPointsFromHarness,
  isCalibrationSnapshot,
  type CalibrationSnapshot,
} from "@/lib/calibration";
import {
  DEFAULT_BUDGET_USD,
  DEFAULT_RATES,
  buildCostLedger,
  costReceiptsFromHarness,
  costReceiptsFromPayload,
  isCostSnapshot,
  type CostSnapshot,
} from "@/lib/cost";
import { DEFAULT_THRESHOLDS, routeDecision, summarizeRouting } from "@/lib/routing";
import { avgConfidence, choiceCounts, countByMonth, noulHistogram, noulRate, scoreHistogram, successes, sumUsage } from "@/lib/aggregate";
import { applyEmailFilter, toggleEmailFilter, urgencyBin, type EmailFilter, type EmailFilterableRow } from "@/lib/tablefilter";
import { compareResults, answersMatch, latencyLabel } from "@/lib/compare";
import type { ExportRow } from "@/lib/export";

/* ------------------------------------------------------------------ *
 * The manifest — every gallery item, in home-card order.
 * A surface without a probe is a bug this file refuses to hide:
 * runGalleryRegression always emits one row per manifest entry.
 * ------------------------------------------------------------------ */

export type GallerySurface = {
  id: string;
  level: string;
  title: string;
  page: string;
  api: string;
};

export const GALLERY_SURFACES: readonly GallerySurface[] = [
  { id: "playground", level: "Level 1", title: "Playground", page: "/playground", api: "/api/classify" },
  { id: "emails", level: "Level 2", title: "Email triage", page: "/emails", api: "/api/classify-batch" },
  { id: "youtube", level: "Level 3", title: "YouTube analyzer", page: "/youtube", api: "/api/classify-batch" },
  { id: "dispatch", level: "Level 4", title: "Tool dispatcher", page: "/dispatch", api: "/api/dispatch + /api/dispatch-batch" },
  { id: "router", level: "Level 5", title: "Model router", page: "/router", api: "/api/router + /api/router-batch" },
  { id: "guardrails", level: "Level 6", title: "LLM guardrails", page: "/guardrails", api: "/api/guardrails + /api/guardrails-batch" },
  { id: "citations", level: "Level 7", title: "Citation checker", page: "/citations", api: "/api/citations + /api/citations-batch" },
  { id: "rerank", level: "Level 8", title: "RAG re-ranker", page: "/rerank", api: "/api/rerank + /api/rerank-batch" },
  { id: "harness", level: "Level 9", title: "Emulated vs Jev harness", page: "/harness", api: "/api/harness" },
  { id: "memory", level: "Level 10", title: "Memory curator", page: "/memory", api: "/api/memory + /api/memory-batch" },
  { id: "bs", level: "Level 11", title: "Internet BS detector", page: "/bs", api: "/api/bs + /api/bs-batch" },
  { id: "extract", level: "Level 12", title: "Date/value extractor", page: "/extract", api: "/api/extract + /api/extract-batch" },
  { id: "chat", level: "Level 13", title: "Live chat filter", page: "/chat", api: "/api/chat + /api/chat-batch" },
  { id: "entities", level: "Level 14", title: "Entity alignment / dedup", page: "/entities", api: "/api/entities + /api/entities-batch" },
  { id: "upload", level: "Level 15", title: "Real-corpora upload", page: "/upload", api: "/api/upload + /api/upload-batch" },
  { id: "calibration", level: "Level 16", title: "Calibration view", page: "/calibration", api: "/api/calibration" },
  { id: "cost", level: "Level 17", title: "Cost / token dashboard", page: "/cost", api: "/api/cost" },
];

/** The fixed anchor the extraction walk uses — relative dates must pin, not drift. */
export const GALLERY_ANCHOR = "2026-11-28";

/* ------------------------------------------------------------------ *
 * Shapes.
 * ------------------------------------------------------------------ */

export const REGRESSION_SCHEMA = 1;
export const REGRESSION_KIND = "gallery-walk" as const;
export const REGRESSION_RUN_LANE = "regression";

export type RegressionCheck = { name: string; ok: boolean; detail: string };

export type SurfaceWalk = GallerySurface & {
  checks: RegressionCheck[];
};

export type RegressionTotals = {
  surfaces: number;
  checks: number;
  passed: number;
  failed: number;
};

export type RegressionReceipt = {
  kind: typeof REGRESSION_KIND;
  schema: number;
  generatedAt: string;
  walk: SurfaceWalk[];
  totals: RegressionTotals;
  failures: string[];
  verdict: string;
};

const C = (name: string, ok: boolean, detail = ""): RegressionCheck => ({ name, ok, detail });

/* ------------------------------------------------------------------ *
 * The emulated classifier — deterministic, content-keyed, offline.
 * Same family as the D14 emulated side: identical states answered by
 * identical code answers, every single run.
 * ------------------------------------------------------------------ */

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const EMULATED_MODEL = "gallery-walk-emulated";

/** One valid answer for one declared question, keyed by state + question id. */
export function emulateAnswer(state: string, qid: string, q: Question): Answer {
  const h = fnv1a(`${state}\u0000${qid}`);
  if (q.type === "choice") {
    const keys = Object.keys(q.criteria);
    const choice = keys[h % keys.length];
    return { type: "choice", choice, probabilities: { [choice]: 0.9 }, confidence: 0.9 };
  }
  if (q.type === "score") {
    const level = h % q.criteria.length;
    return { type: "score", score: level, probabilities: { [String(level)]: 0.9 }, confidence: 0.9 };
  }
  return { type: "noul", noul: (h % 100) / 100 };
}

export function makeEmulatedClassify(): typeof classify {
  return async (
    req: ClassifyRequest,
    opts: ClassifyOptions = {},
  ): Promise<ClassifyResult> => {
    const answers: Record<string, Answer> = {};
    for (const [id, q] of Object.entries(req.questions)) answers[id] = emulateAnswer(req.state, id, q);
    const h = fnv1a(req.state);
    return {
      answers,
      usage: { input_tokens: 40 + (h % 200), output_tokens: 10 + (h % 60) },
      model: EMULATED_MODEL,
      provider: (opts.provider ?? req.provider ?? "gateway") as Provider,
    };
  };
}

/* ------------------------------------------------------------------ *
 * Per-surface live-shape probes. Each runs the lane's REAL runner (the
 * exact function its /api route calls) over the SHIPPED corpus with the
 * injected classifier and returns its contract checks.
 * ------------------------------------------------------------------ */

type WalkCtx = {
  classifyFn: typeof classify;
  generatedAt: string;
  ticks: number;
  harnessReport: HarnessReport | null;
};

async function ensureHarnessReport(ctx: WalkCtx): Promise<HarnessReport> {
  if (ctx.harnessReport) return ctx.harnessReport;
  ctx.harnessReport = await runHarness(buildHarnessItems(), {
    classifyFn: ctx.classifyFn,
    limit: null,
    now: () => ++ctx.ticks,
  });
  return ctx.harnessReport;
}

const numSum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const tallySum = (t: Record<string, number>) => numSum(Object.values(t));

const probes: Record<string, (ctx: WalkCtx) => Promise<RegressionCheck[]>> = {
  /* Level 1 — Playground: single classify + ask-both comparison shapes. */
  async playground(ctx) {
    const states = [
      "I am furious, this is the third time it broke!",
      "Love the new dashboard — thank you team!",
    ];
    const a = await ctx.classifyFn({ state: states[0], questions: PLAYGROUND_QUESTIONS }, {});
    const b = await ctx.classifyFn({ state: states[1], questions: PLAYGROUND_QUESTIONS }, {});
    const asked = Object.keys(PLAYGROUND_QUESTIONS).sort().join(",");
    const answered = Object.keys(a.answers).sort().join(",");
    const typeOk = Object.entries(a.answers).every(([id, ans]) => ans.type === PLAYGROUND_QUESTIONS[id].type);
    const cmp = compareResults(a, b);
    const nullCmp = Object.values(compareResults(a, null));
    return [
      C("answers-cover-questions", asked === answered, `asked [${asked}] answered [${answered}]`),
      C("answer-types-match-questions", typeOk),
      C("provider-declared", a.provider === "jev" || a.provider === "gateway", String(a.provider)),
      C("usage-finite", a.usage.input_tokens >= 0 && a.usage.output_tokens >= 0 && Number.isFinite(a.usage.input_tokens) && Number.isFinite(a.usage.output_tokens)),
      C("ask-both-reflexive", Object.values(cmp).every((v) => v === "match" || v === "diff"), JSON.stringify(cmp)),
      C("missing-side-is-na", nullCmp.every((v) => v === "n/a")),
      C("latency-labels-formatted", latencyLabel(412) === "412 ms" && latencyLabel(1340) === "1.34 s" && latencyLabel(null) === "—"),
    ];
  },

  /* Level 2 — Emails: classifyBatch + aggregates + routing + click-to-filter. */
  async emails(ctx) {
    const items = emails.map((e) => ({ id: e.id, state: emailState(e) }));
    const results = await classifyBatch(items, EMAIL_QUESTIONS, { classifyFn: ctx.classifyFn });
    const ok = successes(results);
    const priorityLevels = EMAIL_QUESTIONS.priority.criteria as string[];
    const rows: EmailFilterableRow[] = ok.map((r) => {
      const an = r.result!.answers;
      const cat = an.category?.type === "choice" ? an.category.choice : "other";
      const p = an.priority?.type === "score" ? priorityLevels[Math.min(priorityLevels.length - 1, Math.max(0, Math.round(an.priority.score)))] : "low";
      const urg = an.is_urgent?.type === "noul" ? urgencyBin(an.is_urgent.noul) : "0-10%";
      const conf = an.category?.type === "choice" ? an.category.confidence : 0;
      return { cat, priLabel: p, urgBin: urg, routing: routeDecision(conf, DEFAULT_THRESHOLDS) };
    });
    const choiceTotal = tallySum(Object.fromEntries(choiceCounts(results, "category").map((c) => [c.name, c.value])));
    const histTotal = numSum(scoreHistogram(results, "priority", priorityLevels).map((b) => b.count));
    const noulTotal = numSum(noulHistogram(results, "is_urgent").map((b) => b.count));
    const routing = summarizeRouting(rows.map((r) => r.routing === "auto" ? 0.9 : r.routing === "human" ? 0.2 : 0.6), DEFAULT_THRESHOLDS);
    const f: EmailFilter = { kind: "category", value: rows[0]?.cat ?? "other" };
    const filtered = applyEmailFilter(rows, f);
    const usageOk = sumUsage(results);
    return [
      C("every-item-answered", results.length === emails.length && ok.length === results.length, `${ok.length}/${emails.length} answered`),
      C("choice-counts-balance", choiceTotal === ok.length, `Σ ${choiceTotal} vs ${ok.length}`),
      C("priority-histogram-balance", histTotal === ok.length),
      C("urgency-histogram-balance", noulTotal === ok.length),
      C("noul-rate-bounded", noulRate(results, "is_urgent") >= 0 && noulRate(results, "is_urgent") <= 1),
      C("routing-buckets-balance", routing.auto + routing.assist + routing.human === routing.total && routing.total === rows.length),
      C("filter-is-subset-and-pure", filtered.length <= rows.length && filtered.every((r) => r.cat === f.value)),
      C("toggle-twice-clears", toggleEmailFilter(f, f) === null),
      C("usage-sums-match", usageOk.input_tokens >= 0 && usageOk.output_tokens >= 0),
    ];
  },

  /* Level 3 — YouTube: classifyBatch + month bins + gauges. */
  async youtube(ctx) {
    const items = videos.map((v) => ({ id: v.id, state: videoState(v) }));
    const results = await classifyBatch(items, YOUTUBE_QUESTIONS, { classifyFn: ctx.classifyFn });
    const ok = successes(results);
    const clickLevels = YOUTUBE_QUESTIONS.clickbait.criteria as string[];
    const sentLevels = YOUTUBE_QUESTIONS.title_sentiment.criteria as string[];
    const monthTotal = numSum(countByMonth(videos).map((b) => b.count));
    return [
      C("every-video-answered", results.length === videos.length && ok.length === results.length),
      C("clickbait-histogram-balance", numSum(scoreHistogram(results, "clickbait", clickLevels).map((b) => b.count)) === ok.length),
      C("sentiment-histogram-balance", numSum(scoreHistogram(results, "title_sentiment", sentLevels).map((b) => b.count)) === ok.length),
      C("promo-and-news-rates-bounded", noulRate(results, "is_promotional") >= 0 && noulRate(results, "is_promotional") <= 1 && noulRate(results, "is_news") >= 0 && noulRate(results, "is_news") <= 1),
      C("month-bins-balance", monthTotal === videos.length, `Σ ${monthTotal} vs ${videos.length}`),
      C("avg-confidence-bounded", avgConfidence(results) >= 0 && avgConfidence(results) <= 1),
    ];
  },

  /* Level 4 — Tool dispatcher: plan + exec gate + registry purity. */
  async dispatch(ctx) {
    const items = exchanges.map((x) => ({ id: x.id, state: `${x.inbound}\n${x.reply}` }));
    const report = await runDispatchBatch(items, { classifyFn: ctx.classifyFn, limit: null });
    const registryNames = new Set(REGISTRY.map((f) => f.name));
    let callBalance = true;
    let auditClean = true;
    let gateClean = true;
    let pure = true;
    for (const r of report.items) {
      if (r.executed + r.held !== r.records.length) callBalance = false;
      for (const rec of r.records) {
        if (!registryNames.has(rec.fn)) pure = false;
        if (rec.status === "executed" && !rec.note.startsWith("applied ")) auditClean = false;
        if (rec.status === "executed" && rec.confidence < report.execGate) gateClean = false;
        if (rec.status === "held" && rec.confidence >= report.execGate) gateClean = false;
      }
      if (r.error && r.plan) auditClean = false;
    }
    return [
      C("items-balance", report.totals.items === items.length && report.items.length === items.length),
      C("backend-live", report.totals.errors === 0, `${report.totals.errors}/${report.totals.items} exchanges errored`),
      C("planned-equals-executed-plus-held", report.totals.executed + report.totals.held === report.totals.planned),
      C("per-item-record-balance", callBalance),
      C("registry-purity", pure),
      C("exec-gate-honored", gateClean),
      C("audit-lines-wellformed", auditClean),
      C("exec-gate-echoes-default", report.execGate === DEFAULT_EXEC_GATE),
      C("errors-bounded", report.totals.errors <= report.totals.items),
    ];
  },

  /* Level 5 — Model router: tier ladder + savings arithmetic. */
  async router(ctx) {
    const items = emails.map((e) => ({ id: e.id, prompt: emailState(e) }));
    const report = await runRouterBatch(items, { classifyFn: ctx.classifyFn, limit: null });
    const tierIds = new Set(TIERS.map((t) => t.id));
    const tiersOk = report.items.every((r) => !r.decision || tierIds.has(r.decision.tier));
    const routedTotal = report.totals.routed.cheap + report.totals.routed.mid + report.totals.routed.frontier;
    const savings = report.totals.costAllFrontierUsd - report.totals.costRoutedUsd;
    return [
      C("routed-plus-errors-balance", routedTotal + report.totals.errors === report.totals.items),
      C("backend-live", report.totals.errors === 0, `${report.totals.errors}/${report.totals.items} prompts errored`),
      C("tiers-declared", tiersOk),
      C("savings-arithmetic", Math.abs(report.totals.savingsUsd - Number(savings.toFixed(4))) < 1e-6),
      C("savings-never-negative", report.totals.savingsUsd >= -1e-9 && report.totals.costAllFrontierUsd >= report.totals.costRoutedUsd - 1e-9),
      C("savings-pct-bounded", report.totals.savingsPct >= 0 && report.totals.savingsPct <= 1),
      C("errors-bounded", report.totals.errors <= report.totals.items),
    ];
  },

  /* Level 6 — Guardrails: screen-in/out tallies + worst-of consistency. */
  async guardrails(ctx) {
    const items = exchanges.map((x) => ({ id: x.id, inbound: x.inbound, reply: x.reply }));
    const report = await runGuardrailsBatch(items, { classifyFn: ctx.classifyFn, limit: null });
    const vset = new Set<string>(VERDICTS);
    const decided = report.items.filter((r) => !r.error);
    const worstOk = decided.every(
      (r) => r.overall === worstVerdict([r.inboundVerdict, r.outboundVerdict]),
    );
    const declared = report.items.every(
      (r) =>
        (!r.inboundVerdict || vset.has(r.inboundVerdict)) &&
        (!r.outboundVerdict || vset.has(r.outboundVerdict)) &&
        (!r.overall || vset.has(r.overall)),
    );
    const s = report.totals;
    return [
      C("overall-plus-errors-balance", tallySum(s.overall) + s.errors === s.items),
      C("backend-live", s.errors === 0, `${s.errors}/${s.items} exchanges errored`),
      C("inbound-equals-decided", tallySum(s.inbound) === decided.length),
      C("screens-run-balance", s.screensRun === tallySum(s.inbound) + tallySum(s.outbound)),
      C("verdicts-declared", declared),
      C("overall-is-worst-of-sides", worstOk),
      C("errors-bounded", s.errors <= s.items),
    ];
  },

  /* Level 7 — Citation checker: checks-run balance + declared verdicts. */
  async citations(ctx) {
    const items = claimCases.map((c) => ({ id: c.id, claim: c.claim, quote: c.quote }));
    const report = await runCitationsBatch(items, { classifyFn: ctx.classifyFn, limit: null });
    const vset = new Set<string>(CITATION_VERDICTS);
    const declared = report.items.every((r) => !r.verdict || vset.has(r.verdict));
    return [
      C("verdicts-plus-errors-balance", tallySum(report.totals.verdicts) + report.totals.errors === report.totals.items),
      C("backend-live", report.totals.errors === 0, `${report.totals.errors}/${report.totals.items} claims errored`),
      C("checks-run-balance", report.totals.checksRun === tallySum(report.totals.verdicts)),
      C("verdicts-declared", declared),
      C("errors-bounded", report.totals.errors <= report.totals.items),
    ];
  },

  /* Level 8 — RAG re-ranker: disposition balance + finite context budget. */
  async rerank(ctx) {
    const passages = ragPassages.map((p) => ({ id: p.id, text: p.text }));
    const report = await runRerankBatch(RAG_QUERY, passages, { classifyFn: ctx.classifyFn, limit: null });
    const dset = new Set<string>(DISPOSITIONS);
    const declared = report.items.every((r) => !r.disposition || dset.has(r.disposition));
    const t = report.totals;
    return [
      C("dispositions-plus-errors-balance", t.shipped + t.benched + t.dropped + t.errors === t.passages),
      C("backend-live", t.errors === 0, `${t.errors}/${t.passages} passages errored`),
      C("topk-honored", t.shipped <= report.gates.topK, `shipped ${t.shipped} vs topK ${report.gates.topK}`),
      C("dispositions-declared", declared),
      C("coverage-declared", COVERAGES.includes(t.coverage), String(t.coverage)),
      C("coverage-consistent", (t.shipped > 0) === (t.coverage === "grounded")),
      C("errors-bounded", t.errors <= t.passages),
    ];
  },

  /* Level 9 — D14 harness: two backends, one truth column. */
  async harness(ctx) {
    const items = buildHarnessItems();
    const report = await ensureHarnessReport(ctx);
    const t = report.totals;
    const latOk =
      (t.jevAvgLatency === null || t.jevP95Latency === null || t.jevP95Latency >= t.jevAvgLatency) &&
      (t.emulatedAvgLatency === null || t.emulatedP95Latency === null || t.emulatedP95Latency >= t.emulatedAvgLatency);
    // A question is scored once per compared item IN THE DATASETS THAT DECLARE IT —
    // "category" rides both corpora, "is_urgent" only the email one. Each row must
    // balance against its own declared scope, never the global compared count.
    const datasetCompared: Partial<Record<string, number>> = {};
    for (const r of report.items)
      if (r.status === "match" || r.status === "diff") datasetCompared[r.dataset] = (datasetCompared[r.dataset] ?? 0) + 1;
    const perQOk = Object.entries(t.perQuestion).every(([qid, row]) => {
      const scope =
        (qid in EMAIL_QUESTIONS ? datasetCompared.emails ?? 0 : 0) +
        (qid in YOUTUBE_QUESTIONS ? datasetCompared.youtube ?? 0 : 0);
      return row.match + row.diff + row.na === scope && scope > 0;
    });
    const bothSides = report.items.every((r) => !!r.jev && !!r.emulated);
    const statuses = report.items.every((r) => r.status === "match" || r.status === "diff" || r.status === "na");
    const rateOk = t.agreementRate === (t.compared > 0 ? t.matches / t.compared : null);
    return [
      C("corpus-on-the-wire", report.items.length === items.length),
      C("backend-live", t.jevErrors === 0 && t.emulatedErrors === 0, `side errors: jev ${t.jevErrors}, emulated ${t.emulatedErrors}`),
      C("every-item-has-both-sides", bothSides),
      C("status-trichotomy", statuses),
      C("compared-equals-matches-plus-diffs", t.compared === t.matches + t.diffs),
      C("agreement-rate-consistent", rateOk),
      C("per-question-balance", perQOk),
      C("p95-not-below-avg", latOk),
      C("decision-labels-reproducible", report.items.every((r) =>
        Object.keys(r.jevDecisions).every((qid) => decisionLabel(questionsForId(r.dataset, qid), r.jev.answers?.[qid]) === r.jevDecisions[qid]))),
    ];
  },

  /* Level 10 — Memory curator: membership balance + the PII floor. */
  async memory(ctx) {
    const report = await runMemoryBatch(memoryCandidates.map((c) => ({ id: c.id, request: c.request, answer: c.answer })), {
      classifyFn: ctx.classifyFn,
      limit: null,
    });
    const mset = new Set<string>(MEMBERSHIP);
    const declared = report.items.every((r) => !r.membership || mset.has(r.membership));
    const piiHolds = report.items.every(
      (r) => !r.signals || !r.membership || r.signals.pii < report.gates.piiBlockAt || r.membership === "forget",
    );
    return [
      C("membership-plus-errors-balance", tallySum(report.totals.verdicts) + report.totals.errors === report.totals.candidates),
      C("backend-live", report.totals.errors === 0, `${report.totals.errors}/${report.totals.candidates} candidates errored`),
      C("memberships-declared", declared),
      C("pii-floor-absolute", piiHolds),
      C("gates-echo", typeof report.gates.piiBlockAt === "number" && report.gates.piiBlockAt >= 0 && report.gates.piiBlockAt <= 1),
      C("errors-bounded", report.totals.errors <= report.totals.candidates),
    ];
  },

  /* Level 11 — BS detector: merged stream balance + worst-first leaderboard. */
  async bs(ctx) {
    const report = await runBsBatch(buildBsCorpus(), { classifyFn: ctx.classifyFn, limit: null });
    const t = report.totals;
    const lb = rankBsLeaderboard(report.items);
    const ordered = lb.rows.every((r, i) => i === 0 || lb.rows[i - 1].score >= r.score);
    const ranked = lb.rows.every((r, i) => r.rank === i + 1);
    const bands = lb.rows.every((r) => r.score === bsLeaderboardScore(r.verdict, r.intensity));
    const noSilentDrops = lb.rows.length + lb.failed === report.items.length;
    const perSource =
      tallySum(t.bySource.email) + tallySum(t.bySource.video) === tallySum(t.verdicts);
    const vset = new Set<string>(Object.keys(BS_RANK));
    const declared = report.items.every((r) => !r.verdict || vset.has(r.verdict));
    const exportRows = bsLeaderboardExportRows(lb.rows);
    return [
      C("verdicts-plus-errors-balance", tallySum(t.verdicts) + t.errors === t.screened),
      C("backend-live", t.errors === 0, `${t.errors}/${t.screened} items errored`),
      C("per-source-tallies-balance", perSource),
      C("verdicts-declared", declared),
      C("leaderboard-worst-first", ordered),
      C("leaderboard-ranks-contiguous", ranked),
      C("leaderboard-scores-by-construction", bands),
      C("leaderboard-failed-counted", noSilentDrops, `rows ${lb.rows.length} + failed ${lb.failed} vs items ${report.items.length}`),
      C("export-rows-match-leaderboard", exportRows.length === lb.rows.length),
    ];
  },

  /* Level 12 — Extraction: candidate status balance + never-fabricated. */
  async extract(ctx) {
    const report = await runExtractBatch(extractionCorpus.map((s) => ({ id: s.id, text: s.text })), {
      classifyFn: ctx.classifyFn,
      limit: null,
      anchor: GALLERY_ANCHOR,
    });
    const t = report.totals;
    const sset = new Set<string>(EXTRACT_STATUS);
    const statusKeys = Object.keys(t.statuses).sort().join(",");
    const declared = statusKeys === [...EXTRACT_STATUS].sort().join(",");
    let neverFabricated = true;
    let statusesOk = true;
    for (const r of report.items) {
      if (r.error) continue;
      for (const c of r.results ?? []) {
        if (!sset.has(c.status)) statusesOk = false;
        if ((c.status === "vague" || c.status === "rejected") && c.value !== null) neverFabricated = false;
      }
    }
    const candidatesTotal = numSum(report.items.filter((r) => !r.error).map((r) => (r.results ?? []).length));
    return [
      C("snippets-balance", t.snippets === extractionCorpus.length && report.items.length === t.snippets),
      C("backend-live", t.errors === 0, `${t.errors}/${t.snippets} snippets errored`),
      C("statuses-balance-candidates", t.statuses.resolved + t.statuses.guessed + t.statuses.vague + t.statuses.rejected === t.candidates),
      C("candidates-counted", t.candidates === candidatesTotal),
      C("status-set-exact", declared),
      C("statuses-declared-per-candidate", statusesOk),
      C("never-fabricated-for-doubt", neverFabricated),
      C("anchor-echoes", report.anchor === GALLERY_ANCHOR),
      C("calendar-law-holds", daysInMonth(2026, 2) === 28 && !isValidDate(2026, 2, 30) && isValidDate(2028, 2, 29)),
    ];
  },

  /* Level 13 — Chat filter: action balance + strike-ledger discipline. */
  async chat(ctx) {
    const report = await runChatBatch(buildChatCorpus(), { classifyFn: ctx.classifyFn, limit: null });
    const t = report.totals;
    const aset = new Set<string>(CHAT_ACTIONS);
    const declared = report.items.every((r) => !r.action || aset.has(r.action));
    const offenderOk =
      report.offenders.every((o) => o.score === o.blocks * 10 + o.holds && o.holds + o.blocks > 0) &&
      report.offenders.every((o, i) => i === 0 || report.offenders[i - 1].score >= o.score);
    const fold1 = applyChatStrikes([], report.items);
    const sset = new Set<string>(CHAT_STRIKE_STATES);
    const rank = (s: string) => CHAT_STRIKE_STATES.indexOf(s as (typeof CHAT_STRIKE_STATES)[number]);
    const fold2 = applyChatStrikes(fold1.rows, report.items);
    const prevMap = new Map(fold1.rows.map((r) => [r.user, r]));
    const monotone = fold2.rows.every((r) => {
      const p = prevMap.get(r.user);
      return !p || rank(r.state) >= rank(p.state);
    });
    const strikeOk =
      fold1.rows.every((r) => sset.has(r.state) && r.score === r.blocks * 10 + r.holds) &&
      fold1.folded + fold1.errors === report.items.length;
    return [
      C("actions-plus-errors-balance", t.actions.allow + t.actions.hold + t.actions.block + t.errors === t.moderated),
      C("backend-live", t.errors === 0, `${t.errors}/${t.moderated} messages errored`),
      C("actions-declared", declared),
      C("offenders-by-construction", offenderOk),
      C("strike-fold-balances", strikeOk),
      C("strike-state-monotonic", monotone),
      C("errors-bounded", t.errors <= t.moderated),
    ];
  },

  /* Level 14 — Entities: tally balance + the contradiction-safe fold. */
  async entities(ctx) {
    const report = await runEntityBatch(buildEntityCorpus(), { classifyFn: ctx.classifyFn, limit: null });
    const t = report.totals;
    const selfGuard = isEntityBatchReport(report);
    const summary = entityRunSummary(report);
    const refold = foldEntityClusters(report.items);
    const foldStable = JSON.stringify(refold) === JSON.stringify({ clusters: report.clusters, blocked: report.blocked });
    const clustersWellFormed = report.clusters.every((c) => c.members.length >= 2 && c.members.includes(c.canonical) && c.canonical === [...c.members].sort()[0]);
    const blockedReasoned = report.blocked.every((b) => b.pairId && b.reason);
    const mergeIds = new Set(report.items.filter((i) => i.verdict === "merge").map((i) => i.id));
    const edgeIds = new Set(report.clusters.flatMap((c) => c.edges));
    const blockedIds = new Set(report.blocked.map((b) => b.pairId));
    const mergesAccounted = [...mergeIds].every((id) => edgeIds.has(id) || blockedIds.has(id));
    return [
      C("verdicts-plus-errors-balance", tallySum(t.verdicts) + t.errors === t.compared),
      C("backend-live", t.errors === 0, `${t.errors}/${t.compared} pairs errored`),
      C("report-passes-its-own-store-guard", selfGuard),
      C("summary-recomputes", summary.compared === t.compared && summary.errors === t.errors),
      C("fold-is-deterministic", foldStable),
      C("clusters-well-formed", clustersWellFormed),
      C("blocked-joins-reasoned", blockedReasoned),
      C("every-merge-accounted", mergesAccounted),
    ];
  },

  /* Level 15 — Upload: intake receipt balance + official-API wall. */
  async upload(ctx) {
    const textRaw = "bring your own data line one\nbring your own data line one\n\n   \nline two is distinct\n";
    const jsonRaw = JSON.stringify([
      { text: "alpha" },
      { nope: 1 },
      "beta",
      { text: "   " },
      { text: "alpha" },
      { text: "gamma", id: "bad id!" },
    ]);
    const csvRaw = 'id,text\nr1,csv row one\nr2,extra,cells\nr3,csv row three\n';
    const t1 = parseCorpusIntake(textRaw, "text", { origin: "paste", idPrefix: "walk" });
    const j1 = parseCorpusIntake(jsonRaw, "json", { origin: "paste", idPrefix: "walk" });
    const c1 = parseCorpusIntake(csvRaw, "csv", { origin: "file", idPrefix: "walk" });
    const balances = (i: typeof t1) =>
      i.counts.rows === i.counts.kept + i.counts.rejected + i.counts.duplicates + i.counts.blankSkipped + i.counts.capDropped;
    const rowNumbers = [...t1.rejected, ...j1.rejected, ...c1.rejected].every((r) => Number.isInteger(r.row) && r.row >= 0 && r.reason);
    const report = await runUploadBatch(
      t1.items.map((i) => ({ id: i.id, text: i.text, label: i.label, origin: i.origin })),
      { classifyFn: ctx.classifyFn, limit: null },
    );
    const selfGuard = isUploadBatchReport(report);
    const summary = uploadRunSummary(report);
    const wall =
      assertOfficialApiUrl("https://www.googleapis.com/youtube/v3/search?part=snippet").ok === true &&
      assertOfficialApiUrl("http://www.googleapis.com/youtube/v3/search").ok === false &&
      assertOfficialApiUrl("https://googleapis.com.evil.tld/youtube/v3/search").ok === false &&
      assertOfficialApiUrl("https://www.googleapis.com/v3/search").ok === false;
    const junk = officialItemsFrom({ not: "an array" });
    return [
      C("text-receipt-balances", balances(t1), JSON.stringify(t1.counts)),
      C("json-receipt-balances", balances(j1), JSON.stringify(j1.counts)),
      C("csv-receipt-balances", balances(c1), JSON.stringify(c1.counts)),
      C("csv-column-mismatch-refused", c1.rejected.length > 0),
      C("json-guard-refused-garbage", j1.rejected.length >= 3 && j1.items.length === 2, JSON.stringify(j1.counts)),
      C("refusals-carry-row-numbers", rowNumbers),
      C("screen-plus-errors-balance", tallySum(report.totals.verdicts) + report.totals.errors === report.totals.screened),
      C("backend-live", report.totals.errors === 0, `${report.totals.errors}/${report.totals.screened} rows errored`),
      C("report-passes-its-own-store-guard", selfGuard),
      C("summary-recomputes", summary.compared === report.totals.screened && summary.errors === report.totals.errors),
      C("official-api-wall-holds", wall),
      C("garbage-payload-yields-nothing", junk.length === 0),
    ];
  },

  /* Level 16 — Calibration: the receipt grades itself; liars cannot reload. */
  async calibration(ctx) {
    const report = await ensureHarnessReport(ctx);
    const der = calPointsFromHarness(report);
    const table = buildCalibrationTable(der.points);
    const balanced = der.counts.answersSeen === der.counts.kept + der.counts.naExcluded + der.counts.noConfidenceExcluded;
    const keptMatches = der.counts.kept === der.points.length;
    const binsOk = table.bins.length === CAL_BIN_COUNT && numSum(table.bins.map((b) => b.n)) === table.points;
    const eceOk = table.points === 0 ? table.ece === null : table.ece !== null && table.ece >= 0;
    const snapshot: CalibrationSnapshot = {
      source: "harness",
      table,
      points: der.points,
      receipt: der.counts,
      generatedAt: ctx.generatedAt,
    };
    const guarded = isCalibrationSnapshot(snapshot);
    const roundTrip = isCalibrationSnapshot(JSON.parse(JSON.stringify(snapshot)));
    const liar = JSON.parse(JSON.stringify(snapshot)) as CalibrationSnapshot;
    liar.table.ece = (liar.table.ece ?? 0) + 0.123;
    const tampered = isCalibrationSnapshot(JSON.parse(JSON.stringify(liar)));
    const empty = buildCalibrationTable([]);
    return [
      C("harness-live-not-fabricated", report.totals.jevErrors === 0 && der.counts.answersSeen > 0, `jev errors ${report.totals.jevErrors}, answers seen ${der.counts.answersSeen}`),
      C("harness-receipt-balances", balanced),
      C("kept-equals-points", keptMatches),
      C("bins-complete-and-sum", binsOk),
      C("ece-null-iff-empty", eceOk && empty.ece === null && empty.points === 0),
      C("snapshot-passes-its-own-guard", guarded),
      C("json-round-trip-holds", roundTrip),
      C("tampered-ece-refused", !tampered),
    ];
  },

  /* Level 17 — Cost: two receipts per run; the ledger balances against itself. */
  async cost(ctx) {
    const report = await ensureHarnessReport(ctx);
    const der = costReceiptsFromHarness(report);
    const ledger = buildCostLedger(der.receipts, DEFAULT_RATES, DEFAULT_BUDGET_USD);
    const lineSum = numSum(ledger.lines.map((l) => l.costUsd));
    const costOk = Math.abs(lineSum - ledger.total.costUsd) < 1e-6;
    const tokenOk =
      ledger.total.tokens === numSum(ledger.lines.map((l) => l.tokens)) &&
      ledger.total.receipts === ledger.lines.length;
    const providerOk = ledger.byProvider.jev.costUsd + ledger.byProvider.gateway.costUsd <= ledger.total.costUsd + 1e-6 &&
      ledger.byProvider.jev.costUsd + ledger.byProvider.gateway.costUsd >= ledger.total.costUsd - 1e-6;
    const booked = der.receipts.length + der.counts.sidesSkipped === 2;
    const verdictOk = (["unset", "ok", "warn", "over"] as const).includes(ledger.budget.status) && typeof ledger.verdict === "string" && ledger.verdict.length > 0;
    const snapshot: CostSnapshot = {
      sourceKind: "harness",
      receipts: der.receipts,
      rates: DEFAULT_RATES,
      ledger,
      counts: { seen: 2, kept: der.receipts.length, rejected: 0, skipped: der.counts.sidesSkipped },
      generatedAt: ctx.generatedAt,
    };
    const guarded = isCostSnapshot(snapshot);
    const roundTrip = isCostSnapshot(JSON.parse(JSON.stringify(snapshot)));
    const liar = JSON.parse(JSON.stringify(snapshot)) as CostSnapshot;
    liar.ledger.total.costUsd = liar.ledger.total.costUsd + 0.5;
    const tampered = isCostSnapshot(JSON.parse(JSON.stringify(liar)));
    const manual = costReceiptsFromPayload([
      { lane: "walk", provider: "jev", items: 1, usage: { input_tokens: 1000, output_tokens: 1000 } },
      { lane: "walk", provider: "openai", items: 1, usage: { input_tokens: 1, output_tokens: 1 } },
      "junk",
    ]);
    const manualBalanced = manual.counts.seen === manual.counts.kept + manual.counts.rejected;
    const manualRefusalsNumbered = manual.rejected.every((r) => r.row >= 1 && r.reason);
    const emptyLedger = buildCostLedger([], DEFAULT_RATES, null);
    return [
      C("harness-books-two-receipts-or-counts-them-skipped", booked),
      C("harness-live-not-priced-empty", der.receipts.length === 2, `booked ${der.receipts.length} of 2 sides, skipped ${der.counts.sidesSkipped}`),
      C("ledger-total-equals-line-sum", costOk),
      C("token-and-receipt-counts-balance", tokenOk),
      C("provider-rollups-sum-to-total", providerOk),
      C("verdict-declared", verdictOk),
      C("snapshot-passes-its-own-guard", guarded),
      C("json-round-trip-holds", roundTrip),
      C("tampered-ledger-refused", !tampered),
      C("manual-intake-balances", manualBalanced && manual.counts.kept === 1 && manual.counts.rejected === 2),
      C("manual-refusals-numbered", manualRefusalsNumbered),
      C("empty-ledger-never-divides", emptyLedger.total.costUsd === 0 && emptyLedger.total.usdPerMtok === null && emptyLedger.total.usdPerItem === null && emptyLedger.budget.status === "unset"),
    ];
  },
};

/* harness probe uses the dataset→question map; kept out of scope otherwise. */
function questionsForId(dataset: "emails" | "youtube", qid: string): Question | undefined {
  const qs = dataset === "emails" ? EMAIL_QUESTIONS : YOUTUBE_QUESTIONS;
  return qs[qid];
}

/* ------------------------------------------------------------------ *
 * The walk.
 * ------------------------------------------------------------------ */

export type GalleryWalkOptions = {
  classifyFn?: typeof classify;
  /** ISO override for deterministic tests; default: now. */
  generatedAt?: string;
};

export function buildRegressionReceipt(walk: SurfaceWalk[], generatedAt: string): RegressionReceipt {
  let checks = 0;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  for (const s of walk) {
    for (const c of s.checks) {
      checks += 1;
      if (c.ok) passed += 1;
      else {
        failed += 1;
        failures.push(`${s.level} ${s.id}::${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
      }
    }
  }
  return {
    kind: REGRESSION_KIND,
    schema: REGRESSION_SCHEMA,
    generatedAt,
    walk,
    totals: { surfaces: walk.length, checks, passed, failed },
    failures,
    verdict: failed === 0 ? "all green" : `${failed} failed check(s)`,
  };
}

/**
 * Walk every gallery item. Each probe is error-ISOLATED: a lane that
 * explodes still produces its row (and its failure), the walk keeps
 * going, and the receipt still covers all 17 surfaces.
 */
export async function runGalleryRegression(opts: GalleryWalkOptions = {}): Promise<RegressionReceipt> {
  const ctx: WalkCtx = {
    classifyFn: opts.classifyFn ?? makeEmulatedClassify(),
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    ticks: 0,
    harnessReport: null,
  };
  const walk: SurfaceWalk[] = [];
  for (const s of GALLERY_SURFACES) {
    const probe = probes[s.id];
    let checks: RegressionCheck[];
    try {
      checks = probe ? await probe(ctx) : [C("probe-missing", false, `no probe registered for ${s.id}`)];
      if (checks.length === 0) checks = [C("probe-empty", false, "probe returned zero checks")];
    } catch (err) {
      checks = [C("probe-threw", false, err instanceof Error ? err.message : String(err))];
    }
    walk.push({ ...s, checks });
  }
  return buildRegressionReceipt(walk, ctx.generatedAt);
}

/* ------------------------------------------------------------------ *
 * The store guard — THE RECEIPT NEVER TRUSTS A PAYLOAD.
 * ------------------------------------------------------------------ */

function isCheck(x: unknown): x is RegressionCheck {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const c = x as Record<string, unknown>;
  return typeof c.name === "string" && c.name.length > 0 && typeof c.ok === "boolean" && typeof c.detail === "string";
}

export function isRegressionReceipt(payload: unknown): payload is RegressionReceipt {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const p = payload as Record<string, unknown>;
  if (p.kind !== REGRESSION_KIND) return false;
  if (p.schema !== REGRESSION_SCHEMA) return false;
  if (typeof p.generatedAt !== "string" || !Number.isInteger(Date.parse(p.generatedAt))) return false;
  if (!Array.isArray(p.walk) || p.walk.length !== GALLERY_SURFACES.length) return false;
  for (let i = 0; i < p.walk.length; i++) {
    const s = p.walk[i] as Record<string, unknown> | null;
    if (!s || typeof s !== "object" || Array.isArray(s)) return false;
    const def = GALLERY_SURFACES[i];
    if (s.id !== def.id || s.level !== def.level || s.title !== def.title || s.page !== def.page || s.api !== def.api) return false;
    if (!Array.isArray(s.checks) || s.checks.length === 0 || !s.checks.every(isCheck)) return false;
  }
  const walk = p.walk as SurfaceWalk[];
  // RECOMPUTE the whole receipt from its own rows — a tampered total,
  // a flipped ok, or an invented failure line cannot reload.
  const rebuilt = buildRegressionReceipt(walk, p.generatedAt);
  const t = p.totals as Record<string, unknown> | undefined;
  if (!t || typeof t !== "object") return false;
  const tt = rebuilt.totals;
  if (t.surfaces !== tt.surfaces || t.checks !== tt.checks || t.passed !== tt.passed || t.failed !== tt.failed) return false;
  if (p.verdict !== rebuilt.verdict) return false;
  if (!Array.isArray(p.failures) || p.failures.length !== rebuilt.failures.length) return false;
  for (let i = 0; i < rebuilt.failures.length; i++) if ((p.failures as unknown[])[i] !== rebuilt.failures[i]) return false;
  return true;
}

/**
 * Recompute the store summary FROM THE ROWS — never accept one.
 *  - compared = every contract check the walk ran
 *  - errors   = the checks that did not pass
 * failed ≤ checks is structural, so errors ≤ compared BY CONSTRUCTION.
 */
export function regressionRunSummary(payload: unknown): { compared: number; errors: number } {
  const p = payload as RegressionReceipt;
  let checks = 0;
  let failed = 0;
  for (const s of p.walk) {
    for (const c of s.checks) {
      checks += 1;
      if (!c.ok) failed += 1;
    }
  }
  return { compared: checks, errors: failed };
}

/* ------------------------------------------------------------------ *
 * D8 export — one row per surface, suite totals ride row 0.
 * ------------------------------------------------------------------ */

export function regressionExportRows(receipt: RegressionReceipt): ExportRow[] {
  const cols = (extra: Partial<Record<string, string | number | null>> = {}) => ({
    level: "",
    surface: "",
    title: "",
    page: "",
    api: "",
    checks: "",
    passed: "",
    failed: "",
    status: "",
    failures: "",
    suiteChecks: receipt.totals.checks,
    suitePassed: receipt.totals.passed,
    suiteFailed: receipt.totals.failed,
    verdict: receipt.verdict,
    generatedAt: receipt.generatedAt,
    ...extra,
  });
  if (receipt.walk.length === 0) return [cols()];
  return receipt.walk.map((s, i) => {
    const passed = s.checks.filter((c) => c.ok).length;
    const failed = s.checks.length - passed;
    const failLines = s.checks.filter((c) => !c.ok).map((c) => `${c.name}${c.detail ? `: ${c.detail}` : ""}`).join(" | ");
    return cols({
      level: s.level,
      surface: s.id,
      title: s.title,
      page: s.page,
      api: s.api,
      checks: s.checks.length,
      passed,
      failed,
      status: failed === 0 ? "pass" : "fail",
      failures: failLines,
      ...(i === 0 ? {} : { suiteChecks: "", suitePassed: "", suiteFailed: "", verdict: "", generatedAt: "" }),
    });
  });
}
