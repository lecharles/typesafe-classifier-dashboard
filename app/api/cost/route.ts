import { NextResponse } from "next/server";
import { z } from "zod";
import {
  COST_RUN_LANE,
  DEFAULT_BUDGET_USD,
  buildCostLedger,
  costReceiptsFromHarness,
  costReceiptsFromPayload,
  costReceiptsFromStoreRows,
  costRunSummary,
  isCostSnapshot,
  normalizeRates,
  type CostLedger,
  type CostReceipt,
  type CostSnapshot,
  type CostSource,
  type StoreRowWire,
} from "@/lib/cost";
import type { HarnessReport } from "@/lib/harness";
import {
  laneSummaries,
  sharedResultsDb,
  saveBatchRun,
  scanAllRuns,
  loadLatestRun,
  listRecentRuns,
  countRuns,
} from "@/lib/sqlite";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Cost/token dashboard (11-27 row): Jev $/Mtok tracking, priced IN CODE.
 *
 * POST { kind: "harness", report, rates?, budgetUsd? } — price a D14
 * harness report: two receipts (jev + gateway), a dead side skipped and
 * counted. No new model calls are invented here — the harness is the
 * meter.
 *
 * POST { kind: "store", rates?, budgetUsd?, cap? } — read the SQLite
 * store across EVERY lane and price the runs that carry usage receipts
 * (entities, upload). Calibration-style lanes are skipped-and-counted;
 * corrupt rows are refused-and-counted. A day's spend survives the
 * restart because it lives on disk.
 *
 * POST { kind: "manual", rows, rates?, budgetUsd? } — bring your own
 * receipts through the never-trusts-a-payload intake; refused rows ride
 * the receipt with row numbers.
 *
 * Every snapshot persists to SQLite lane "cost" BEHIND the self-
 * consistency guard: the stored ledger must equal a full recompute from
 * its own receipts + rates, so a report that lies about its own spend
 * never reloads.
 *
 * GET — newest snapshot + slim history + { total, readable } counts +
 * the honest lane summaries of what is on disk.
 */

const ratesField = z.unknown().optional();
const budgetField = z
  .number()
  .finite()
  .positive()
  .max(1_000_000)
  .nullable()
  .optional();

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
  rates: ratesField,
  budgetUsd: budgetField,
});

const storeBody = z.object({
  kind: z.literal("store"),
  rates: ratesField,
  budgetUsd: budgetField,
  cap: z.number().int().min(1).max(200).optional(),
});

const manualBody = z.object({
  kind: z.literal("manual"),
  rows: z.array(z.unknown()).min(1).max(200),
  rates: ratesField,
  budgetUsd: budgetField,
});

const body = z.discriminatedUnion("kind", [harnessBody, storeBody, manualBody]);

/** budgetUsd is an INPUT knob: absent → the default watch budget; null → unset. */
function resolveBudget(raw: number | null | undefined): number | null {
  if (raw === null) return null;
  if (raw === undefined) return DEFAULT_BUDGET_USD;
  return raw;
}

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

  let rates: ReturnType<typeof normalizeRates>;
  try {
    rates = normalizeRates((parsed.data as { rates?: unknown }).rates);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "rates refused" },
      { status: 400 },
    );
  }
  const budgetUsd = resolveBudget((parsed.data as { budgetUsd?: number | null }).budgetUsd);

  let sourceKind: CostSource = parsed.data.kind;
  let receipts: CostReceipt[];
  let counts: CostSnapshot["counts"];
  let note: string | null = null;
  let rejectedRows: { row: number; reason: string; preview: string }[] | null = null;

  if (parsed.data.kind === "harness") {
    // Re-walk the report through its own discipline: a garbage report
    // simply yields zero receipts — it cannot fake a ledger.
    const der = costReceiptsFromHarness(parsed.data.report as unknown as HarnessReport);
    receipts = der.receipts;
    counts = { seen: 2, kept: der.receipts.length, rejected: 0, skipped: der.counts.sidesSkipped };
    if (der.receipts.length === 0) {
      note = "neither side of this harness report answered anything — nothing to price (a dead backend books no spend)";
    } else if (der.counts.sidesSkipped > 0) {
      note = `${der.counts.sidesSkipped} side(s) had zero live items — skipped and counted, never booked`;
    }
  } else if (parsed.data.kind === "store") {
    sourceKind = "store";
    const db = sharedResultsDb();
    const rows: StoreRowWire[] = scanAllRuns(db, parsed.data.cap ?? 100);
    const der = costReceiptsFromStoreRows(rows);
    receipts = der.receipts;
    counts = { seen: der.counts.seen, kept: der.counts.kept, rejected: der.counts.rejected, skipped: der.counts.skippedNoUsage };
    if (der.receipts.length === 0) {
      note = "no usage receipts on disk yet — run a batch lane (entities/upload) first";
    } else if (der.counts.skippedNoUsage > 0 || der.counts.rejected > 0) {
      note = `${der.counts.kept} priced · ${der.counts.skippedNoUsage} lane rows carry no usage contract (skipped-and-counted) · ${der.counts.rejected} corrupt/refused`;
    }
  } else {
    const intake = costReceiptsFromPayload(parsed.data.rows);
    receipts = intake.receipts;
    counts = { seen: intake.counts.seen, kept: intake.counts.kept, rejected: intake.counts.rejected, skipped: 0 };
    rejectedRows = intake.rejected;
    if (intake.rejected.length > 0) {
      note = `${intake.rejected.length} row(s) refused by the guard — see rejected`;
    }
  }

  let ledger: CostLedger;
  try {
    ledger = buildCostLedger(receipts, rates, budgetUsd);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "ledger build failed" },
      { status: 400 },
    );
  }

  const snapshot: CostSnapshot = {
    sourceKind,
    receipts,
    rates,
    ledger,
    counts,
    generatedAt: new Date().toISOString(),
  };

  let persisted: { runId: string; savedAt: string; limit: number | null } | null = null;
  let persistError: string | null = null;
  try {
    const db = sharedResultsDb();
    const saved = saveBatchRun(db, {
      lane: COST_RUN_LANE,
      payload: snapshot,
      guard: isCostSnapshot,
      summarize: costRunSummary,
      limit: null,
    });
    persisted = { runId: saved.runId, savedAt: saved.savedAt, limit: saved.limit };
  } catch (err) {
    // the ledger was computed; the persistence miss rides the response visibly
    persistError = err instanceof Error ? err.message : "results store failed";
  }

  return NextResponse.json({
    ...snapshot,
    note,
    rejected: rejectedRows ?? undefined,
    persisted,
    persistError,
  });
}

/** The store's memory outlives the process — newest VALID cost snapshot. */
export async function GET() {
  try {
    const db = sharedResultsDb();
    const run = loadLatestRun<CostSnapshot>(db, COST_RUN_LANE, isCostSnapshot);
    const recent = listRecentRuns<CostSnapshot>(db, COST_RUN_LANE, isCostSnapshot, 5).map((r) => ({
      runId: r.runId,
      savedAt: r.savedAt,
      limit: r.limit,
      summary: r.summary,
    }));
    const counts = countRuns(db, COST_RUN_LANE, isCostSnapshot);
    const store = laneSummaries(db);
    return NextResponse.json({ run, recent, counts, store });
  } catch (err) {
    const message = err instanceof Error ? err.message : "results store read failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
