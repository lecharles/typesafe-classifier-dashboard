import { NextResponse } from "next/server";
import { z } from "zod";
import {
  buildEntityCorpus,
  runEntityBatch,
  normalizeGates,
  isEntityBatchReport,
  entityRunSummary,
  ENTITY_RUN_LANE,
  type EntityBatchReport,
} from "@/lib/entities";
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

const recordSchema = z.object({
  id: z.string().min(1).max(32),
  name: z.string().min(1).max(160),
  brand: z.string().max(80).optional(),
  model: z.string().max(80).optional(),
  detail: z.string().max(160).optional(),
});

const gatesSchema = z
  .object({
    mergeAt: z.number().min(0).max(4).optional(),
    distinctAt: z.number().min(0).max(4).optional(),
    conflictFloor: z.number().min(0).max(1).optional(),
    collisionCap: z.number().min(0).max(1).optional(),
    lowConfBump: z.number().min(0).max(1).optional(),
  })
  .optional();

/**
 * UC#10 (11-23 calendar row, shipped 11-22 one day ahead): batched
 * entity alignment walking the lane's ladder over the 25-pair market
 * audit: 5 → 10 → All. The client may send explicit pairs
 * (dev/dogfood) or ask for the bundled audit. Non-rung limits are
 * refused server-side. Verdicts stay IN CODE per pair; a failure on
 * one pair is isolated to its report and never aborts the batch.
 * distinct / review / merge tallies + the contradiction-safe cluster
 * fold (merge edges union, a chain never overrules a called
 * separation, refused joins are LOGGED) ride in the report.
 *
 * UC#10-persist (11-24 row, the SQLite spike): every finished report
 * is persisted server-side through lib/sqlite so a run SURVIVES A
 * RESTART — the client re-reads the latest via GET on page load. The
 * store refuses payloads its lane guard doesn't recognize, recomputes
 * the summary in code, and a persistence failure rides the response
 * visibly as `persistError` — the batch itself stays valid, the miss
 * never goes silent.
 */
const body = z
  .object({
    items: z
      .array(
        z.object({
          id: z.string().min(1),
          a: recordSchema,
          b: recordSchema,
        }),
      )
      .min(1)
      .max(200)
      .optional(),
    limit: z.number().int().min(1).nullable().optional(),
    gates: gatesSchema,
  })
  .refine(
    (b) =>
      b.limit === undefined ||
      b.limit === null ||
      (BATCH_LADDER as readonly number[]).includes(b.limit) ||
      (b.items !== undefined && b.limit >= b.items.length),
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
    const corpus =
      parsed.data.items ?? buildEntityCorpus().map((c) => ({ id: c.id, a: c.a, b: c.b }));
    const report = await runEntityBatch(corpus, {
      limit: parsed.data.limit,
      gates: normalizeGates(parsed.data.gates),
    });
    const persistedVia = effectiveRung(parsed.data.limit, corpus.length);

    let persisted: { runId: string; savedAt: string; limit: number | null } | null = null;
    let persistError: string | null = null;
    try {
      const db = sharedResultsDb();
      const saved = saveBatchRun(db, {
        lane: ENTITY_RUN_LANE,
        payload: report,
        guard: isEntityBatchReport,
        summarize: entityRunSummary,
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
    const message = err instanceof Error ? err.message : "entity batch failed";
    return NextResponse.json({ error: message }, { status });
  }
}

/**
 * UC#10-persist GET: the store's memory outlives the process. Returns
 * the newest VALID persisted run (full payload, so the page can
 * restore it after a restart), slim summaries of the recent history,
 * and the honest { total, readable } counts — corrupt rows show up as
 * the gap, never as a quiet disappearance.
 */
export async function GET() {
  try {
    const db = sharedResultsDb();
    const run = loadLatestRun<EntityBatchReport>(db, ENTITY_RUN_LANE, isEntityBatchReport);
    const recent = listRecentRuns<EntityBatchReport>(db, ENTITY_RUN_LANE, isEntityBatchReport, 5).map(
      (r) => ({
        runId: r.runId,
        savedAt: r.savedAt,
        limit: r.limit,
        summary: r.summary,
      }),
    );
    const counts = countRuns(db, ENTITY_RUN_LANE, isEntityBatchReport);
    return NextResponse.json({ run, recent, counts });
  } catch (err) {
    const message = err instanceof Error ? err.message : "results store read failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
