import { NextResponse } from "next/server";
import { z } from "zod";
import {
  CALIBRATION_RUN_LANE,
  buildCalibrationTable,
  calPointsFromHarness,
  calPointsFromPayload,
  calibrationRunSummary,
  isCalibrationSnapshot,
  type CalibrationSnapshot,
  type HarnessDerivation,
} from "@/lib/calibration";
import type { HarnessReport } from "@/lib/harness";
import {
  sharedResultsDb,
  saveBatchRun,
  loadLatestRun,
  listRecentRuns,
  countRuns,
} from "@/lib/sqlite";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Calibration view (11-26 row): confidence vs correctness, the table
 * decided IN CODE.
 *
 * POST { kind: "harness", report } — derive points from a D14 harness
 * report (agreement-as-correctness, honestly labeled), build the ten-bin
 * table + ECE, persist the snapshot to SQLite lane "calibration".
 *
 * POST { kind: "manual", points } — raw (confidence, correct) pairs
 * through the intake guard: refused rows ride the receipt, and the
 * receipt balances by construction.
 *
 * GET — newest persisted snapshot + slim history + honest
 * { total, readable } counts (the UC#10-persist contract).
 */
const harnessBody = z.object({
  kind: z.literal("harness"),
  report: z
    .object({
      items: z.array(z.unknown()).min(0).max(200),
      totals: z.unknown(),
      ladder: z.unknown(),
      generatedAt: z.string(),
    })
    .passthrough(),
});

const manualBody = z.object({
  kind: z.literal("manual"),
  points: z.array(z.unknown()).min(1).max(200),
});

const body = z.discriminatedUnion("kind", [harnessBody, manualBody]);

export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }

  let snapshot: CalibrationSnapshot;
  let excludedNote: string | null = null;
  if (parsed.data.kind === "harness") {
    // Re-walk the report through its own comparison discipline: the
    // derivation reads items[].jev.answers + items[].agreement, so a
    // garbage report simply yields ZERO points — it cannot fake a table.
    const der = calPointsFromHarness(parsed.data.report as unknown as HarnessReport);
    snapshot = {
      source: "harness",
      table: buildCalibrationTable(der.points),
      points: der.points,
      receipt: der.counts,
      generatedAt: new Date().toISOString(),
    };
    if (der.points.length === 0) {
      excludedNote =
        der.counts.erroredItems > 0 || der.counts.answersSeen === 0
          ? "no comparable answers in this report — run the harness first (a dead side is excluded, never guessed at)"
          : "every answer was excluded (n/a or no confidence) — nothing to calibrate";
    }
  } else {
    const intake = calPointsFromPayload(parsed.data.points);
    snapshot = {
      source: "manual",
      table: buildCalibrationTable(intake.points),
      points: intake.points,
      receipt: intake.counts,
      generatedAt: new Date().toISOString(),
    };
    if (intake.rejected.length > 0) {
      excludedNote = `${intake.rejected.length} row(s) refused by the guard — see rejected`;
    }
  }

  let persisted: { runId: string; savedAt: string; limit: number | null } | null = null;
  let persistError: string | null = null;
  try {
    const db = sharedResultsDb();
    const saved = saveBatchRun(db, {
      lane: CALIBRATION_RUN_LANE,
      payload: snapshot,
      guard: isCalibrationSnapshot,
      summarize: calibrationRunSummary,
      limit: null,
    });
    persisted = { runId: saved.runId, savedAt: saved.savedAt, limit: saved.limit };
  } catch (err) {
    // the table was computed; the persistence miss rides the response visibly
    persistError = err instanceof Error ? err.message : "results store failed";
  }

  return NextResponse.json({
    ...snapshot,
    excludedNote,
    persisted,
    persistError,
    ...(parsed.data.kind === "manual"
      ? { rejected: calPointsFromPayload(parsed.data.points).rejected }
      : {}),
  });
}

/** The store's memory outlives the process — newest VALID snapshot. */
export async function GET() {
  try {
    const db = sharedResultsDb();
    const run = loadLatestRun<CalibrationSnapshot>(db, CALIBRATION_RUN_LANE, isCalibrationSnapshot);
    const recent = listRecentRuns<CalibrationSnapshot>(
      db,
      CALIBRATION_RUN_LANE,
      isCalibrationSnapshot,
      5,
    ).map((r) => ({
      runId: r.runId,
      savedAt: r.savedAt,
      limit: r.limit,
      summary: r.summary,
    }));
    const counts = countRuns(db, CALIBRATION_RUN_LANE, isCalibrationSnapshot);
    return NextResponse.json({ run, recent, counts });
  } catch (err) {
    const message = err instanceof Error ? err.message : "results store read failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
