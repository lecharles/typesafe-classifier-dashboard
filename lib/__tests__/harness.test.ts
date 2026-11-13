import { describe, it, expect } from "vitest";
import type { Answer, ClassifyRequest, ClassifyResult } from "@/lib/schema";
import type { ClassifyOptions } from "@/lib/classify";
import { BATCH_LADDER } from "@/lib/dispatch";
import {
  HARNESS_DATASETS,
  agreementBadgeClass,
  agreementRateLabel,
  buildHarnessItems,
  computeHarnessTotals,
  compareSides,
  decisionLabel,
  emailState,
  harnessStatusBadgeClass,
  p95,
  questionsForDataset,
  runHarness,
  sideDecisions,
  videoState,
  type HarnessItem,
  type HarnessItemReport,
  type HarnessSide,
} from "@/lib/harness";
import { EMAIL_QUESTIONS, YOUTUBE_QUESTIONS } from "@/data/questions";

const choice = (c: string, conf = 0.9): Answer => ({
  type: "choice",
  choice: c,
  probabilities: { [c]: conf },
  confidence: conf,
});
const score = (s: number, conf = 0.8): Answer => ({
  type: "score",
  score: s,
  probabilities: {},
  confidence: conf,
});
const noul = (p: number): Answer => ({ type: "noul", noul: p });

const side = (over: Partial<HarnessSide> & Pick<HarnessSide, "provider">): HarnessSide => ({
  ok: true,
  ...over,
});

const jevOk = (answers?: Record<string, Answer>): HarnessSide =>
  side({
    provider: "jev",
    answers: answers ?? { category: choice("bug"), is_urgent: noul(0.9), priority: score(3.1) },
    model: "jev-latest",
    usage: { input_tokens: 10, output_tokens: 2 },
    latency_ms: 300,
  });

const gwOk = (answers?: Record<string, Answer>): HarnessSide =>
  side({
    provider: "gateway",
    answers: answers ?? { category: choice("bug"), is_urgent: noul(0.7), priority: score(2.9) },
    model: "anthropic/claude-3-haiku",
    usage: { input_tokens: 500, output_tokens: 20 },
    latency_ms: 700,
  });

const jevFail = (): HarnessSide => ({ provider: "jev", ok: false, error: "jev is down", latency_ms: 120 });
const gwFail = (): HarnessSide => ({ provider: "gateway", ok: false, error: "gateway is down", latency_ms: 240 });

function report(
  id: string,
  dataset: "emails" | "youtube",
  status: HarnessItemReport["status"],
  jev: HarnessSide,
  emulated: HarnessSide,
  agreement: HarnessItemReport["agreement"] = {},
): HarnessItemReport {
  return {
    id,
    dataset,
    status,
    agreement,
    diffQuestions: Object.keys(agreement).filter((q) => agreement[q] === "diff"),
    jev,
    emulated,
    jevDecisions: {},
    emulatedDecisions: {},
  };
}

type Mode = "match" | "jev-differs" | "gw-differs" | "jev-throws" | "gw-throws";

function fakeClassify(mode: Mode, calls: { provider?: string; state: string; opts: ClassifyOptions }[] = []) {
  const fn = async (req: ClassifyRequest, opts: ClassifyOptions = {}): Promise<ClassifyResult> => {
    calls.push({ provider: opts.provider, state: req.state, opts });
    const provider = opts.provider ?? "gateway";
    if (provider === "jev") {
      if (mode === "jev-throws") throw new Error("jev is down");
      return {
        answers: {
          category: choice(mode === "jev-differs" ? "praise" : "bug"),
          is_urgent: noul(0.9),
          priority: score(3.1),
        },
        usage: { input_tokens: 10, output_tokens: 2 },
        model: "jev-latest",
        provider: "jev",
      };
    }
    if (mode === "gw-throws") throw new Error("gateway is down");
    return {
      answers: {
        category: choice(mode === "gw-differs" ? "complaint" : "bug"),
        is_urgent: noul(0.7),
        priority: score(2.9),
      },
      usage: { input_tokens: 500, output_tokens: 20 },
      model: "anthropic/claude-3-haiku",
      provider: "gateway",
    };
  };
  return { fn, calls };
}

const emailItems = (n: number): HarnessItem[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `e${String(i + 1).padStart(2, "0")}`,
    dataset: "emails" as const,
    state: `Subject: crash ${i + 1}\n\nbody`,
  }));

describe("dataset state builders", () => {
  it("matches the live dashboards' email state", () => {
    expect(emailState({ id: "e1", subject: "Broken", body: "It broke." })).toBe("Subject: Broken\n\nIt broke.");
  });

  it("matches the live dashboards' video state", () => {
    const v = { id: "v1", title: "T", description: "D", channel: "C", publishedAt: "2026-01-01" };
    expect(videoState(v)).toBe("Title: T\nChannel: C\nDescription: D");
  });

  it("exposes both bundled datasets", () => {
    expect(HARNESS_DATASETS.map((d) => d.id)).toEqual(["emails", "youtube"]);
  });

  it("builds the full 90-item corpus with unique ids", () => {
    const items = buildHarnessItems();
    expect(items.length).toBe(90);
    expect(new Set(items.map((i) => i.id)).size).toBe(90);
    expect(items.filter((i) => i.dataset === "emails")).toHaveLength(40);
    expect(items.filter((i) => i.dataset === "youtube").every((i) => i.id.startsWith("yt-"))).toBe(true);
  });

  it("honors dataset filters", () => {
    expect(buildHarnessItems(["youtube"])).toHaveLength(50);
    expect(buildHarnessItems(["emails"])).toHaveLength(40);
  });

  it("wires each dataset to its own question set", () => {
    expect(questionsForDataset("emails")).toBe(EMAIL_QUESTIONS);
    expect(questionsForDataset("youtube")).toBe(YOUTUBE_QUESTIONS);
  });
});

describe("decisionLabel + sideDecisions", () => {
  it("labels choice as the option key and noul as yes/no at the .5 cut", () => {
    expect(decisionLabel(EMAIL_QUESTIONS.category, choice("bug"))).toBe("bug");
    expect(decisionLabel(EMAIL_QUESTIONS.is_urgent, noul(0.6))).toBe("yes");
    expect(decisionLabel(EMAIL_QUESTIONS.is_urgent, noul(0.4))).toBe("no");
  });

  it("labels scores with the level NAME at the rounded index", () => {
    expect(decisionLabel(EMAIL_QUESTIONS.priority, score(2.4))).toBe("2 · medium");
    expect(decisionLabel(EMAIL_QUESTIONS.priority, score(3.6))).toBe("4 · critical");
  });

  it("clamps out-of-range scores and tolerates missing pieces", () => {
    expect(decisionLabel(EMAIL_QUESTIONS.priority, score(-1))).toBe("0 · trivial");
    expect(decisionLabel(EMAIL_QUESTIONS.priority, score(99))).toBe("4 · critical");
    expect(decisionLabel(undefined, score(2))).toBe("2");
    expect(decisionLabel(EMAIL_QUESTIONS.category, undefined)).toBeNull();
  });

  it("sideDecisions covers every declared question, null on failed sides", () => {
    const labels = sideDecisions(jevOk(), EMAIL_QUESTIONS);
    expect(Object.keys(labels).sort()).toEqual(["category", "is_urgent", "priority"]);
    expect(labels.category).toBe("bug");
    const failed = sideDecisions(jevFail(), EMAIL_QUESTIONS);
    expect(Object.values(failed).every((v) => v === null)).toBe(true);
  });
});

describe("compareSides", () => {
  it("match when both sides decided identically on every question", () => {
    const r = compareSides(jevOk(), gwOk());
    expect(r.status).toBe("match");
    expect(r.diffQuestions).toEqual([]);
    expect(r.agreement).toEqual({ category: "match", is_urgent: "match", priority: "match" });
  });

  it("diff names exactly the disagreeing questions", () => {
    const r = compareSides(
      jevOk({ category: choice("bug"), is_urgent: noul(0.9), priority: score(1.2) }),
      gwOk({ category: choice("bug"), is_urgent: noul(0.9), priority: score(3.8) }),
    );
    expect(r.status).toBe("diff");
    expect(r.diffQuestions).toEqual(["priority"]);
  });

  it("n/a when either backend failed — a dead side never fakes agreement", () => {
    expect(compareSides(jevFail(), gwOk()).status).toBe("na");
    expect(compareSides(jevOk(), gwFail()).status).toBe("na");
    expect(compareSides(jevFail(), gwFail()).status).toBe("na");
  });

  it("badge classes map match→good, diff→warn, n/a→neutral", () => {
    expect(harnessStatusBadgeClass("match")).toBe("good");
    expect(harnessStatusBadgeClass("diff")).toBe("warn");
    expect(harnessStatusBadgeClass("na")).toBe("neutral");
    expect(agreementBadgeClass("match")).toBe("good");
    expect(agreementBadgeClass("diff")).toBe("warn");
    expect(agreementBadgeClass("n/a")).toBe("neutral");
  });
});

describe("labels + stats helpers", () => {
  it("agreementRateLabel renders percent or em-dash", () => {
    expect(agreementRateLabel(0.9125)).toBe("91.3%");
    expect(agreementRateLabel(1)).toBe("100.0%");
    expect(agreementRateLabel(null)).toBe("—");
  });

  it("p95 is nearest-rank and null on empty", () => {
    expect(p95([])).toBeNull();
    expect(p95([120])).toBe(120);
    const xs = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(p95(xs)).toBe(19); // ceil(0.95·20)−1 = 18th index of [1..20]
  });
});

describe("computeHarnessTotals", () => {
  it("counts statuses, per-side errors, usage, models, and rate", () => {
    const reps = [
      report("e01", "emails", "match", jevOk(), gwOk(), {
        category: "match",
        is_urgent: "match",
        priority: "match",
      }),
      report("e02", "emails", "diff", jevOk(), gwOk(), {
        category: "diff",
        is_urgent: "match",
        priority: "match",
      }),
      report("e03", "emails", "na", jevFail(), gwOk()),
    ];
    const t = computeHarnessTotals(reps);
    expect(t.items).toBe(3);
    expect(t.compared).toBe(2);
    expect(t.matches).toBe(1);
    expect(t.diffs).toBe(1);
    expect(t.na).toBe(1);
    expect(t.jevErrors).toBe(1);
    expect(t.emulatedErrors).toBe(0);
    expect(t.agreementRate).toBeCloseTo(0.5);
    expect(t.jevUsage).toEqual({ input_tokens: 20, output_tokens: 4 }); // e03's jev call failed → no usage
    expect(t.emulatedUsage).toEqual({ input_tokens: 1500, output_tokens: 60 }); // all 3 emulated calls ran
    expect(t.jevModel).toBe("jev-latest");
    expect(t.emulatedModel).toBe("anthropic/claude-3-haiku");
    expect(t.jevAvgLatency).not.toBeNull();
  });

  it("per-question rows only count compared items and expose rates", () => {
    const reps = [
      report("e01", "emails", "match", jevOk(), gwOk(), {
        category: "match",
        is_urgent: "match",
        priority: "match",
      }),
      report("e02", "emails", "diff", jevOk(), gwOk(), {
        category: "diff",
        is_urgent: "match",
        priority: "match",
      }),
      report("e03", "emails", "na", jevFail(), gwOk()), // contributes nothing
    ];
    const t = computeHarnessTotals(reps);
    expect(t.perQuestion.category).toEqual({ match: 1, diff: 1, na: 0, rate: 0.5 });
    expect(t.perQuestion.priority.rate).toBe(1);
    expect(t.perQuestion.priority.match).toBe(2);
  });

  it("null rate with nothing comparable", () => {
    const t = computeHarnessTotals([report("e01", "emails", "na", jevFail(), gwFail())]);
    expect(t.agreementRate).toBeNull();
    expect(t.compared).toBe(0);
    expect(t.perQuestion).toEqual({});
  });
});

describe("runHarness (fake backends)", () => {
  it("runs both providers per item — jev as jev, emulated as gateway, no fallback", async () => {
    const { fn, calls } = fakeClassify("match");
    const rep = await runHarness(emailItems(2), { classifyFn: fn, now: () => 1000 });
    expect(calls).toHaveLength(4); // 2 items × 2 sides
    expect(calls.map((c) => c.provider).sort()).toEqual(["gateway", "gateway", "jev", "jev"]);
    for (const c of calls) expect(c.opts.fallback).toBeUndefined();
    expect(rep.items).toHaveLength(2);
    expect(rep.totals.matches).toBe(2);
    expect(rep.totals.agreementRate).toBe(1);
    expect(rep.generatedAt).toBe(new Date(1000).toISOString());
    expect(rep.ladder).toEqual([...BATCH_LADDER]);
  });

  it("isolated jev failure marks n/a but keeps the emulated column and the batch alive", async () => {
    const { fn } = fakeClassify("jev-throws");
    const rep = await runHarness(emailItems(3), { classifyFn: fn, now: () => 0 });
    expect(rep.items.every((i) => i.status === "na")).toBe(true);
    expect(rep.totals.jevErrors).toBe(3);
    expect(rep.items.every((i) => i.emulated.ok)).toBe(true);
    expect(rep.items.every((i) => i.jev.error === "jev is down")).toBe(true);
    expect(rep.totals.agreementRate).toBeNull();
  });

  it("jev-differs produces diff items naming the question", async () => {
    const { fn } = fakeClassify("jev-differs");
    const rep = await runHarness(emailItems(4), { classifyFn: fn, now: () => 0 });
    expect(rep.totals.diffs).toBe(4);
    expect(rep.totals.matches).toBe(0);
    expect(rep.items[0].diffQuestions).toEqual(["category"]);
    expect(rep.totals.perQuestion.category.rate).toBe(0);
    expect(rep.totals.perQuestion.is_urgent.rate).toBe(1);
  });

  it("gw-differs is symmetric — emulated side disagreement also diffs", async () => {
    const { fn } = fakeClassify("gw-differs");
    const rep = await runHarness(emailItems(2), { classifyFn: fn, now: () => 0 });
    expect(rep.totals.diffs).toBe(2);
    expect(rep.items[0].diffQuestions).toEqual(["category"]);
  });

  it("batch ladder discipline: default 5, rung 10, null = All", async () => {
    const { fn } = fakeClassify("match");
    const many = emailItems(12);
    const dflt = await runHarness(many, { classifyFn: fn, now: () => 0 });
    expect(dflt.items).toHaveLength(5);
    expect(dflt.totals.items).toBe(5);
    const rung = await runHarness(many, { classifyFn: fn, limit: 10, now: () => 0 });
    expect(rung.items).toHaveLength(10);
    const all = await runHarness(many, { classifyFn: fn, limit: null, now: () => 0 });
    expect(all.items).toHaveLength(12);
    const over = await runHarness(emailItems(2), { classifyFn: fn, limit: 10, now: () => 0 });
    expect(over.items).toHaveLength(2); // clamped, not padded
  });

  it("preserves input order regardless of completion order", async () => {
    let n = 0;
    const fn = async (req: ClassifyRequest, opts: ClassifyOptions = {}): Promise<ClassifyResult> => {
      const tick = n++;
      if (tick % 2 === 0) await new Promise((r) => setTimeout(r, 4));
      return {
        answers: { category: choice("bug"), is_urgent: noul(0.9), priority: score(3.1) },
        usage: { input_tokens: 1, output_tokens: 1 },
        model: "m",
        provider: (opts.provider ?? "gateway") as "jev" | "gateway",
      };
    };
    const rep = await runHarness(emailItems(6), { classifyFn: fn, limit: null, concurrency: 2, now: () => 0 });
    expect(rep.items.map((i) => i.id)).toEqual(["e01", "e02", "e03", "e04", "e05", "e06"]);
  });

  it("records per-side latency, models, and a mixed-corpus run keeps dataset tags", async () => {
    const clock = [0, 100, 0, 350, 500, 800]; // jev: 100ms, gw: 350ms then 500→800 = 300ms... careful per side
    let t = 0;
    const now = () => clock[Math.min(t++, clock.length - 1)];
    const { fn } = fakeClassify("match");
    const rep = await runHarness(
      [
        { id: "e01", dataset: "emails", state: "Subject: x" },
        { id: "yt-v01", dataset: "youtube", state: "Title: y" },
      ],
      { classifyFn: fn, now, limit: null },
    );
    expect(rep.items[0].dataset).toBe("emails");
    expect(rep.items[1].dataset).toBe("youtube");
    expect(rep.items[0].jev.latency_ms).toBeGreaterThanOrEqual(0);
    expect(rep.items[0].emulated.latency_ms).toBeGreaterThanOrEqual(0);
    expect(rep.totals.jevModel).toBe("jev-latest");
    expect(rep.totals.emulatedModel).toBe("anthropic/claude-3-haiku");
  });

  it("empty corpus is a clean zero report", async () => {
    const { fn } = fakeClassify("match");
    const rep = await runHarness([], { classifyFn: fn, now: () => 0 });
    expect(rep.items).toEqual([]);
    expect(rep.totals.items).toBe(0);
    expect(rep.totals.agreementRate).toBeNull();
    expect(rep.totals.jevAvgLatency).toBeNull();
  });
});
