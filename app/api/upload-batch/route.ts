import { NextResponse } from "next/server";
import { z } from "zod";
import {
  MAX_ITEMS,
  MAX_TEXT,
  MAX_ID,
  MAX_LABEL,
  UPLOAD_ORIGINS,
  runUploadBatch,
  isUploadBatchReport,
  uploadRunSummary,
  UPLOAD_RUN_LANE,
  type UploadBatchReport,
} from "@/lib/upload";
import { normalizeGates } from "@/lib/bs";
import { BATCH_LADDER } from "@/lib/dispatch";
import { GatewayError } from "@/lib/gateway";
import { JevError } from "@/lib/jev";
import {
  sharedResultsDb,
  saveBatchRun,
  loadLatestRun,
  listRecentRuns,
  countRuns,
} from "@/lib/sqlite";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Screening lane of the real-corpora upload (11-25 row): an intake
 * corpus walks the UC#7 BS ladder — clean / suspicious / bs decided IN
 * CODE per row, batch discipline 5 → 10 → All with per-row error
 * isolation, non-rung limits refused server-side.
 *
 * Every finished report is persisted through the UC#10-persist SQLite
 * store (lane "upload"): a screen of YOUR data survives a restart, and
 * the store refuses payloads its shape guard doesn't recognize.
 */
const gatesSchema = z
  .object({
    bsAt: z.number().min(0).max(10).optional(),
    cleanAt: z.number().min(0).max(10).optional(),
    maliceBlockAt: z.number().min(0).max(1).optional(),
    payoffFloor: z.number().min(0).max(1).optional(),
    lowConfBump: z.number().min(0).max(1).optional(),
  })
  .optional();

const body = z
  .object({
    items: z
      .array(
        z.object({
          id: z.string().min(1).max(MAX_ID),
          text: z.string().min(1).max(MAX_TEXT),
          label: z.string().max(MAX_LABEL).optional(),
          origin: z.enum(UPLOAD_ORIGINS).optional(),
        }),
      )
      .min(1)
      .max(MAX_ITEMS),
    limit: z.number().int().min(1).nullable().optional(),
    gates: gatesSchema,
    dev: z.boolean().optional(),
  })
  .refine(
    (b) =>
      b.limit === undefined ||
      b.limit === null ||
      (BATCH_LADDER as readonly number[]).includes(b.limit) ||
      b.limit >= b.items.length,
    { message: "limit must be a batch ladder rung (5, 10) or All" },
  );

/** The ladder rung a run actually walked: null once it covers the whole corpus. */
function effectiveRung(limit: number | null | undefined, corpusLen: number): number | null {
  if (limit === null) return null;
  const l = limit ?? BATCH_LADDER[0];
  return l >= corpusLen ? null : l;
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
  try {
    const report = await runUploadBatch(parsed.data.items, {
      limit: parsed.data.limit,
      gates: normalizeGates(parsed.data.gates),
      trace: parsed.data.dev,
    });
    const persistedVia = effectiveRung(parsed.data.limit, parsed.data.items.length);

    let persisted: { runId: string; savedAt: string; limit: number | null } | null = null;
    let persistError: string | null = null;
    try {
      const db = sharedResultsDb();
      const saved = saveBatchRun(db, {
        lane: UPLOAD_RUN_LANE,
        payload: report,
        guard: isUploadBatchReport,
        summarize: uploadRunSummary,
        limit: persistedVia,
      });
      persisted = { runId: saved.runId, savedAt: saved.savedAt, limit: saved.limit };
    } catch (err) {
      // the run happened; the persistence miss rides the response visibly
      persistError = err instanceof Error ? err.message : "results store failed";
    }
    return NextResponse.json({ ...report, persisted, persistError });
  } catch (err) {
    const status =
      err instanceof GatewayError || err instanceof JevError ? 502 : 500;
    const message = err instanceof Error ? err.message : "upload screen batch failed";
    return NextResponse.json({ error: message }, { status });
  }
}

/**
 * GET (UC#10-persist ride): the store's memory outlives the process —
 * newest VALID upload screen, slim history, honest { total, readable }
 * counts. A corrupt row shows up as the gap, never as a quiet
 * disappearance.
 */
export async function GET() {
  try {
    const db = sharedResultsDb();
    const run = loadLatestRun<UploadBatchReport>(db, UPLOAD_RUN_LANE, isUploadBatchReport);
    const recent = listRecentRuns<UploadBatchReport>(db, UPLOAD_RUN_LANE, isUploadBatchReport, 5).map(
      (r) => ({
        runId: r.runId,
        savedAt: r.savedAt,
        limit: r.limit,
        summary: r.summary,
      }),
    );
    const counts = countRuns(db, UPLOAD_RUN_LANE, isUploadBatchReport);
    return NextResponse.json({ run, recent, counts });
  } catch (err) {
    const message = err instanceof Error ? err.message : "results store read failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
