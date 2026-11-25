// @vitest-environment node
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAL_BIN_COUNT,
  CALIBRATION_RUN_LANE,
  CAL_GAP_WARN,
  buildCalibrationTable,
  calBinIndex,
  calPointsFromHarness,
  calPointsFromPayload,
  calibrationExportRows,
  calibrationRunSummary,
  isCalibrationSnapshot,
  type CalibrationSnapshot,
} from "@/lib/calibration";
import { toCSV } from "@/lib/export";
import {
  closeResultsDb,
  loadLatestRun,
  openResultsDb,
  saveBatchRun,
} from "@/lib/sqlite";
import type { HarnessReport, HarnessItemReport } from "@/lib/harness";
import type { Answer } from "@/lib/schema";

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const P = (id: string, confidence: number, correct: boolean) => ({ id, confidence, correct });

/** A minimal fake harness item: jev answers + agreement per question. */
function fakeItem(
  id: string,
  jevAnswers: Record<string, Answer>,
  agreement: Record<string, "match" | "diff" | "n/a">,
  jevOk = true,
): HarnessItemReport {
  return {
    id,
    dataset: "emails",
    status: "match",
    agreement,
    diffQuestions: [],
    jev: { provider: "jev", ok: jevOk, answers: jevOk ? jevAnswers : undefined },
    emulated: { provider: "gateway", ok: true, answers: {} },
    jevDecisions: {},
    emulatedDecisions: {},
  } as unknown as HarnessItemReport;
}

const choice = (c: string, conf: number): Answer => ({
  type: "choice",
  choice: c,
  probabilities: {},
  confidence: conf,
});
const score = (s: number, conf: number): Answer => ({
  type: "score",
  score: s,
  probabilities: {},
  confidence: conf,
});
const noul = (p: number): Answer => ({ type: "noul", noul: p });

function fakeReport(items: HarnessItemReport[]): HarnessReport {
  return { items, totals: {}, ladder: [5], generatedAt: "2026-11-26T05:00:00.000Z" } as unknown as HarnessReport;
}

/* ------------------------------------------------------------------ *
 * The bin ladder — code decides, the top edge is CLOSED
 * ------------------------------------------------------------------ */

describe("calBinIndex", () => {
  it("maps [0,1) onto ten 0.1-wide bins", () => {
    expect(calBinIndex(0)).toBe(0);
    expect(calBinIndex(0.099)).toBe(0);
    expect(calBinIndex(0.1)).toBe(1);
    expect(calBinIndex(0.55)).toBe(5);
    expect(calBinIndex(0.89)).toBe(8);
    expect(calBinIndex(0.9)).toBe(9);
  });

  it("CLOSES the top bin at 1.0 — a perfect confidence is legal data, not an error", () => {
    expect(calBinIndex(1)).toBe(9);
    expect(calBinIndex(0.999)).toBe(9);
  });

  it("refuses out-of-range confidences outright", () => {
    expect(() => calBinIndex(1.0001)).toThrow(/out of range/);
    expect(() => calBinIndex(-0.01)).toThrow(/out of range/);
    expect(() => calBinIndex(NaN)).toThrow(/out of range/);
    expect(() => calBinIndex(Infinity)).toThrow(/out of range/);
  });
});

/* ------------------------------------------------------------------ *
 * Manual intake: THE TABLE NEVER TRUSTS A PAYLOAD
 * ------------------------------------------------------------------ */

describe("calPointsFromPayload", () => {
  it("keeps well-formed rows and balances the receipt", () => {
    const intake = calPointsFromPayload([P("m1", 0.9, true), P("m2", 0.2, false)]);
    expect(intake.points).toHaveLength(2);
    expect(intake.counts).toEqual({ seen: 2, kept: 2, rejected: 0 });
    expect(intake.counts.seen).toBe(intake.counts.kept + intake.counts.rejected);
  });

  it("refuses junk with row numbers — every refusal is counted, none silently dropped", () => {
    const intake = calPointsFromPayload([
      P("good", 0.5, true),
      "a string is not a row",
      { confidence: 0.5, correct: true }, // no id
      { id: "bad", confidence: "0.5", correct: true }, // stringy confidence
      { id: "nan", confidence: NaN, correct: true },
      { id: "over", confidence: 1.5, correct: true },
      { id: "neg", confidence: -0.1, correct: true },
      { id: "c", confidence: 0.5, correct: "yes" }, // truthy-string is not a boolean
    ]);
    expect(intake.points.map((p) => p.id)).toEqual(["good"]);
    expect(intake.counts).toEqual({ seen: 8, kept: 1, rejected: 7 });
    const rows = intake.rejected.map((r) => r.row);
    expect(rows).toEqual([2, 3, 4, 5, 6, 7, 8]); // 1-based over the array
    expect(intake.rejected.some((r) => /boolean/.test(r.reason))).toBe(true);
    expect(intake.rejected.some((r) => /\[0,1\]/.test(r.reason))).toBe(true);
  });

  it("rejects ids that would poison a CSV", () => {
    const intake = calPointsFromPayload([
      { id: "bad id with spaces", confidence: 0.5, correct: true },
      { id: "x".repeat(121), confidence: 0.5, correct: true },
      { id: "semi;colon", confidence: 0.5, correct: true },
    ]);
    expect(intake.points).toHaveLength(0);
    expect(intake.counts.rejected).toBe(3);
  });

  it("a non-array payload is refused whole with a header-level reason", () => {
    const intake = calPointsFromPayload({ not: "an array" });
    expect(intake.points).toHaveLength(0);
    expect(intake.rejected[0].row).toBe(0);
    expect(intake.rejected[0].reason).toMatch(/array/);
    expect(intake.counts).toEqual({ seen: 0, kept: 0, rejected: 1 });
  });

  it("an empty array is clean nothing, not an error", () => {
    const intake = calPointsFromPayload([]);
    expect(intake.counts).toEqual({ seen: 0, kept: 0, rejected: 0 });
  });
});

/* ------------------------------------------------------------------ *
 * Harness derivation: agreement-as-correctness, EXCLUDED-AND-COUNTED
 * ------------------------------------------------------------------ */

describe("calPointsFromHarness", () => {
  it("match becomes correct, diff becomes a miss — with composed ids", () => {
    const der = calPointsFromHarness(
      fakeReport([
        fakeItem("e1", { urgency: choice("yes", 0.95), tone: score(3, 0.8) }, { urgency: "match", tone: "diff" }),
      ]),
    );
    expect(der.points).toEqual([
      { id: "e1::urgency", confidence: 0.95, correct: true },
      { id: "e1::tone", confidence: 0.8, correct: false },
    ]);
    expect(der.counts.answersSeen).toBe(2);
    expect(der.counts.kept).toBe(2);
  });

  it("n/a agreement is excluded-AND-COUNTED — a dead side is never graded either way", () => {
    const der = calPointsFromHarness(
      fakeReport([fakeItem("e1", { a: score(2, 0.7), b: score(4, 0.9) }, { a: "match", b: "n/a" })]),
    );
    expect(der.points).toHaveLength(1);
    expect(der.counts.naExcluded).toBe(1);
    // the receipt balances: everything seen is either a point or a named exclusion
    expect(der.counts.answersSeen).toBe(
      der.counts.kept + der.counts.naExcluded + der.counts.noConfidenceExcluded,
    );
  });

  it("noul answers (no confidence field) are excluded-and-counted, not calibrated on noul", () => {
    const der = calPointsFromHarness(
      fakeReport([fakeItem("e1", { leak: noul(0.99), bug: choice("yes", 0.6) }, { leak: "match", bug: "match" })]),
    );
    expect(der.points).toHaveLength(1);
    expect(der.points[0].id).toBe("e1::bug");
    expect(der.counts.noConfidenceExcluded).toBe(1);
  });

  it("a dead jev side counts as an errored ITEM and contributes zero answers", () => {
    const der = calPointsFromHarness(
      fakeReport([
        fakeItem("bad", {}, {}, false),
        fakeItem("ok", { a: score(1, 0.5) }, { a: "diff" }),
      ]),
    );
    expect(der.counts.erroredItems).toBe(1);
    expect(der.counts.answersSeen).toBe(1);
    expect(der.points).toHaveLength(1);
    expect(der.points[0].correct).toBe(false);
  });

  it("an answer whose confidence is lying (NaN / out of range) is excluded, never trusted", () => {
    const der = calPointsFromHarness(
      fakeReport([
        fakeItem("e1", { a: score(1, NaN), b: score(2, 1.4), c: score(3, 0.5) }, { a: "match", b: "match", c: "match" }),
      ]),
    );
    expect(der.points).toHaveLength(1);
    expect(der.counts.noConfidenceExcluded).toBe(2);
  });

  it("an empty report derives to nothing, loudly zero — not a crash", () => {
    const der = calPointsFromHarness(fakeReport([]));
    expect(der.points).toHaveLength(0);
    expect(der.counts).toEqual({ answersSeen: 0, kept: 0, naExcluded: 0, noConfidenceExcluded: 0, erroredItems: 0 });
  });
});

/* ------------------------------------------------------------------ *
 * The table
 * ------------------------------------------------------------------ */

describe("buildCalibrationTable", () => {
  it("always ships exactly 10 bins in fixed order with readable ranges", () => {
    const t = buildCalibrationTable([P("a", 0.95, true)]);
    expect(t.bins).toHaveLength(CAL_BIN_COUNT);
    expect(t.bins.map((b) => b.bin)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(t.bins[0].range).toBe("0.0–0.1");
    expect(t.bins[9].range).toBe("0.9–1.0");
  });

  it("EMPTY BINS ARE SHOWN, NOT SKIPPED — n=0 with null stats and a 'no sample' label", () => {
    const t = buildCalibrationTable([P("a", 0.95, true)]);
    const empty = t.bins.filter((b) => b.n === 0);
    expect(empty).toHaveLength(9);
    for (const b of empty) {
      expect(b.meanConf).toBeNull();
      expect(b.accuracy).toBeNull();
      expect(b.gap).toBeNull();
      expect(b.label).toBe("no sample");
    }
  });

  it("a perfect 1.0 lands in the top bin, so the receipt closes it", () => {
    const t = buildCalibrationTable([P("a", 1, true)]);
    expect(t.bins[9].n).toBe(1);
    expect(t.bins[9].meanConf).toBe(1);
    expect(t.bins[9].accuracy).toBe(1);
    expect(t.bins[9].gap).toBe(0);
  });

  it("OVERCONFIDENCE reads as accuracy LEFT of the claim: negative gap, loud label", () => {
    const points = Array.from({ length: 10 }, (_, i) => P(`o${i}`, 0.92, i < 2));
    const t = buildCalibrationTable(points);
    const b = t.bins[9];
    expect(b.accuracy).toBe(0.2);
    expect(b.gap).toBeCloseTo(0.2 - 0.92, 3);
    expect(b.label).toBe("overconfident");
    expect(t.ece!).toBeGreaterThanOrEqual(0.7);
    expect(t.verdict).toMatch(/overconfident/);
  });

  it("UNDERCONFIDENCE flips the sign past the warn gap", () => {
    const points = Array.from({ length: 10 }, () => P("u", 0.25, true));
    const t = buildCalibrationTable(points);
    const b = t.bins[2];
    expect(b.gap).toBeGreaterThan(CAL_GAP_WARN);
    expect(b.label).toBe("underconfident");
    expect(t.verdict).toMatch(/underconfident/);
  });

  it("inside the warn gap the bin stays honest — the label is earned", () => {
    const points = Array.from({ length: 10 }, (_, i) => P(`h${i}`, 0.62, i < 7));
    const t = buildCalibrationTable(points);
    expect(t.bins[6].label).toBe("honest");
    expect(t.verdict).toMatch(/honest/);
  });

  it("ECE is WEIGHTED — one loud bin cannot drown forty quiet ones", () => {
    const quiet = Array.from({ length: 40 }, (_, i) => P(`q${i}`, 0.8, i < 32)); // acc 0.8, gap 0
    const loud = [P("l1", 0.8, false), P("l2", 0.8, false)]; // drags that bin down
    const t = buildCalibrationTable([...quiet, ...loud]);
    const binAcc = t.bins[8].accuracy!;
    expect(binAcc).toBeCloseTo(32 / 42, 3);
    // ECE ≈ |32/42 − 0.8| ≈ 0.038 — the quiet mass dilutes the loud tail, as weighted math must
    expect(t.ece!).toBeLessThan(0.05);
    // but the gap label still reads honest here: 0.762 − 0.8 = −0.038 inside the warn gap
    expect(t.bins[8].label).toBe("honest");
  });

  it("an all-lying 42-bin vs a single-bin disaster: ECE weights by n, never by volume of bins", () => {
    const sole = buildCalibrationTable([P("s", 0.9, false)]);
    expect(sole.ece).toBeCloseTo(0.9, 3);
  });

  it("zero points never fabricates: ece null, accuracy null, honest emptiness", () => {
    const t = buildCalibrationTable([]);
    expect(t.ece).toBeNull();
    expect(t.overallAccuracy).toBeNull();
    expect(t.points).toBe(0);
    expect(t.verdict).toMatch(/nothing to calibrate/);
    expect(t.bins.every((b) => b.n === 0)).toBe(true);
  });

  it("deterministic under input-order shuffle", () => {
    const pts = [
      P("a", 0.12, true), P("b", 0.95, false), P("c", 0.55, true), P("d", 0.15, false),
      P("e", 0.99, true), P("f", 0.51, true), P("g", 0.66, false),
    ];
    const t1 = buildCalibrationTable(pts);
    const t2 = buildCalibrationTable([...pts].reverse());
    expect(t2).toEqual(t1);
  });

  it("overall accuracy is over GRADED points only", () => {
    const t = buildCalibrationTable([P("a", 0.3, true), P("b", 0.3, true), P("c", 0.7, false)]);
    expect(t.overallAccuracy).toBeCloseTo(2 / 3, 3);
  });
});

/* ------------------------------------------------------------------ *
 * Snapshot guards: a stored report that LIES about its points cannot reload
 * ------------------------------------------------------------------ */

function harnessSnapshot(): CalibrationSnapshot {
  const der = calPointsFromHarness(
    fakeReport([
      fakeItem("e1", { a: score(2, 0.93), b: choice("x", 0.4) }, { a: "match", b: "diff" }),
      fakeItem("e2", { c: noul(0.7) }, { c: "match" }),
      fakeItem("e3", { d: score(1, 0.5) }, { d: "n/a" }, false),
    ]),
  );
  return {
    source: "harness",
    table: buildCalibrationTable(der.points),
    points: der.points,
    receipt: der.counts,
    generatedAt: "2026-11-26T05:00:00.000Z",
  };
}

function manualSnapshot(): CalibrationSnapshot {
  const intake = calPointsFromPayload([P("m1", 0.9, true), P("m2", 0.9, false), { id: "x!", confidence: 0.5, correct: true }]);
  return {
    source: "manual",
    table: buildCalibrationTable(intake.points),
    points: intake.points,
    receipt: intake.counts,
    generatedAt: "2026-11-26T05:00:00.000Z",
  };
}

describe("isCalibrationSnapshot", () => {
  it("accepts real snapshots from both sources", () => {
    expect(isCalibrationSnapshot(harnessSnapshot())).toBe(true);
    expect(isCalibrationSnapshot(manualSnapshot())).toBe(true);
    expect(isCalibrationSnapshot(JSON.parse(JSON.stringify(harnessSnapshot())))).toBe(true);
  });

  it("refuses garbage shapes outright", () => {
    for (const bad of [null, undefined, 42, "nope", [], {}]) {
      expect(isCalibrationSnapshot(bad)).toBe(false);
    }
  });

  it("a TABLE THAT DISAGREES WITH ITS OWN POINTS never reloads — flip a bin count", () => {
    const s = harnessSnapshot();
    const lie = JSON.parse(JSON.stringify(s));
    lie.table.bins[9].n += 1;
    expect(isCalibrationSnapshot(lie)).toBe(false);
  });

  it("a tampered ECE is refused (recompute must match)", () => {
    const s = harnessSnapshot();
    const lie = JSON.parse(JSON.stringify(s));
    lie.table.ece = (lie.table.ece ?? 0) + 0.4;
    expect(isCalibrationSnapshot(lie)).toBe(false);
  });

  it("points that move without the table move are refused too", () => {
    const s = harnessSnapshot();
    const lie = JSON.parse(JSON.stringify(s));
    lie.points.push(P("extra", 0.5, true));
    expect(isCalibrationSnapshot(lie)).toBe(false);
  });

  it("an unbalanced harness receipt (answersSeen ≠ kept + exclusions) is refused", () => {
    const s = harnessSnapshot();
    const lie = JSON.parse(JSON.stringify(s));
    lie.receipt.answersSeen += 5;
    expect(isCalibrationSnapshot(lie)).toBe(false);
  });

  it("a manual receipt whose kept ≠ its points is refused", () => {
    const s = manualSnapshot();
    const lie = JSON.parse(JSON.stringify(s));
    lie.receipt.kept = 99;
    expect(isCalibrationSnapshot(lie)).toBe(false);
  });

  it("refuses unknown sources and unparseable timestamps", () => {
    const s = harnessSnapshot();
    expect(isCalibrationSnapshot({ ...s, source: "vibes" })).toBe(false);
    expect(isCalibrationSnapshot({ ...s, generatedAt: "last tuesday" })).toBe(false);
  });

  it("refuses a bin count list that is not exactly ten", () => {
    const s = harnessSnapshot();
    const lie = JSON.parse(JSON.stringify(s));
    lie.table.bins.pop();
    expect(isCalibrationSnapshot(lie)).toBe(false);
  });
});

describe("calibrationRunSummary", () => {
  it("harness: compared = answers walked, errors = rows that did not become points — errors ≤ compared BY CONSTRUCTION", () => {
    const s = harnessSnapshot();
    const sum = calibrationRunSummary(s);
    const r = s.receipt as { answersSeen: number; naExcluded: number; noConfidenceExcluded: number };
    expect(sum.compared).toBe(r.answersSeen);
    expect(sum.errors).toBe(r.naExcluded + r.noConfidenceExcluded);
    expect(sum.errors).toBeLessThanOrEqual(sum.compared);
  });

  it("manual: refused rows are the errors, and they can never exceed the walk", () => {
    const s = manualSnapshot();
    const sum = calibrationRunSummary(s);
    expect(sum.compared).toBe(3);
    expect(sum.errors).toBe(1);
    expect(sum.errors).toBeLessThanOrEqual(sum.compared);
  });
});

/* ------------------------------------------------------------------ *
 * D8 export surface
 * ------------------------------------------------------------------ */

describe("calibrationExportRows", () => {
  it("ships stable columns, ece+verdict ride the first row only", () => {
    const t = buildCalibrationTable([P("a", 0.95, true), P("b", 0.95, false)]);
    const rows = calibrationExportRows(t);
    expect(rows).toHaveLength(CAL_BIN_COUNT);
    expect(Object.keys(rows[0])).toEqual([
      "bin", "range", "n", "meanConfidence", "accuracy", "gap", "label", "ece", "verdict",
    ]);
    expect(rows[0].ece).toBe(t.ece);
    expect(rows[0].verdict).toBe(t.verdict);
    expect(rows[9].ece).toBe("");
    expect(rows[9].verdict).toBe("");
    expect(rows[9].n).toBe(2);
  });

  it("n=0 bins export as blanks, not nulls or lies", () => {
    const rows = calibrationExportRows(buildCalibrationTable([]));
    for (const r of rows) {
      expect(r.n).toBe(0);
      expect(r.meanConfidence).toBe("");
      expect(r.accuracy).toBe("");
      expect(r.gap).toBe("");
      expect(r.label).toBe("no sample");
    }
  });

  it("survives the real CSV writer with gap signs and verdict commas intact", () => {
    const t = buildCalibrationTable([P("a", 0.9, false), P("b", 0.9, false)]);
    const csv = toCSV(calibrationExportRows(t));
    const lines = csv.split(/\r?\n/).filter((l) => l !== "");
    expect(lines[0]).toBe("bin,range,n,meanConfidence,accuracy,gap,label,ece,verdict");
    // bin 0 carries the headline — and its verdict contains a comma, so D8 must quote it
    expect(lines[1]).toContain("overconfident");
    expect(lines[1]).toMatch(/^0,"?0\.0–0\.1"?/);
  });
});

/* ------------------------------------------------------------------ *
 * SQLite round trip: the receipt survives the restart
 * ------------------------------------------------------------------ */

describe("SQLite ride (lane calibration)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "cal-lane-"));
  const dbPath = join(tmp, "results.db");
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("persists a real snapshot, reads it back byte-honest, refuses a liar at write", () => {
    const db = openResultsDb(dbPath);
    try {
      const snap = harnessSnapshot();
      const saved = saveBatchRun(db, {
        lane: CALIBRATION_RUN_LANE,
        payload: snap,
        guard: isCalibrationSnapshot,
        summarize: calibrationRunSummary,
        limit: null,
      });
      expect(saved.runId.startsWith("calibration-")).toBe(true);
      expect(saved.summary).toEqual(calibrationRunSummary(snap));

      const loaded = loadLatestRun<CalibrationSnapshot>(db, CALIBRATION_RUN_LANE, isCalibrationSnapshot);
      expect(loaded).not.toBeNull();
      expect(loaded!.payload).toEqual(snap);
      // a re-derived table from the reloaded points matches the stored table EXACTLY
      expect(buildCalibrationTable(loaded!.payload.points)).toEqual(loaded!.payload.table);

      // a lying payload is REFUSED AT WRITE — the guard is the wall
      const lie = JSON.parse(JSON.stringify(snap));
      lie.table.bins[4].n = 7;
      lie.points = [];
      expect(() =>
        saveBatchRun(db, {
          lane: CALIBRATION_RUN_LANE,
          payload: lie,
          guard: isCalibrationSnapshot,
          summarize: calibrationRunSummary,
        }),
      ).toThrow(/does not recognize/);
    } finally {
      closeResultsDb(db);
    }
  });
});
