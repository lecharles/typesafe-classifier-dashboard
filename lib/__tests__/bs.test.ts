import { describe, it, expect } from "vitest";
import {
  BS_LEVELS,
  BS_NOTE,
  BS_RANK,
  BS_SOURCES,
  BS_VERDICTS,
  DEFAULT_GATES,
  bsLeaderboardExportRows,
  bsLeaderboardScore,
  buildBsCorpus,
  bsBadgeClass,
  bsQuestions,
  decideBsVerdict,
  normalizeGates,
  rankBsLeaderboard,
  runBsBatch,
  screenBsItem,
  signalsFrom,
  type BsBatchItem,
  type BsGates,
  type BsSignals,
  type BsVerdict,
} from "@/lib/bs";
import { toCSV, toJSON } from "@/lib/export";
import { emails } from "@/data/emails";
import { videos } from "@/data/youtube";
import type { Answer, ClassifyResult } from "@/lib/schema";

const noul = (p: number): Answer => ({ type: "noul", noul: p });
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

const sig = (over: Partial<BsSignals> = {}): BsSignals => ({
  bs: 2.0,
  malice: 0.05,
  payoff: 0.9,
  confidence: 0.9,
  ...over,
});

function bsAnswers(over: Partial<{ bs: Answer; malice: Answer; payoff: Answer }> = {}) {
  return {
    bs: score(2, 0.9),
    malice: noul(0.05),
    payoff: noul(0.9),
    ...over,
  } as Record<string, Answer>;
}

describe("UC#7 unified BS verdicts + questions", () => {
  it("verdict ladder is strictly ordered clean < suspicious < bs", () => {
    expect(BS_VERDICTS).toEqual(["clean", "suspicious", "bs"]);
    expect(BS_RANK.clean).toBeLessThan(BS_RANK.suspicious);
    expect(BS_RANK.suspicious).toBeLessThan(BS_RANK.bs);
  });

  it("every verdict has a badge class and a note", () => {
    expect(bsBadgeClass("clean")).toBe("good");
    expect(bsBadgeClass("suspicious")).toBe("warn");
    expect(bsBadgeClass("bs")).toBe("bad");
    for (const v of BS_VERDICTS) expect(BS_NOTE[v]).toMatch(/\w/);
  });

  it("questions declare ONE shared set: an intensity Score (5 levels) + two Nouls", () => {
    const qs = bsQuestions();
    expect(Object.keys(qs).sort()).toEqual(["bs", "malice", "payoff"]);
    expect(qs.bs.type).toBe("score");
    expect(qs.bs.type === "score" && qs.bs.criteria).toEqual(BS_LEVELS);
    expect(BS_LEVELS).toHaveLength(5);
    expect(qs.malice.type).toBe("noul");
    expect(qs.payoff.type).toBe("noul");
    expect(qs.malice.type === "noul" && qs.malice.criteria?.true).toMatch(/deceptive/i);
    expect(qs.payoff.type === "noul" && qs.payoff.criteria?.true).toMatch(/deliver/i);
  });

  it("default gates order the ladder sanely: cleanAt < bsAt, floors are probabilities", () => {
    expect(DEFAULT_GATES.cleanAt).toBeLessThan(DEFAULT_GATES.bsAt);
    expect(DEFAULT_GATES.bsAt).toBeGreaterThan(0);
    expect(DEFAULT_GATES.maliceBlockAt).toBeGreaterThanOrEqual(0.5);
    expect(DEFAULT_GATES.payoffFloor).toBeGreaterThanOrEqual(0.5);
  });

  it("normalizeGates merges partial slider values over defaults", () => {
    expect(normalizeGates({ maliceBlockAt: 0.9 })).toEqual({ ...DEFAULT_GATES, maliceBlockAt: 0.9 });
    expect(normalizeGates()).toEqual(DEFAULT_GATES);
  });
});

describe("UC#7 signalsFrom validation — declared-set discipline", () => {
  it("extracts signals from a full answer set", () => {
    const s = signalsFrom(bsAnswers({ bs: score(3, 0.85) }));
    expect(s).toEqual({ bs: 3, malice: 0.05, payoff: 0.9, confidence: 0.85 });
  });

  it("accepts fractional intensity inside the declared levels", () => {
    expect(signalsFrom(bsAnswers({ bs: score(2.5) })).bs).toBe(2.5);
  });

  it("throws on out-of-range or wrong-type intensity", () => {
    expect(() => signalsFrom(bsAnswers({ bs: score(5) }))).toThrow(/outside the declared levels/);
    expect(() => signalsFrom(bsAnswers({ bs: score(-1) }))).toThrow(/outside the declared levels/);
    expect(() => signalsFrom(bsAnswers({ bs: score(Number.NaN) }))).toThrow(/outside the declared levels/);
    expect(() => signalsFrom(bsAnswers({ bs: noul(0.5) }))).toThrow(/outside the declared levels/);
    expect(() => signalsFrom({ ...bsAnswers(), bs: undefined })).toThrow(/outside the declared levels/);
  });

  it("throws on missing/non-probability nouls", () => {
    expect(() => signalsFrom(bsAnswers({ malice: score(1) }))).toThrow(/malice/);
    expect(() => signalsFrom(bsAnswers({ payoff: score(1) }))).toThrow(/payoff/);
    const bad = bsAnswers();
    delete bad.payoff;
    expect(() => signalsFrom(bad)).toThrow(/payoff/);
    expect(() => signalsFrom(bsAnswers({ malice: noul(1.5) }))).toThrow(/malice/);
  });
});

describe("UC#7 in-code BS ladder", () => {
  it("straight talk, honest payoff, no malice → CLEAN", () => {
    const d = decideBsVerdict(sig({ bs: 0.5 }));
    expect(d.verdict).toBe("clean");
    expect(d.reasons[d.reasons.length - 1]).toContain("clean (reads straight");
  });

  it("classic bait at or above bsAt → BS", () => {
    const d = decideBsVerdict(sig({ bs: DEFAULT_GATES.bsAt }));
    expect(d.verdict).toBe("bs");
    expect(d.reasons.join(" ")).toMatch(/internet junk/);
  });

  it("blatant intensity 4 → BS", () => {
    expect(decideBsVerdict(sig({ bs: 4 })).verdict).toBe("bs");
  });

  it("mid intensity → SUSPICIOUS (bait-adjacent, worth a squint)", () => {
    const d = decideBsVerdict(sig({ bs: 2.0 }));
    expect(d.verdict).toBe("suspicious");
    expect(d.reasons.join(" ")).toMatch(/bait-adjacent/);
  });

  it("clean at the exact cleanAt boundary stays clean", () => {
    expect(decideBsVerdict(sig({ bs: DEFAULT_GATES.cleanAt })).verdict).toBe("clean");
  });

  it("malice floor is ABSOLUTE — BS even at straight-talk intensity", () => {
    const d = decideBsVerdict(sig({ bs: 0, malice: 0.8 }));
    expect(d.verdict).toBe("bs");
    expect(d.reasons.join(" ")).toMatch(/lies at you is BS/);
  });

  it("malice exactly at the floor trips the block", () => {
    expect(decideBsVerdict(sig({ bs: 0.5, malice: DEFAULT_GATES.maliceBlockAt })).verdict).toBe("bs");
  });

  it("low payoff caps a CLEAN to SUSPICIOUS — bait never passes silently on promise alone", () => {
    const d = decideBsVerdict(sig({ bs: 0.5, payoff: 0.2 }));
    expect(d.verdict).toBe("suspicious");
    expect(d.reasons.join(" ")).toMatch(/caps clean to suspicious/);
  });

  it("payoff cap does not rescue or worsen a bs base", () => {
    expect(decideBsVerdict(sig({ bs: 4, payoff: 0.1 })).verdict).toBe("bs");
  });

  it("low confidence demotes clean to suspicious, NEVER to bs", () => {
    const d = decideBsVerdict(sig({ bs: 0.5, confidence: 0.3 }));
    expect(d.verdict).toBe("suspicious");
    expect(d.reasons.join(" ")).toMatch(/uncertain cleans never pass silently/);
    expect(decideBsVerdict(sig({ bs: 2, confidence: 0.1 })).verdict).toBe("suspicious");
    expect(decideBsVerdict(sig({ bs: 4, confidence: 0.1 })).verdict).toBe("bs");
  });

  it("sliders are honored: lowering bsAt catches a bait, raising the malice floor spares it", () => {
    const strict: BsGates = { ...DEFAULT_GATES, bsAt: 1.5 };
    expect(decideBsVerdict(sig({ bs: 2.0 }), strict).verdict).toBe("bs");
    const generous: BsGates = { ...DEFAULT_GATES, maliceBlockAt: 0.95 };
    expect(decideBsVerdict(sig({ bs: 0.5, malice: 0.8 }), generous).verdict).toBe("clean");
  });
});

describe("UC#7 unified corpus — one stream, two species", () => {
  it("merges EVERY email + EVERY video (90 items) with unique ids", () => {
    const corpus = buildBsCorpus();
    expect(corpus.length).toBe(emails.length + videos.length);
    expect(corpus.length).toBe(90);
    const ids = corpus.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("email items carry the SAME state the /emails dashboard classifies", () => {
    const corpus = buildBsCorpus();
    const first = corpus.find((c) => c.id === emails[0].id)!;
    expect(first.source).toBe("email");
    expect(first.state).toBe(`Subject: ${emails[0].subject}\n\n${emails[0].body}`);
    expect(first.label).toBe(emails[0].subject);
  });

  it("video items carry the SAME state the /youtube dashboard classifies", () => {
    const corpus = buildBsCorpus();
    const v = videos[0];
    const first = corpus.find((c) => c.id === v.id)!;
    expect(first.source).toBe("video");
    expect(first.state).toBe(`Title: ${v.title}\nChannel: ${v.channel}\nDescription: ${v.description}`);
    expect(first.label).toBe(v.title);
  });

  it("source narrowing keeps emails out of the video stream and vice versa", () => {
    expect(buildBsCorpus(["email"]).length).toBe(emails.length);
    expect(buildBsCorpus(["email"]).every((c) => c.source === "email")).toBe(true);
    expect(buildBsCorpus(["video"]).length).toBe(videos.length);
    expect(buildBsCorpus(["video"]).every((c) => c.source === "video")).toBe(true);
    for (const s of BS_SOURCES) expect(["email", "video"]).toContain(s);
  });

  it("every corpus item has non-empty label and state", () => {
    for (const c of buildBsCorpus()) {
      expect(c.label.trim().length).toBeGreaterThan(0);
      expect(c.state.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("UC#7 live single screen (screenBsItem)", () => {
  it("screens one pasted state end-to-end with the injected classifier", async () => {
    let asked: Record<string, unknown> | undefined;
    const classifyFn = (async (req: { state: string; questions: Record<string, unknown> }) => {
      asked = req.questions;
      return fakeResult(bsAnswers({ bs: score(4, 0.95), malice: noul(0.9) }));
    }) as never;

    const out = await screenBsItem("Subject: FREE MONEY!!!\n\nSend your card number.", "junk", {
      classifyFn,
    });
    expect(out.decision.verdict).toBe("bs");
    expect(out.signals.bs).toBe(4);
    expect(out.model).toBe("jev-test");
    expect(out.provider).toBe("gateway");
    expect(out.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    expect(out.label).toBe("junk");
    expect(Object.keys(asked ?? {}).sort()).toEqual(["bs", "malice", "payoff"]);
  });

  it("malice floor BS-es an otherwise straight item live", async () => {
    const classifyFn = (async () =>
      fakeResult(bsAnswers({ bs: score(0.5), malice: noul(0.85) }))) as never;
    const out = await screenBsItem("Dear customer, verify your password here.", "x", { classifyFn });
    expect(out.decision.verdict).toBe("bs");
  });

  it("passes gates through and reports the effective set", async () => {
    const classifyFn = (async () => fakeResult(bsAnswers())) as never;
    const gates = normalizeGates({ bsAt: 1.5 });
    const out = await screenBsItem("anything", "x", { classifyFn, gates });
    expect(out.gates).toEqual(gates);
    expect(out.decision.verdict).toBe("bs"); // intensity 2 ≥ lowered bsAt 1.5
  });

  it("attaches the dev trace when asked, and omits it otherwise", async () => {
    const traceResult = (answers: Record<string, Answer>): ClassifyResult => ({
      ...fakeResult(answers),
      trace: { provider_used: "gateway", endpoint: "x", request: {}, attempts: [], retries: 0 },
    });
    const classifyFn = (async () => traceResult(bsAnswers())) as never;
    const dev = await screenBsItem("q", "a", { classifyFn, trace: true });
    expect(dev.trace).toBeDefined();
    const plain = await screenBsItem("q", "a", { classifyFn });
    expect(plain.trace).toBeUndefined();
  });

  it("propagates classifier errors and validator hard-fails — no silent cleans", async () => {
    const boom = (async () => {
      throw new Error("gateway down");
    }) as never;
    await expect(screenBsItem("q", "a", { classifyFn: boom })).rejects.toThrow(/gateway down/);

    const bad = (async () => fakeResult({ bs: noul(0.5) })) as never;
    await expect(screenBsItem("q", "a", { classifyFn: bad })).rejects.toThrow(/outside the declared levels/);
  });
});

describe("UC#7 runBsBatch (merged ladder 5 → 10 → All + per-source tallies)", () => {
  // 12 synthetic items — 6 emails, 6 videos — exercising every rung.
  const corpus = Array.from({ length: 12 }, (_, i) => {
    const n = i + 1;
    const source = n % 2 === 1 ? ("email" as const) : ("video" as const);
    if (n === 3) return { id: `b${n}`, source, state: "boom — gateway dies on this item" };
    if (n === 5) return { id: `b${n}`, source, state: "phish: send your card number to claim prize" };
    if (n === 7) return { id: `b${n}`, source, state: "headline promises a cure, body delivers nothing" };
    if (n === 9) return { id: `b${n}`, source, state: "clickbait title, straight description" };
    return { id: `b${n}`, source, state: `honest support email ${n}` };
  });

  const fakeFn = (async (req: { state: string }) => {
    if (req.state.includes("boom")) throw new Error("gateway down for b3");
    if (req.state.includes("phish")) {
      return fakeResult(bsAnswers({ bs: score(0.5, 0.95), malice: noul(0.95) }));
    }
    if (req.state.includes("delivers nothing")) {
      return fakeResult(bsAnswers({ bs: score(0.5, 0.9), payoff: noul(0.1) }));
    }
    if (req.state.includes("clickbait")) {
      return fakeResult(bsAnswers({ bs: score(4, 0.95) }));
    }
    return fakeResult(bsAnswers({ bs: score(0.5, 0.9) }));
  }) as never;

  it("processes the first ladder rung by default", async () => {
    const report = await runBsBatch(corpus, { classifyFn: fakeFn });
    expect(report.totals.screened).toBe(5);
    expect(report.items).toHaveLength(5);
    expect(report.items.map((x) => x.id)).toEqual(["b1", "b2", "b3", "b4", "b5"]);
  });

  it("limit 10 widens the ladder; limit null runs All", async () => {
    const ten = await runBsBatch(corpus, { classifyFn: fakeFn, limit: 10 });
    expect(ten.totals.screened).toBe(10);
    const all = await runBsBatch(corpus, { classifyFn: fakeFn, limit: null });
    expect(all.totals.screened).toBe(12);
    expect(all.items).toHaveLength(12);
  });

  it("a limit past the corpus is clamped, not padded", async () => {
    const report = await runBsBatch(corpus, { classifyFn: fakeFn, limit: 40 });
    expect(report.totals.screened).toBe(12);
  });

  it("the merged shipped corpus is the default when no corpus is passed", async () => {
    let calls = 0;
    const classifyFn = (async () => {
      calls += 1;
      return fakeResult(bsAnswers({ bs: score(0.5) }));
    }) as never;
    const report = await runBsBatch(undefined, { classifyFn, limit: 10 });
    expect(calls).toBe(10);
    expect(report.items.length).toBe(10);
    // first 10 of the merged stream: emails come first (they lead the corpus)
    expect(new Set(report.items.map((x) => x.source))).toEqual(new Set(["email"]));
  });

  it("errors are isolated per item — one boom never aborts the batch", async () => {
    const report = await runBsBatch(corpus, { classifyFn: fakeFn, limit: null });
    expect(report.totals.errors).toBe(1);
    const failed = report.items.find((x) => x.error);
    expect(failed?.id).toBe("b3");
    expect(failed?.verdict).toBeUndefined();
    expect(report.items.filter((x) => !x.error)).toHaveLength(11);
  });

  it("clean / suspicious / bs tallies are decided IN CODE per item", async () => {
    const report = await runBsBatch(corpus, { classifyFn: fakeFn, limit: null });
    // b5 phish → bs via malice floor; b9 clickbait → bs via ladder;
    // b7 overpromiser → suspicious via payoff cap; the other 8 honest → clean.
    expect(report.totals.verdicts).toEqual({ clean: 8, suspicious: 1, bs: 2 });
    expect(
      report.totals.verdicts.clean +
        report.totals.verdicts.suspicious +
        report.totals.verdicts.bs,
    ).toBe(report.totals.screened - report.totals.errors);
    const byId = (id: string) => report.items.find((x) => x.id === id);
    expect(byId("b5")?.verdict).toBe("bs");
    expect(byId("b5")?.reasons?.join(" ")).toMatch(/lies at you is BS/);
    expect(byId("b7")?.verdict).toBe("suspicious");
    expect(byId("b7")?.reasons?.join(" ")).toMatch(/caps clean to suspicious/);
  });

  it("per-source tallies split the unified verdict stream by species", async () => {
    const report = await runBsBatch(corpus, { classifyFn: fakeFn, limit: null });
    const sum = (t: Record<"clean" | "suspicious" | "bs", number>) =>
      t.clean + t.suspicious + t.bs;
    // b1,b3(boom),b5,b7,b9,b11 are emails: 2 clean, 1 suspicious, 2 bs (1 error aside)
    expect(report.totals.bySource.email).toEqual({ clean: 2, suspicious: 1, bs: 2 });
    // b2,b4,b6,b8,b10,b12 are videos: all clean
    expect(report.totals.bySource.video).toEqual({ clean: 6, suspicious: 0, bs: 0 });
    for (const s of BS_SOURCES) expect(sum(report.totals.bySource[s])).toBeLessThanOrEqual(6);
  });

  it("usage sums across items and the model/provider are reported", async () => {
    const report = await runBsBatch(corpus, { classifyFn: fakeFn, limit: null });
    // 11 successes × {10↑, 5↓}
    expect(report.totals.usage).toEqual({ input_tokens: 110, output_tokens: 55 });
    expect(report.model).toBe("jev-test");
    expect(report.provider).toBe("gateway");
  });

  it("gates pass through to every item and the effective set is reported", async () => {
    const report = await runBsBatch(corpus, {
      classifyFn: fakeFn,
      limit: null,
      gates: { cleanAt: 0.4 },
    });
    expect(report.gates).toEqual(normalizeGates({ cleanAt: 0.4 }));
    // intensity 0.5 no longer clears the lowered clean gate (cleanAt 0.4) —
    // every former clean (and the overpromiser) queues as bait-adjacent
    expect(report.totals.verdicts.clean).toBe(0);
    expect(report.totals.verdicts.suspicious).toBe(9); // 8 demoted cleans + the payoff cap
    expect(report.totals.verdicts.bs).toBe(2);
  });

  it("items carry label/signals for the dashboard rows", async () => {
    const report = await runBsBatch(corpus, { classifyFn: fakeFn, limit: 5 });
    const cleaned = report.items.find((x) => x.verdict === "clean");
    expect(cleaned?.signals?.bs).toBe(0.5);
    expect(cleaned?.label).toContain("honest support email");
    expect(cleaned?.source).toMatch(/email|video/);
  });

  it("empty corpus is an empty report, not a crash", async () => {
    const report = await runBsBatch([], { classifyFn: fakeFn });
    expect(report.totals.screened).toBe(0);
    expect(report.items).toEqual([]);
    expect(report.totals.verdicts).toEqual({ clean: 0, suspicious: 0, bs: 0 });
    expect(report.totals.bySource.email).toEqual({ clean: 0, suspicious: 0, bs: 0 });
  });
});

/* ------------------------------------------------------------------ *
 * UC#7 (11-18 row, shipped one day ahead): ranked BS leaderboard +
 * export through the D8 CSV/JSON pipeline.
 * ------------------------------------------------------------------ */

describe("UC#7 ranked BS leaderboard + D8 export", () => {
  const lbItem = (
    id: string,
    source: "email" | "video",
    label: string,
    verdict?: BsVerdict,
    over: Partial<BsSignals> = {},
    error?: string,
  ): BsBatchItem => ({
    id,
    source,
    label,
    ...(verdict
      ? { verdict, signals: sig(over), reasons: [`BS verdict: ${verdict}`] }
      : {}),
    ...(error ? { error } : {}),
  });

  it("the score band ALWAYS dominates: any bs outranks any suspicious, any suspicious outranks any clean", () => {
    expect(bsLeaderboardScore("bs", 0)).toBeGreaterThan(bsLeaderboardScore("suspicious", 4.99));
    expect(bsLeaderboardScore("suspicious", 0)).toBeGreaterThan(bsLeaderboardScore("clean", 4.99));
    expect(bsLeaderboardScore("clean", 0)).toBe(0);
    expect(bsLeaderboardScore("bs", 4)).toBe(24);
    // score equals rank ×10 + intensity — bands are 10 apart, intensity lives in [0,5)
    for (const v of BS_VERDICTS) {
      expect(bsLeaderboardScore(v, 2.5)).toBe(BS_RANK[v] * 10 + 2.5);
    }
  });

  it("ranks the merged stream WORST FIRST: verdict band, then intensity", () => {
    const lb = rankBsLeaderboard([
      lbItem("c1", "email", "honest note", "clean", { bs: 0.5 }),
      lbItem("x1", "video", "FREE IPHONE!!", "bs", { bs: 4 }),
      lbItem("s1", "email", "mild puffery", "suspicious", { bs: 2 }),
      lbItem("x2", "video", "verify your password", "bs", { bs: 3.6 }),
      lbItem("c2", "email", "meeting recap", "clean", { bs: 0 }),
    ]);
    expect(lb.rows.map((r) => r.id)).toEqual(["x1", "x2", "s1", "c1", "c2"]);
    expect(lb.rows.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
    // a malice-floor bs at low intensity still sits under a blatant one, above all bait-adjacent
    expect(lb.rows[0].verdict).toBe("bs");
    expect(lb.rows[3].verdict).toBe("clean");
  });

  it("tiebreaks inside one score: higher malice first, then id ascending — total order, no vibes", () => {
    const lb = rankBsLeaderboard([
      lbItem("z9", "video", "bait A", "suspicious", { bs: 2, malice: 0.1 }),
      lbItem("a1", "video", "bait B", "suspicious", { bs: 2, malice: 0.4 }),
      lbItem("m2", "email", "tie X", "clean", { bs: 0.5, malice: 0.02 }),
      lbItem("m1", "email", "tie Y", "clean", { bs: 0.5, malice: 0.02 }),
    ]);
    expect(lb.rows.map((r) => r.id)).toEqual(["a1", "z9", "m1", "m2"]);
  });

  it("failed items are EXCLUDED and COUNTED, never silently dropped and never ranked", () => {
    const lb = rankBsLeaderboard([
      lbItem("ok1", "email", "fine", "bs", { bs: 4 }),
      lbItem("boom", "video", "gateway died", undefined, {}, "gateway down for boom"),
      lbItem("ok2", "email", "fine", "clean", { bs: 0.5 }),
    ]);
    expect(lb.rows).toHaveLength(2);
    expect(lb.failed).toBe(1);
    expect(lb.rows.map((r) => r.id)).toEqual(["ok1", "ok2"]);
    expect(lb.rows.every((r) => r.verdict)).toBe(true);
  });

  it("empty batch is an empty leaderboard, not a crash", () => {
    const lb = rankBsLeaderboard([]);
    expect(lb.rows).toEqual([]);
    expect(lb.failed).toBe(0);
  });

  it("ranking is deterministic: same input, and reordered input, yield the same worst-first stream", () => {
    const items = [
      lbItem("e1", "email", "a", "suspicious", { bs: 2.5, malice: 0.3 }),
      lbItem("v1", "video", "b", "bs", { bs: 4, malice: 0.9 }),
      lbItem("e2", "email", "c", "clean", { bs: 0.5, malice: 0.01 }),
      lbItem("v2", "video", "d", "suspicious", { bs: 2.5, malice: 0.3 }),
    ];
    const once = rankBsLeaderboard(items).rows.map((r) => r.id);
    const twice = rankBsLeaderboard([...items].reverse()).rows.map((r) => r.id);
    expect(twice).toEqual(once);
    expect(once).toEqual(["v1", "e1", "v2", "e2"]);
  });

  it("rows carry source/label/signals for the leaderboard table", () => {
    const lb = rankBsLeaderboard([
      lbItem("v1", "video", "YOU WONTHISE?", "bs", { bs: 4, malice: 0.85, payoff: 0.1, confidence: 0.95 }),
    ]);
    const r = lb.rows[0];
    expect(r.source).toBe("video");
    expect(r.label).toBe("YOU WONTHISE?");
    expect(r.intensity).toBe(4);
    expect(r.malice).toBe(0.85);
    expect(r.payoff).toBe(0.1);
    expect(r.confidence).toBe(0.95);
    expect(r.score).toBeCloseTo(24, 6);
  });

  it("export rows ride the D8 shape: stable column order, numbers rounded to 3 dp", () => {
    const lb = rankBsLeaderboard([
      lbItem("x1", "email", "bait", "suspicious", { bs: 2.0333, malice: 1 / 3, payoff: 0.66667, confidence: 0.5762 }),
    ]);
    const rows = bsLeaderboardExportRows(lb.rows);
    expect(Object.keys(rows[0])).toEqual([
      "rank", "id", "source", "label", "verdict",
      "score", "intensity", "malice", "payoff", "confidence",
    ]);
    expect(rows[0].rank).toBe(1);
    expect(rows[0].intensity).toBe(2.033);
    expect(rows[0].malice).toBe(0.333);
    expect(rows[0].payoff).toBe(0.667);
    expect(rows[0].confidence).toBe(0.576);
  });

  it("toCSV of the leaderboard: header + one row per ranked item, quote/comma-safe labels", () => {
    const lb = rankBsLeaderboard([
      lbItem("x1", "email", 'Win a FREE iPhone, "guaranteed"', "bs", { bs: 4, malice: 0.9 }),
      lbItem("c1", "video", "quiet tutorial", "clean", { bs: 0.5 }),
    ]);
    const csv = toCSV(bsLeaderboardExportRows(lb.rows));
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("rank,id,source,label,verdict,score,intensity,malice,payoff,confidence");
    expect(lines[1]).toContain("24"); // bs band score in row order
    expect(lines[1]).toContain('"Win a FREE iPhone, ""guaranteed"""'); // RFC-style escaping
    expect(lines[2].startsWith("2,c1,video")).toBe(true);
  });

  it("toJSON round-trips the ranked stream unchanged", () => {
    const lb = rankBsLeaderboard([
      lbItem("x1", "video", "blatant", "bs", { bs: 3.5, malice: 0.7 }),
      lbItem("s1", "email", "bait-adjacent", "suspicious", { bs: 2 }),
    ]);
    const rows = bsLeaderboardExportRows(lb.rows);
    expect(JSON.parse(toJSON(rows))).toEqual(rows);
  });

  it("end-to-end: a batch run → leaderboard → export keeps worst-first order through the D8 pipeline", async () => {
    const corpus = [
      { id: "e1", source: "email" as const, state: "honest support email" },
      { id: "v1", source: "video" as const, state: "clickbait title, straight description" },
      { id: "e2", source: "email" as const, state: "phish: send your card number to claim prize" },
      { id: "e3", source: "email" as const, state: "boom item" },
    ];
    const classifyFn = (async (req: { state: string }) => {
      if (req.state.includes("boom")) throw new Error("gateway down for e3");
      if (req.state.includes("phish")) {
        return fakeResult(bsAnswers({ bs: score(0.5, 0.95), malice: noul(0.95) }));
      }
      if (req.state.includes("clickbait")) {
        return fakeResult(bsAnswers({ bs: score(4, 0.95) }));
      }
      if (req.state.includes("honest")) {
        return fakeResult(bsAnswers({ bs: score(0.5, 0.9) }));
      }
      return fakeResult(bsAnswers({ bs: score(2, 0.9) }));
    }) as never;

    const report = await runBsBatch(corpus, { classifyFn, limit: null });
    const lb = rankBsLeaderboard(report.items);
    expect(lb.failed).toBe(1); // e3 dropped from ranking, counted
    const ids = lb.rows.map((r) => r.id);
    // the two bs (clickbait via ladder at intensity 4, phish via malice floor at 0.5) come first
    expect(ids[0]).toBe("v1"); // 24 = bs band 2 ×10 + 4
    expect(ids[1]).toBe("e2"); // 20.5 = bs band + intensity 0.5 — the floor put it here
    expect(ids[2]).toBe("e1"); // clean
    const csv = toCSV(bsLeaderboardExportRows(lb.rows));
    expect(csv.split("\r\n")).toHaveLength(4); // header + 3 ranked
    expect(csv).toContain("e2,");
  });
});
