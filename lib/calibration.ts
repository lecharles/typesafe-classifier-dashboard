/**
 * Calibration view (11-26 row): confidence vs correctness, decided IN CODE.
 *
 * Every lane in this hub emits a confidence number. The only question a
 * confidence number is allowed to answer is "how often is it right?" —
 * this lane asks exactly that and prints the receipt.
 *
 * The reference truth is the D14 harness: the same state classified by
 * Jev AND the emulated gateway. AGREEMENT-AS-CORRECTNESS is a label, not
 * a lie: a diff is a miss against the reference, a match is a hit, and
 * n/a (a dead side) is EXCLUDED-AND-COUNTED — never scored either way.
 * The manual lane accepts raw (confidence, correct) pairs with the same
 * guard discipline the upload intake uses: refused rows ride the receipt.
 *
 * House rules this module never breaks:
 *  - THE TABLE NEVER TRUSTS A PAYLOAD — every point walks the shape
 *    guard; junk is rejected with its row number, and the receipt
 *    balances: seen = kept + rejected (and, on the harness path,
 *    seenAnswers = points + excluded).
 *  - BINS ARE FIXED BY CODE — ten 0.1-wide bins, [0,0.1) … [0.9,1.0];
 *    the top bin is CLOSED at 1.0 because a perfect confidence is legal.
 *  - EMPTY BINS ARE SHOWN, NOT SKIPPED — n=0 is information ("you said
 *    0.65 exactly zero times").
 *  - ECE IS WEIGHTED — Σ (n_b/N)·|acc_b − conf_b|. One loud bin cannot
 *    drown forty quiet ones, and a bin with no sample contributes 0,
 *    never NaN.
 *  - EXPORT RIDES D8 — stable column order, 3dp numbers.
 */

import type { ExportRow } from "@/lib/export";
import type { HarnessReport } from "@/lib/harness";

/* ------------------------------------------------------------------ *
 * Points: the atom of calibration — a confidence and whether it was right.
 * ------------------------------------------------------------------ */

export type CalPoint = {
  id: string;
  /** the classifier's stated confidence, 0..1 */
  confidence: number;
  /** did it agree with the reference (harness) / was it labeled correct (manual)? */
  correct: boolean;
};

export type CalReject = {
  row: number;
  reason: string;
  preview: string;
};

export type CalIntake = {
  points: CalPoint[];
  rejected: CalReject[];
  counts: { seen: number; kept: number; rejected: number };
};

/** A confidence is only believed when it is a REAL number inside [0,1]. */
function isBelievableConfidence(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;
}

/**
 * Manual lane: (confidence, correct) pairs in, guarded points out.
 * THE GUARD NEVER RESCUES: a stringy confidence, an out-of-range one,
 * a non-boolean correct — all refused with row numbers, all counted.
 */
export function calPointsFromPayload(raw: unknown): CalIntake {
  const points: CalPoint[] = [];
  const rejected: CalReject[] = [];
  if (!Array.isArray(raw)) {
    return {
      points,
      rejected: [{ row: 0, reason: "payload must be an array of {id, confidence, correct}", preview: String(typeof raw) }],
      counts: { seen: 0, kept: 0, rejected: 1 },
    };
  }
  raw.forEach((entry, i) => {
    const preview = (() => {
      try {
        return (typeof entry === "string" ? entry : JSON.stringify(entry) ?? String(entry)).replace(/\s+/g, " ").slice(0, 60);
      } catch {
        return "[unserializable row]";
      }
    })();
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      rejected.push({ row: i + 1, reason: "row is not an object", preview });
      return;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || !/^[A-Za-z0-9._-]{1,120}$/.test(e.id)) {
      rejected.push({ row: i + 1, reason: "id must be ≤120 chars of [A-Za-z0-9._-]", preview });
      return;
    }
    if (!isBelievableConfidence(e.confidence)) {
      rejected.push({ row: i + 1, reason: "confidence must be a finite number in [0,1]", preview });
      return;
    }
    if (typeof e.correct !== "boolean") {
      rejected.push({ row: i + 1, reason: "correct must be a boolean", preview });
      return;
    }
    points.push({ id: e.id, confidence: e.confidence, correct: e.correct });
  });
  return {
    points,
    rejected,
    counts: { seen: raw.length, kept: points.length, rejected: rejected.length },
  };
}

/* ------------------------------------------------------------------ *
 * Harness lane: derive points from a D14 report. Reference = agreement.
 * ------------------------------------------------------------------ */

export type HarnessDerivation = {
  points: CalPoint[];
  counts: {
    /** jev answers looked at (across every item and question) */
    answersSeen: number;
    /** answers that became points */
    kept: number;
    /** agreement was n/a — a dead side never gets graded either way */
    naExcluded: number;
    /** answer carries no confidence field (noul) — nothing to calibrate */
    noConfidenceExcluded: number;
    /** items where the jev side itself failed */
    erroredItems: number;
  };
};

/**
 * Walk the harness report CODE-SIDE: every Jev answer that carries a
 * confidence AND a decidable agreement (match/diff) becomes a point.
 * n/a agreements and noul answers (no confidence) are EXCLUDED AND
 * COUNTED — the receipt shows what the numbers never saw.
 */
export function calPointsFromHarness(report: HarnessReport): HarnessDerivation {
  const points: CalPoint[] = [];
  let answersSeen = 0;
  let naExcluded = 0;
  let noConfidenceExcluded = 0;
  let erroredItems = 0;

  for (const item of report.items) {
    if (!item.jev.ok || !item.jev.answers) {
      erroredItems += 1;
      continue;
    }
    for (const [qid, ans] of Object.entries(item.jev.answers)) {
      answersSeen += 1;
      const conf = (ans as { confidence?: unknown }).confidence;
      if (typeof conf !== "number" || !Number.isFinite(conf) || conf < 0 || conf > 1) {
        // noul answers (and any confidence-less shape) — no number to calibrate
        noConfidenceExcluded += 1;
        continue;
      }
      const ag = item.agreement[qid];
      if (ag === "n/a" || ag === undefined) {
        naExcluded += 1;
        continue;
      }
      points.push({
        id: `${item.id}::${qid}`,
        confidence: conf,
        correct: ag === "match",
      });
    }
  }
  return {
    points,
    counts: {
      answersSeen,
      kept: points.length,
      naExcluded,
      noConfidenceExcluded,
      erroredItems,
    },
  };
}

/* ------------------------------------------------------------------ *
 * The table: ten fixed bins, accuracy vs stated confidence.
 * ------------------------------------------------------------------ */

export const CAL_BIN_COUNT = 10;
/** gap past which a bin earns a loud label instead of a shrug */
export const CAL_GAP_WARN = 0.15;

export type CalBinLabel = "no sample" | "honest" | "overconfident" | "underconfident";

export type CalBin = {
  /** 0..9 */
  bin: number;
  /** human range, e.g. "0.5–0.6" (top bin "0.9–1.0") */
  range: string;
  n: number;
  /** mean stated confidence in the bin (null when n=0) */
  meanConf: number | null;
  /** share correct in the bin (null when n=0) */
  accuracy: number | null;
  /** accuracy − meanConf (null when n=0): NEGATIVE = overconfident */
  gap: number | null;
  label: CalBinLabel;
};

export type CalibrationTable = {
  bins: CalBin[];
  ece: number | null;
  points: number;
  /** overall accuracy over the graded points (null when nothing graded) */
  overallAccuracy: number | null;
  verdict: string;
};

export function calBinIndex(confidence: number): number {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error(`calibration: confidence out of range: ${String(confidence)}`);
  }
  // top edge rides bin 9: [0.9, 1.0] is CLOSED — a perfect 1.0 is legal.
  return Math.min(CAL_BIN_COUNT - 1, Math.floor(confidence * CAL_BIN_COUNT));
}

function binRangeLabel(bin: number): string {
  const lo = (bin / CAL_BIN_COUNT).toFixed(1);
  const hi = ((bin + 1) / CAL_BIN_COUNT).toFixed(1);
  return `${lo}–${hi}`;
}

const round3 = (n: number) => Number(n.toFixed(3));

function labelForGap(gap: number): CalBinLabel {
  if (gap > CAL_GAP_WARN) return "underconfident";
  if (gap < -CAL_GAP_WARN) return "overconfident";
  return "honest";
}

/**
 * The table. Pure, deterministic, order-free: shuffling the points
 * cannot move a number. Empty bins stay visible with n=0.
 */
export function buildCalibrationTable(points: CalPoint[]): CalibrationTable {
  type Acc = { n: number; confSum: number; correct: number };
  const accs: Acc[] = Array.from({ length: CAL_BIN_COUNT }, () => ({ n: 0, confSum: 0, correct: 0 }));
  for (const p of points) {
    const b = accs[calBinIndex(p.confidence)];
    b.n += 1;
    b.confSum += p.confidence;
    if (p.correct) b.correct += 1;
  }

  const bins: CalBin[] = accs.map((a, i) => {
    if (a.n === 0) {
      return { bin: i, range: binRangeLabel(i), n: 0, meanConf: null, accuracy: null, gap: null, label: "no sample" };
    }
    const meanConf = a.confSum / a.n;
    const accuracy = a.correct / a.n;
    const gap = accuracy - meanConf;
    return {
      bin: i,
      range: binRangeLabel(i),
      n: a.n,
      meanConf: round3(meanConf),
      accuracy: round3(accuracy),
      gap: round3(gap),
      label: labelForGap(gap),
    };
  });

  const n = points.length;
  const ece =
    n === 0
      ? null
      : round3(
          accs.reduce((sum, a) => (a.n === 0 ? sum : sum + (a.n / n) * Math.abs(a.correct / a.n - a.confSum / a.n)), 0),
        );
  const overallAccuracy = n === 0 ? null : round3(points.filter((p) => p.correct).length / n);

  const loud = bins.filter((b) => b.n > 0 && b.label !== "honest");
  const over = loud.filter((b) => b.label === "overconfident").length;
  const under = loud.filter((b) => b.label === "underconfident").length;
  let verdict: string;
  if (n === 0) verdict = "nothing to calibrate — no graded points";
  else if (ece === null) verdict = "nothing to calibrate";
  else if (loud.length === 0) verdict = "honest: no bin misstates itself by more than the warn gap";
  else if (over > under) verdict = `overconfident: ${over} bin(s) state more certainty than they earn`;
  else if (under > over) verdict = `underconfident: ${under} bin(s) undersell themselves`;
  else verdict = `mixed drift: ${over} over- and ${under} under-confident bin(s)`;

  return { bins, ece, points: n, overallAccuracy, verdict };
}

/* ------------------------------------------------------------------ *
 * Persisted snapshot: the store NEVER TRUSTS A PAYLOAD.
 * ------------------------------------------------------------------ */

export type CalibrationSnapshot = {
  source: "harness" | "manual";
  /** the table as the code computed it */
  table: CalibrationTable;
  /** the points behind the table (bounded by the same intake caps) */
  points: CalPoint[];
  /** intake receipt, so the damage is on the record */
  receipt: { seen: number; kept: number; rejected: number } | HarnessDerivation["counts"];
  generatedAt: string;
};

export const CALIBRATION_RUN_LANE = "calibration";

function isCalPoint(x: unknown): x is CalPoint {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const p = x as Record<string, unknown>;
  return (
    typeof p.id === "string" &&
    p.id.length > 0 &&
    isBelievableConfidence(p.confidence) &&
    typeof p.correct === "boolean"
  );
}

function isCalBin(x: unknown): x is CalBin {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const b = x as Record<string, unknown>;
  if (typeof b.bin !== "number" || !Number.isInteger(b.bin) || b.bin < 0 || b.bin >= CAL_BIN_COUNT) return false;
  if (typeof b.range !== "string" || typeof b.n !== "number" || !Number.isInteger(b.n) || b.n < 0) return false;
  for (const k of ["meanConf", "accuracy", "gap"] as const) {
    const v = b[k];
    if (v !== null && !(typeof v === "number" && Number.isFinite(v))) return false;
  }
  return ["no sample", "honest", "overconfident", "underconfident"].includes(String(b.label));
}

/**
 * Shape AND self-consistency: a stored snapshot that disagrees with
 * its own points is structurally impossible to reload. The bin counts
 * must sum to the point count, ECE must match a recompute (tolerant to
 * the 3dp rounding the table itself carries), and every point must
 * pass the confidence guard.
 */
export function isCalibrationSnapshot(payload: unknown): payload is CalibrationSnapshot {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const p = payload as Record<string, unknown>;
  if (p.source !== "harness" && p.source !== "manual") return false;
  if (typeof p.generatedAt !== "string" || !Number.isInteger(Date.parse(p.generatedAt))) return false;
  if (!Array.isArray(p.points) || !p.points.every(isCalPoint)) return false;
  const points = p.points as CalPoint[];

  const t = p.table as Record<string, unknown> | undefined;
  if (!t || !Array.isArray(t.bins) || t.bins.length !== CAL_BIN_COUNT || !t.bins.every(isCalBin)) return false;
  const bins = t.bins as CalBin[];

  // the table must describe THESE points, not a nicer fiction
  const seenByBins = bins.reduce((s, b) => s + b.n, 0);
  if (seenByBins !== points.length) return false;
  const recount = buildCalibrationTable(points);
  for (let i = 0; i < CAL_BIN_COUNT; i++) {
    const a = bins[i];
    const r = recount.bins[i];
    if (a.n !== r.n) return false;
    if (a.meanConf !== r.meanConf || a.accuracy !== r.accuracy || a.gap !== r.gap) return false;
    if (a.label !== r.label) return false;
  }
  if (t.points !== points.length) return false;
  if (t.ece !== recount.ece || t.overallAccuracy !== recount.overallAccuracy) return false;
  if (typeof t.verdict !== "string") return false;

  const rec = p.receipt as Record<string, unknown> | undefined;
  if (!rec) return false;
  if (p.source === "manual") {
    return (
      typeof rec.seen === "number" &&
      typeof rec.kept === "number" &&
      typeof rec.rejected === "number" &&
      rec.kept === points.length
    );
  }
  const ok =
    typeof rec.answersSeen === "number" &&
    typeof rec.naExcluded === "number" &&
    typeof rec.noConfidenceExcluded === "number" &&
    typeof rec.erroredItems === "number";
  if (!ok) return false;
  // the harness receipt must account for every answer it looked at
  return (
    (rec.answersSeen as number) ===
    (points.length as number) + (rec.naExcluded as number) + (rec.noConfidenceExcluded as number)
  );
}

/**
 * Recompute the store summary FROM THE ITEMS — never accept one.
 * The lane's inversion-safe reading of the two columns:
 *  - compared = rows the intake ANSWERED for (harness: answers walked;
 *    manual: rows seen, rejected included — the walk happened)
 *  - errors   = rows that did NOT become points (excluded/refused).
 * answersSeen === kept + naExcluded + noConfidenceExcluded is asserted
 * by the guard, so errors ≤ compared is STRUCTURAL — a stored summary
 * that inverts them cannot exist. (errored ITEMS ride the receipt;
 * they are items, not answer-rows, and counting them in both would be
 * double-debt.)
 */
export function calibrationRunSummary(payload: unknown): { compared: number; errors: number } {
  const p = payload as CalibrationSnapshot;
  if (p.source === "manual") {
    const r = p.receipt as { seen: number; kept: number; rejected: number };
    return { compared: r.seen, errors: r.rejected };
  }
  const r = p.receipt as HarnessDerivation["counts"];
  return { compared: r.answersSeen, errors: r.naExcluded + r.noConfidenceExcluded };
}

/* ------------------------------------------------------------------ *
 * D8 export surface — stable columns.
 * ------------------------------------------------------------------ */

export function calibrationExportRows(table: CalibrationTable): ExportRow[] {
  return table.bins.map((b) => ({
    bin: b.bin,
    range: b.range,
    n: b.n,
    meanConfidence: b.meanConf ?? "",
    accuracy: b.accuracy ?? "",
    gap: b.gap ?? "",
    label: b.label,
    ece: b.bin === 0 ? table.ece ?? "" : "",
    verdict: b.bin === 0 ? table.verdict : "",
  }));
}
