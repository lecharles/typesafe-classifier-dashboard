import { describe, it, expect } from "vitest";
import {
  DEFAULT_GATES,
  ENTITY_NOTE,
  ENTITY_RANK,
  ENTITY_VERDICTS,
  SIMILARITY_LEVELS,
  alignEntityPair,
  buildEntityCorpus,
  decideEntityVerdict,
  entityBadgeClass,
  entityClusterExportRows,
  entityPairExportRows,
  entityQuestions,
  foldEntityClusters,
  normalizeGates,
  pairState,
  recordText,
  runEntityBatch,
  signalsFrom,
  type EntityBatchItem,
  type EntityGates,
  type EntityRecord,
  type EntitySignals,
  type EntityVerdict,
} from "@/lib/entities";
import { toCSV, toJSON } from "@/lib/export";
import { entityPairs } from "@/data/entity-corpus";
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

const sig = (over: Partial<EntitySignals> = {}): EntitySignals => ({
  similarity: 2.0,
  conflict: 0.05,
  genericName: 0.05,
  confidence: 0.9,
  ...over,
});

function entityAnswers(
  over: Partial<{ similarity: Answer; conflict: Answer; genericName: Answer }> = {},
) {
  return {
    similarity: score(2, 0.9),
    conflict: noul(0.05),
    genericName: noul(0.05),
    ...over,
  } as Record<string, Answer>;
}

const rec = (id: string, name: string, extra: Partial<EntityRecord> = {}): EntityRecord => ({
  id,
  name,
  ...extra,
});

/* ------------------------------------------------------------------ */

describe("UC#10 entity verdicts + questions", () => {
  it("commitment ladder is strictly ordered distinct < review < merge", () => {
    expect(ENTITY_VERDICTS).toEqual(["distinct", "review", "merge"]);
    expect(ENTITY_RANK.distinct).toBeLessThan(ENTITY_RANK.review);
    expect(ENTITY_RANK.review).toBeLessThan(ENTITY_RANK.merge);
  });

  it("merge — the destructive lane — wears the alert badge; every verdict has a note", () => {
    expect(entityBadgeClass("distinct")).toBe("good");
    expect(entityBadgeClass("review")).toBe("warn");
    expect(entityBadgeClass("merge")).toBe("bad"); // wrong merges destroy records
    for (const v of ENTITY_VERDICTS) expect(ENTITY_NOTE[v]).toMatch(/\w/);
    expect(ENTITY_NOTE.merge).toMatch(/destructive/i);
  });

  it("questions declare ONE set: a similarity Score (5 levels) + two Nouls", () => {
    const qs = entityQuestions();
    expect(Object.keys(qs).sort()).toEqual(["conflict", "genericName", "similarity"]);
    expect(qs.similarity.type).toBe("score");
    expect(qs.similarity.type === "score" && qs.similarity.criteria).toEqual(SIMILARITY_LEVELS);
    expect(SIMILARITY_LEVELS).toHaveLength(5);
    expect(qs.conflict.type).toBe("noul");
    expect(qs.genericName.type).toBe("noul");
    expect(qs.conflict.type === "noul" && qs.conflict.criteria?.true).toMatch(/disagree/i);
    expect(qs.genericName.type === "noul" && qs.genericName.criteria?.true).toMatch(/generic/i);
  });

  it("default gates order the ladder sanely: distinctAt < mergeAt, floors are probabilities", () => {
    expect(DEFAULT_GATES.distinctAt).toBeLessThan(DEFAULT_GATES.mergeAt);
    expect(DEFAULT_GATES.mergeAt).toBeGreaterThan(0);
    expect(DEFAULT_GATES.conflictFloor).toBeGreaterThanOrEqual(0.5);
    expect(DEFAULT_GATES.collisionCap).toBeGreaterThanOrEqual(0.5);
  });

  it("normalizeGates merges partial slider values over defaults", () => {
    expect(normalizeGates({ conflictFloor: 0.9 })).toEqual({ ...DEFAULT_GATES, conflictFloor: 0.9 });
    expect(normalizeGates()).toEqual(DEFAULT_GATES);
  });

  it("recordText serializes identity fields and pairState puts BOTH records on the wire", () => {
    expect(recordText(rec("r01", " Brevona Barista 200 ", { brand: " Brevona ", model: "BR-200" }))).toBe(
      "Brevona Barista 200; brand: Brevona; model: BR-200",
    );
    const state = pairState(rec("rA", "Alpha widget", { detail: "mint" }), rec("rB", "Alpha widget 2"));
    expect(state).toContain("RECORD A (rA): Alpha widget; detail: mint");
    expect(state).toContain("RECORD B (rB): Alpha widget 2");
    expect(state.indexOf("RECORD A")).toBeLessThan(state.indexOf("RECORD B"));
  });
});

describe("UC#10 signalsFrom validation — declared-set discipline", () => {
  it("extracts signals from a full answer set", () => {
    const s = signalsFrom(entityAnswers({ similarity: score(3.5, 0.85) }));
    expect(s).toEqual({ similarity: 3.5, conflict: 0.05, genericName: 0.05, confidence: 0.85 });
  });

  it("accepts fractional similarity inside the declared levels", () => {
    expect(signalsFrom(entityAnswers({ similarity: score(4.2) })).similarity).toBe(4.2);
  });

  it("throws on out-of-range or wrong-type similarity", () => {
    expect(() => signalsFrom(entityAnswers({ similarity: score(5) }))).toThrow(/outside the declared levels/);
    expect(() => signalsFrom(entityAnswers({ similarity: score(-1) }))).toThrow(/outside the declared levels/);
    expect(() => signalsFrom(entityAnswers({ similarity: score(Number.NaN) }))).toThrow(/outside the declared levels/);
    expect(() => signalsFrom(entityAnswers({ similarity: noul(0.5) }))).toThrow(/outside the declared levels/);
    expect(() => signalsFrom({ ...entityAnswers(), similarity: undefined })).toThrow(/outside the declared levels/);
  });

  it("throws on missing/non-probability nouls", () => {
    expect(() => signalsFrom(entityAnswers({ conflict: score(1) }))).toThrow(/conflict/);
    expect(() => signalsFrom(entityAnswers({ genericName: score(1) }))).toThrow(/genericName/);
    const bad = entityAnswers();
    delete bad.genericName;
    expect(() => signalsFrom(bad)).toThrow(/genericName/);
    expect(() => signalsFrom(entityAnswers({ conflict: noul(1.5) }))).toThrow(/conflict/);
  });

  it("defaults confidence to 0 when the score omits it — never silently trusted", () => {
    const noConf = { type: "score", score: 4.5 } as Answer;
    expect(signalsFrom(entityAnswers({ similarity: noConf })).confidence).toBe(0);
  });
});

describe("UC#10 in-code entity ladder", () => {
  it("same-listing similarity → MERGE (the join lane, earned cleanly)", () => {
    const d = decideEntityVerdict(sig({ similarity: 4.2 }));
    expect(d.verdict).toBe("merge");
    expect(d.reasons[d.reasons.length - 1]).toContain("merge (same entity");
  });

  it("similarity at the exact mergeAt boundary → MERGE", () => {
    expect(decideEntityVerdict(sig({ similarity: DEFAULT_GATES.mergeAt })).verdict).toBe("merge");
  });

  it("similarity at the exact distinctAt boundary → DISTINCT", () => {
    const d = decideEntityVerdict(sig({ similarity: DEFAULT_GATES.distinctAt }));
    expect(d.verdict).toBe("distinct");
    expect(d.reasons.join(" ")).toMatch(/not the same record/);
  });

  it("mid similarity → REVIEW (plausible-but-unproven is the human lane)", () => {
    const d = decideEntityVerdict(sig({ similarity: 2.4 }));
    expect(d.verdict).toBe("review");
    expect(d.reasons.join(" ")).toMatch(/human lane/);
  });

  it("conflict floor is ABSOLUTE — a sibling pair FORCES DISTINCT over a razor-sharp ladder", () => {
    const d = decideEntityVerdict(sig({ similarity: 4.5, conflict: 0.9 }));
    expect(d.verdict).toBe("distinct");
    expect(d.reasons.join(" ")).toMatch(/FORCED apart/);
    expect(d.reasons.join(" ")).toMatch(/two products/);
  });

  it("conflict exactly at the floor trips the separation", () => {
    expect(decideEntityVerdict(sig({ similarity: 4.5, conflict: DEFAULT_GATES.conflictFloor })).verdict).toBe(
      "distinct",
    );
  });

  it("the conflict floor separates from ANY base and can never lift toward merge", () => {
    // review base → distinct
    expect(decideEntityVerdict(sig({ similarity: 2.5, conflict: 0.8 })).verdict).toBe("distinct");
    // distinct base stays distinct — the floor still speaks
    const d = decideEntityVerdict(sig({ similarity: 0.3, conflict: 0.8 }));
    expect(d.verdict).toBe("distinct");
    expect(d.reasons.join(" ")).toMatch(/FORCED apart/);
  });

  it("generic-name CAP routes a merge to REVIEW — weak evidence of same is not evidence of different", () => {
    const d = decideEntityVerdict(sig({ similarity: 3.8, genericName: 0.9 }));
    expect(d.verdict).toBe("review");
    expect(d.reasons.join(" ")).toMatch(/capped to review/);
    expect(d.reasons.join(" ")).toMatch(/a human decides/);
  });

  it("generic-name cap never separates and never touches a non-merge base", () => {
    const onReview = decideEntityVerdict(sig({ similarity: 2.0, genericName: 0.95 }));
    expect(onReview.verdict).toBe("review");
    expect(onReview.reasons.join(" ")).not.toMatch(/capped to review/);
    const onDistinct = decideEntityVerdict(sig({ similarity: 0.2, genericName: 0.95 }));
    expect(onDistinct.verdict).toBe("distinct");
    expect(onDistinct.reasons.join(" ")).not.toMatch(/capped to review/);
  });

  it("low confidence demotes MERGE to REVIEW, NEVER past it", () => {
    const d = decideEntityVerdict(sig({ similarity: 4.5, confidence: 0.2 }));
    expect(d.verdict).toBe("review");
    expect(d.reasons.join(" ")).toMatch(/uncertain merge never happens silently/);
    // doubt never pushes a pair into a definitive split
    expect(d.verdict).not.toBe("distinct");
    // review/distinct bases are untouched by doubt
    expect(decideEntityVerdict(sig({ similarity: 2, confidence: 0.1 })).verdict).toBe("review");
    expect(decideEntityVerdict(sig({ similarity: 0.3, confidence: 0.1 })).verdict).toBe("distinct");
  });

  it("the join lane is UNREACHABLE except by the clean ladder — floors and caps only ever escape it", () => {
    // a pair that the ladder loves but every safety rule rejects
    const d = decideEntityVerdict(sig({ similarity: 4.8, conflict: 0.9, genericName: 0.95, confidence: 0.9 }));
    expect(d.verdict).toBe("distinct"); // conflict floor speaks last on rank
    expect(d.reasons.join(" ")).not.toMatch(/capped to review/); // cap never fires after separation
    const cappedAndDoubted = decideEntityVerdict(sig({ similarity: 4.8, genericName: 0.95, confidence: 0.1 }));
    expect(cappedAndDoubted.verdict).toBe("review");
    expect(cappedAndDoubted.reasons.join(" ")).toMatch(/capped to review/);
    // the demotion rule never fired (cap already escaped merge) — and doubt
    // never pushed the pair past review into a forced split
    expect(cappedAndDoubted.reasons.join(" ")).not.toMatch(/uncertain merge never/);
    for (const dd of [d, cappedAndDoubted]) expect(dd.verdict).not.toBe("merge");
  });

  it("rule order is the story on the reasons: ladder → conflict floor → cap/demotion", () => {
    const d = decideEntityVerdict(sig({ similarity: 4.2, conflict: 0.9, genericName: 0.9 }));
    const iLadder = d.reasons.findIndex((r) => r.startsWith("similarity 4.2 ≥"));
    const iConflict = d.reasons.findIndex((r) => r.startsWith("conflict probability"));
    expect(iLadder).toBeGreaterThanOrEqual(0);
    expect(iConflict).toBeGreaterThan(iLadder);
    // the cap never fires after the floor already separated the pair
    expect(d.reasons.join(" ")).not.toMatch(/capped to review/);
  });

  it("sliders are honored: raising the conflict floor spares a near-twin, tightening mergeAt demotes a ladder case", () => {
    const generous: EntityGates = { ...DEFAULT_GATES, conflictFloor: 0.95 };
    expect(decideEntityVerdict(sig({ similarity: 4.2, conflict: 0.9 }), generous).verdict).toBe("merge");
    const strict: EntityGates = { ...DEFAULT_GATES, mergeAt: 4.4 };
    expect(decideEntityVerdict(sig({ similarity: 4.2 }), strict).verdict).toBe("review");
    const looseCap: EntityGates = { ...DEFAULT_GATES, collisionCap: 0.95 };
    expect(decideEntityVerdict(sig({ similarity: 4.2, genericName: 0.9 }), looseCap).verdict).toBe("merge");
  });
});

describe("UC#10 live single align (alignEntityPair)", () => {
  it("aligns one pasted pair end-to-end with the injected classifier", async () => {
    let asked: Record<string, unknown> | undefined;
    const classifyFn = (async (req: { state: string; questions: Record<string, unknown> }) => {
      asked = req.questions;
      return fakeResult(entityAnswers({ similarity: score(4.4, 0.95) }));
    }) as never;

    const out = await alignEntityPair(
      rec("uA", "Kestrel TrailRunner 4", { model: "TR4" }),
      rec("uB", "Kestrel Trailrunner 4 shoes", { model: "TR-4" }),
      { classifyFn },
    );
    expect(out.decision.verdict).toBe("merge");
    expect(out.signals.similarity).toBe(4.4);
    expect(out.model).toBe("jev-test");
    expect(out.provider).toBe("gateway");
    expect(out.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    expect(out.state).toContain("RECORD A (uA)");
    expect(out.state).toContain("RECORD B (uB)");
    expect(Object.keys(asked ?? {}).sort()).toEqual(["conflict", "genericName", "similarity"]);
  });

  it("conflict floor BLOCKS the join live — a Pro sibling never merges however sharp the reader", async () => {
    const classifyFn = (async () =>
      fakeResult(entityAnswers({ similarity: score(4.5, 0.95), conflict: noul(0.9) }))) as never;
    const out = await alignEntityPair(rec("x", "PhoneX 12"), rec("y", "PhoneX 12 Pro"), { classifyFn });
    expect(out.decision.verdict).toBe("distinct");
  });

  it("passes gates through and reports the effective set", async () => {
    const classifyFn = (async () =>
      fakeResult(entityAnswers({ similarity: score(4.0, 0.95), genericName: noul(0.8) }))) as never;
    const gates = normalizeGates({ collisionCap: 0.95 });
    const out = await alignEntityPair(rec("x", "a"), rec("y", "b"), { classifyFn, gates });
    expect(out.gates).toEqual(gates);
    expect(out.decision.verdict).toBe("merge"); // cap raised above the 0.8 answer
  });

  it("attaches the dev trace when asked, and omits it otherwise", async () => {
    const traceResult = (answers: Record<string, Answer>): ClassifyResult => ({
      ...fakeResult(answers),
      trace: { provider_used: "gateway", endpoint: "x", request: {}, attempts: [], retries: 0 },
    });
    const classifyFn = (async () => traceResult(entityAnswers())) as never;
    const dev = await alignEntityPair(rec("x", "a"), rec("y", "b"), { classifyFn, trace: true });
    expect(dev.trace).toBeDefined();
    const plain = await alignEntityPair(rec("x", "a"), rec("y", "b"), { classifyFn });
    expect(plain.trace).toBeUndefined();
  });

  it("propagates classifier errors and validator hard-fails — no silent merges", async () => {
    const boom = (async () => {
      throw new Error("gateway down");
    }) as never;
    await expect(alignEntityPair(rec("x", "a"), rec("y", "b"), { classifyFn: boom })).rejects.toThrow(/gateway down/);

    const bad = (async () => fakeResult({ similarity: noul(0.5) })) as never;
    await expect(alignEntityPair(rec("x", "a"), rec("y", "b"), { classifyFn: bad })).rejects.toThrow(
      /outside the declared levels/,
    );
  });
});

describe("UC#10 shipped corpus — one market audit of candidate pairs", () => {
  it("carries 25 unique pairs, each with two fully-formed records", () => {
    const corpus = buildEntityCorpus();
    expect(corpus.length).toBe(entityPairs.length);
    expect(corpus.length).toBe(25);
    const ids = corpus.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of corpus) {
      expect(c.a.id.trim().length).toBeGreaterThan(0);
      expect(c.b.id.trim().length).toBeGreaterThan(0);
      expect(c.a.id).not.toBe(c.b.id);
      expect(c.a.name.trim().length).toBeGreaterThan(0);
      expect(c.b.name.trim().length).toBeGreaterThan(0);
      expect(c.state).toBe(pairState(c.a, c.b));
      expect(c.state).toContain(recordText(c.a));
      expect(c.state).toContain(recordText(c.b));
    }
  });

  it("covers every species the steward needs — dupes, contradictions, generics, strangers", () => {
    const all = buildEntityCorpus().map((c) => c.state);
    const has = (re: RegExp) => all.some((s) => re.test(s));
    expect(has(/Barista 200/i)).toBe(true); // copy-paste twins (join lane)
    expect(has(/TrailRunner 4|Trailrunner 4/i)).toBe(true); // typo twins
    expect(has(/12 Pro|2-pack|hardcover|curved/i)).toBe(true); // identifier contradictions
    expect(has(/wireless earbuds|running shoes|coffee grinder/i)).toBe(true); // generic-name collisions
    expect(has(/skillet cleaner|dome tent/i)).toBe(true); // clearly different records
  });

  it("ships cluster chains: records shared across pairs let merges fold transitively", () => {
    const nodeAppearances = new Map<string, number>();
    for (const p of entityPairs) {
      nodeAppearances.set(p.a.id, (nodeAppearances.get(p.a.id) ?? 0) + 1);
      nodeAppearances.set(p.b.id, (nodeAppearances.get(p.b.id) ?? 0) + 1);
    }
    const shared = [...nodeAppearances.entries()].filter(([, n]) => n > 1);
    expect(shared.length).toBeGreaterThanOrEqual(3);
    expect(nodeAppearances.get("r02")).toBeGreaterThanOrEqual(2); // p01 ∪ p22
    expect(nodeAppearances.get("r03")).toBeGreaterThanOrEqual(2); // p02 ∪ p23
  });

  it("every record is synthetic — no real marketplace and no live links", () => {
    for (const c of buildEntityCorpus()) {
      expect(c.state).not.toMatch(/https?:\/\//);
      expect(c.state).not.toMatch(/amazon|ebay|mercari|facebook\.com/i);
    }
  });
});

describe("UC#10 contradiction-safe cluster folding", () => {
  const item = (
    id: string,
    a: string,
    b: string,
    verdict?: EntityVerdict,
    similarity?: number,
    error?: string,
  ): EntityBatchItem => ({
    id,
    a: rec(a, `${a} name`),
    b: rec(b, `${b} name`),
    aId: a,
    bId: b,
    ...(verdict ? { verdict, signals: sig({ similarity: similarity ?? 2 }) } : {}),
    ...(error ? { error } : {}),
  });

  it("merge edges fold transitively — A=B and B=C become one cluster", () => {
    const { clusters, blocked } = foldEntityClusters([
      item("m1", "nA", "nB", "merge", 4.9),
      item("m2", "nB", "nC", "merge", 4.4),
    ]);
    expect(blocked).toEqual([]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].canonical).toBe("nA");
    expect(clusters[0].members).toEqual(["nA", "nB", "nC"]);
    expect(clusters[0].edges).toEqual(["m1", "m2"]);
  });

  it("review and distinct edges NEVER join — only the merge lane folds", () => {
    const { clusters } = foldEntityClusters([
      item("r1", "nA", "nB", "review", 2.5),
      item("d1", "nC", "nD", "distinct", 0.4),
    ]);
    expect(clusters).toEqual([]);
  });

  it("a transitive chain never overrules a called separation — the join is REFUSED and logged", () => {
    const fold = foldEntityClusters([
      item("m1", "nA", "nB", "merge", 4.9),
      item("m2", "nB", "nC", "merge", 4.4),
      item("d1", "nA", "nC", "distinct", 0.5),
    ]);
    // strongest first: nA~nB joins; nB~nC would park nA with separated nC → refused
    expect(fold.clusters).toHaveLength(1);
    expect(fold.clusters[0].members).toEqual(["nA", "nB"]);
    expect(fold.clusters[0].edges).toEqual(["m1"]);
    expect(fold.blocked).toHaveLength(1);
    expect(fold.blocked[0].pairId).toBe("m2");
    expect(fold.blocked[0].reason).toMatch(/never overrules a called separation/);
    expect(fold.blocked[0].reason).toMatch(/nA.*nC/);
  });

  it("contradiction check spans the FULL prospective cluster, not just the edge", () => {
    const fold = foldEntityClusters([
      item("m1", "nA", "nB", "merge", 4.9), // {nA,nB}
      item("m2", "nC", "nD", "merge", 4.8), // {nC,nD}
      item("d1", "nB", "nD", "distinct", 0.2), // separation across the future seam
      item("m3", "nA", "nC", "merge", 4.1), // would join {nA,nB}×{nC,nD} → nB/nD clash
    ]);
    expect(fold.clusters.map((c) => c.members.join(",")).sort()).toEqual(["nA,nB", "nC,nD"]);
    expect(fold.blocked.map((b) => b.pairId)).toEqual(["m3"]);
  });

  it("strongest evidence wins: with two possible survivors the higher-similarity fold is kept", () => {
    const fold = foldEntityClusters([
      item("m1", "nA", "nB", "merge", 4.2),
      item("m2", "nB", "nC", "merge", 4.9),
      item("d1", "nA", "nC", "distinct", 0.2),
    ]);
    // m2 (4.9) folds {nB,nC} first; m1 (4.2) would cross nA↔nC → m1 is the refused edge
    expect(fold.clusters[0].members).toEqual(["nB", "nC"]);
    expect(fold.clusters[0].canonical).toBe("nB");
    expect(fold.blocked.map((b) => b.pairId)).toEqual(["m1"]);
  });

  it("deterministic under input order — the same audit shuffled twice folds the same", () => {
    const items = [
      item("m1", "nA", "nB", "merge", 4.9),
      item("m2", "nB", "nC", "merge", 4.4),
      item("m3", "nD", "nE", "merge", 4.0),
      item("d1", "nA", "nC", "distinct", 0.1),
      item("r1", "nE", "nF", "review", 2.2),
    ];
    const shuffled = [...items].reverse();
    expect(foldEntityClusters(shuffled)).toEqual(foldEntityClusters(items));
  });

  it("a duplicate re-merge inside an existing cluster adds an edge, not a member", () => {
    const fold = foldEntityClusters([
      item("m1", "nA", "nB", "merge", 4.9),
      item("m2", "nB", "nC", "merge", 4.4),
      item("m3", "nA", "nC", "merge", 4.1), // transitive within one cluster
    ]);
    expect(fold.clusters).toHaveLength(1);
    expect(fold.clusters[0].members).toEqual(["nA", "nB", "nC"]);
    expect(fold.clusters[0].edges).toEqual(["m1", "m2", "m3"]);
    expect(fold.blocked).toEqual([]);
  });

  it("errored items are excluded from the fold and never join or separate anything", () => {
    const fold = foldEntityClusters([
      item("x1", "nA", "nB", undefined, undefined, "gateway down"),
      item("m1", "nA", "nB", "merge", 4.9),
    ]);
    expect(fold.clusters[0].members).toEqual(["nA", "nB"]);
    expect(fold.clusters[0].edges).toEqual(["m1"]);
  });

  it("no merges means no clusters — a clean audit folds to nothing", () => {
    expect(foldEntityClusters([])).toEqual({ clusters: [], blocked: [] });
    expect(foldEntityClusters([item("d1", "nA", "nB", "distinct", 0.2)]).clusters).toEqual([]);
  });

  it("folding is pure — input items are never mutated", () => {
    const items = [item("m1", "nB", "nA", "merge", 4.9), item("m2", "nA", "nC", "merge", 4.4)];
    const snapshot = JSON.stringify(items);
    foldEntityClusters(items);
    expect(JSON.stringify(items)).toBe(snapshot);
  });
});

describe("UC#10 runEntityBatch (ladder 5 → 10 → All + tallies + clusters)", () => {
  // 14 synthetic pairs exercising every rule of the shipped ladder,
  // including a contradiction-safe cluster chain (gA/gB/gC/gD) and
  // a per-pair boom. The classifier is keyed on pair-specific rules
  // first, species tokens second.
  const corpus = [
    { id: "t01", a: rec("gA", "widget alpha"), b: rec("gB", "widget beta") }, // merge 4.9
    { id: "t02", a: rec("gB", "widget beta"), b: rec("gC", "widget gamma") }, // merge 4.2
    { id: "t03", a: rec("gA", "widget alpha"), b: rec("gD", "widget delta") }, // conflict → distinct
    { id: "t04", a: rec("gC", "widget gamma"), b: rec("gD", "widget delta") }, // merge 4.4
    { id: "t05", a: rec("gE", "GENERIC gadget"), b: rec("gF", "GENERIC gadget blue") }, // cap → review
    { id: "t06", a: rec("gG", "DOUBT doohickey"), b: rec("gH", "DOUBT doohickey two") }, // doubt → review
    { id: "t07", a: rec("gI", "PLAUS mid-range part"), b: rec("gJ", "PLAUS mid-range part XL") }, // ladder → review
    { id: "t08", a: rec("gK", "UNRELATED lamp"), b: rec("gL", "UNRELATED side table") }, // ladder → distinct
    { id: "t09", a: rec("gM", "BOOM breaker"), b: rec("gN", "BOOM breaker two") }, // error
    { id: "t10", a: rec("gO", "UNRELATED mug"), b: rec("gP", "UNRELATED saucer") }, // distinct
    { id: "t11", a: rec("gQ", "UNRELATED chess set"), b: rec("gR", "UNRELATED dice") }, // distinct
    { id: "t12", a: rec("gS", "UNRELATED lamp shade"), b: rec("gT", "UNRELATED curtain rod") }, // distinct
    { id: "t13", a: rec("gU", "UNRELATED map"), b: rec("gV", "UNRELATED atlas stand") }, // distinct
    { id: "t14", a: rec("gW", "PLAUS router"), b: rec("gX", "PLAUS router with antenna") }, // review
  ];

  const pairRule: [string, string, () => Record<string, Answer>][] = [
    ["gA", "gB", () => entityAnswers({ similarity: score(4.9, 0.95) })],
    ["gC", "gD", () => entityAnswers({ similarity: score(4.4, 0.95) })],
    ["gB", "gC", () => entityAnswers({ similarity: score(4.2, 0.95) })],
    ["gA", "gD", () => entityAnswers({ similarity: score(4.3, 0.95), conflict: noul(0.9) })],
  ];

  async function fakeClassify(req: { state: string }): Promise<ClassifyResult> {
    for (const [x, y, make] of pairRule) {
      if (req.state.includes(`(${x})`) && req.state.includes(`(${y})`)) return fakeResult(make());
    }
    if (req.state.includes("BOOM")) throw new Error("gateway down for t09");
    if (req.state.includes("GENERIC")) {
      return fakeResult(entityAnswers({ similarity: score(3.8, 0.9), genericName: noul(0.85) }));
    }
    if (req.state.includes("DOUBT")) {
      return fakeResult(entityAnswers({ similarity: score(4.0, 0.2) }));
    }
    if (req.state.includes("PLAUS")) {
      return fakeResult(entityAnswers({ similarity: score(2.4, 0.9) }));
    }
    return fakeResult(entityAnswers({ similarity: score(0.4, 0.95) })); // UNRELATED default
  }
  const fakeFn = fakeClassify as never;

  it("processes the first ladder rung by default — exact tallies, no errors yet", async () => {
    const rep = await runEntityBatch(corpus, { classifyFn: fakeFn });
    expect(rep.items.length).toBe(5);
    expect(rep.totals).toMatchObject({
      compared: 5,
      errors: 0,
      verdicts: { distinct: 1, review: 1, merge: 3 },
      usage: { input_tokens: 50, output_tokens: 25 },
    });
  });

  it("the rung-5 fold already refuses the contradicted chain (t01 ∪ t04 before t02)", async () => {
    const rep = await runEntityBatch(corpus, { classifyFn: fakeFn });
    expect(rep.clusters.map((c) => c.members.join(",")).sort()).toEqual(["gA,gB", "gC,gD"]);
    expect(rep.blocked.map((b) => b.pairId)).toEqual(["t02"]);
    expect(rep.blocked[0].reason).toMatch(/gA.*gD/);
  });

  it("rung 10 isolates the boom to its own pair and counts it", async () => {
    const rep = await runEntityBatch(corpus, { classifyFn: fakeFn, limit: 10 });
    expect(rep.items.length).toBe(10);
    expect(rep.totals.compared).toBe(10);
    expect(rep.totals.errors).toBe(1);
    expect(rep.totals.verdicts).toEqual({ distinct: 3, review: 3, merge: 3 });
    const boom = rep.items.find((i) => i.id === "t09")!;
    expect(boom.error).toMatch(/gateway down/);
    expect(boom.verdict).toBeUndefined();
    // the rest of the audit keeps flowing while one pair dies
    expect(rep.items.filter((i) => !i.error).length).toBe(9);
  });

  it("All walks the whole audit with exact tallies, usage, clusters, and blocked joins", async () => {
    const rep = await runEntityBatch(corpus, { classifyFn: fakeFn, limit: null });
    expect(rep.items.length).toBe(14);
    expect(rep.totals.verdicts).toEqual({ distinct: 6, review: 4, merge: 3 });
    expect(rep.totals.errors).toBe(1);
    expect(rep.totals.usage).toEqual({ input_tokens: 130, output_tokens: 65 });
    expect(rep.clusters.map((c) => c.canonical)).toEqual(["gA", "gC"]);
    expect(rep.blocked.map((b) => b.pairId)).toEqual(["t02"]);
    expect(rep.model).toBe("jev-test");
    expect(rep.provider).toBe("gateway");
  });

  it("limits beyond the audit clamp to All, and 0 compares nothing", async () => {
    let calls = 0;
    const counting = (async (req: { state: string }) => {
      calls += 1;
      return fakeClassify(req);
    }) as never;
    const big = await runEntityBatch(corpus, { classifyFn: counting, limit: 999 });
    expect(big.items.length).toBe(14);
    const zero = await runEntityBatch(corpus, { classifyFn: counting, limit: 0 });
    expect(zero.items.length).toBe(0);
    expect(zero.totals).toMatchObject({ compared: 0, errors: 0 });
    expect(zero.clusters).toEqual([]);
    expect(zero.blocked).toEqual([]);
    expect(calls).toBe(14);
  });

  it("an empty audit never calls the classifier and reports zeros", async () => {
    let calls = 0;
    const counting = (async () => {
      calls += 1;
      return fakeResult(entityAnswers());
    }) as never;
    const rep = await runEntityBatch([], { classifyFn: counting });
    expect(calls).toBe(0);
    expect(rep.totals).toEqual({
      compared: 0,
      errors: 0,
      verdicts: { distinct: 0, review: 0, merge: 0 },
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  });

  it("gate sliders ride every pair and echo back in the report", async () => {
    const rep = await runEntityBatch(corpus, {
      classifyFn: fakeFn,
      limit: null,
      gates: { collisionCap: 0.95 },
    });
    expect(rep.gates).toEqual(normalizeGates({ collisionCap: 0.95 }));
    // cap raised above the fake 0.85 answer: the GENERIC pair now reaches the join lane
    expect(rep.items.find((i) => i.id === "t05")!.verdict).toBe("merge");
  });

  it("batch items carry node ids and full records so the fold and the export ride them", async () => {
    const rep = await runEntityBatch([corpus[0]], { classifyFn: fakeFn });
    const it = rep.items[0];
    expect(it.aId).toBe("gA");
    expect(it.bId).toBe("gB");
    expect(it.a.name).toBe("widget alpha");
    expect(it.signals).toBeDefined();
    expect(it.verdict).toBe("merge");
    expect(it.reasons!.some((r) => r.startsWith("entity verdict:"))).toBe(true);
  });

  it("the shipped audit walks the ladder: twins merge, Pro siblings force apart, generics queue", async () => {
    const shippedFake = (async (req: { state: string }) => {
      if (/12 Pro|2-pack|hardcover|curved|descaling|chainmail|resistance band|tuner pedal|Folding city|cassette/i.test(req.state)) {
        return fakeResult(entityAnswers({ similarity: score(4.1, 0.95), conflict: noul(0.9) }));
      }
      if (/wireless earbuds|running shoes, blue|coffee grinder|OEM|ceramic burr/i.test(req.state)) {
        return fakeResult(entityAnswers({ similarity: score(3.8, 0.9), genericName: noul(0.85) }));
      }
      if (/Barista 200|Trailrunner|TrailRunner|Neon Ledger|Clutch Circuit|Clacktype|Desk Lamp/i.test(req.state)) {
        return fakeResult(entityAnswers({ similarity: score(4.4, 0.95) }));
      }
      return fakeResult(entityAnswers({ similarity: score(0.5, 0.95) }));
    }) as never;

    const rep = await runEntityBatch(buildEntityCorpus(), { classifyFn: shippedFake, limit: null });
    const byId = new Map(rep.items.map((i) => [i.id, i.verdict]));
    expect(byId.get("p01")).toBe("merge"); // espresso twins
    expect(byId.get("p22")).toBe("merge"); // the refurb re-listing of the SAME r02
    expect(byId.get("p07")).toBe("distinct"); // PhoneX 12 vs 12 Pro — the floor forces it
    expect(byId.get("p08")).toBe("distinct"); // single vs 2-pack — quantity disagrees
    expect(byId.get("p13")).toBe("review"); // wireless earbuds — generic cap
    expect(byId.get("p19")).toBe("distinct"); // tent vs descaler — the ladder separates
    // contradiction-safe clustering over the SHIPPED chain: p01 (r01,r02) + p22 (r02,r43)
    const espresso = rep.clusters.find((c) => c.members.includes("r01"));
    expect(espresso?.members).toEqual(["r01", "r02", "r43"]);
    expect(espresso?.edges.sort()).toEqual(["p01", "p22"]);
    // and the Kestrel chain folds too (p02 r03~r04 ∪ p23 r44~r03)
    expect(rep.clusters.some((c) => c.members.join(",") === "r03,r04,r44")).toBe(true);
    // every fold is a decision, every error counted: nothing vanishes
    expect(rep.totals.compared).toBe(25);
    expect(
      rep.totals.verdicts.distinct + rep.totals.verdicts.review + rep.totals.verdicts.merge + rep.totals.errors,
    ).toBe(rep.totals.compared);
  });
});

describe("UC#10 D8 export surfaces", () => {
  const item = (id: string, a: string, b: string, over: Partial<EntityBatchItem> = {}): EntityBatchItem => ({
    id,
    a: rec(a, "alpha, the first"),
    b: rec(b, 'beta "the second"'),
    aId: a,
    bId: b,
    ...over,
  });

  it("pair export has a stable column order with rank riding the input order", () => {
    const rows = entityPairExportRows([
      item("p01", "r01", "r02", { verdict: "merge", signals: sig({ similarity: 4.4, conflict: 0.02, genericName: 0.1, confidence: 0.95 }) }),
      item("p02", "r03", "r04", { verdict: "distinct", signals: sig({ similarity: 0.5 }) }),
      item("p03", "r05", "r06", { error: "gateway down" }),
    ]);
    expect(Object.keys(rows[0])).toEqual([
      "rank",
      "pair",
      "a",
      "nameA",
      "b",
      "nameB",
      "similarity",
      "conflict",
      "generic",
      "confidence",
      "verdict",
    ]);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(rows[0].verdict).toBe("merge");
    expect(rows[2].verdict).toBe("error"); // excluded-and-counted rides the export too
    expect(rows[2].similarity).toBe("");
  });

  it("cluster export flattens members and edges with rank riding the fold order", () => {
    const rows = entityClusterExportRows([
      { canonical: "nA", members: ["nA", "nB", "nC"], edges: ["m1", "m2"] },
      { canonical: "nD", members: ["nD", "nE"], edges: ["m3"] },
    ]);
    expect(Object.keys(rows[0])).toEqual(["rank", "canonical", "size", "members", "edges"]);
    expect(rows[0]).toEqual({ rank: 1, canonical: "nA", size: 3, members: "nA|nB|nC", edges: "m1|m2" });
    expect(rows[1].size).toBe(2);
  });

  it("CSV quoting survives record names with commas and quotes (3dp rounding)", () => {
    const rows = entityPairExportRows([
      item("p01", "r01", "r02", { verdict: "merge", signals: sig({ similarity: 4.4444, conflict: 0.5, genericName: 0.25, confidence: 0.75 }) }),
    ]);
    const csv = toCSV(rows);
    expect(csv.split("\r\n")[0]).toBe("rank,pair,a,nameA,b,nameB,similarity,conflict,generic,confidence,verdict");
    expect(csv).toContain('"alpha, the first"'); // comma-safe label
    expect(csv).toContain('"beta ""the second"""'); // quote-safe label
    expect(csv).toContain("4.444"); // 3dp
    expect(csv.split("\r\n")).toHaveLength(2); // header + one row — nothing breaks lines
    const roundTrip = JSON.parse(toJSON(rows));
    expect(roundTrip[0].similarity).toBe(4.444);
    expect(roundTrip[0].verdict).toBe("merge");
  });
});
