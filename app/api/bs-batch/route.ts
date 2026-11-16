import { NextResponse } from "next/server";
import { z } from "zod";
import { runBsBatch, buildBsCorpus, normalizeGates, BS_SOURCES } from "@/lib/bs";
import { BATCH_LADDER } from "@/lib/dispatch";
import { GatewayError } from "@/lib/gateway";
import { JevError } from "@/lib/jev";

export const runtime = "nodejs";
export const maxDuration = 300;

const gatesSchema = z
  .object({
    bsAt: z.number().min(0).max(10).optional(),
    cleanAt: z.number().min(0).max(10).optional(),
    maliceBlockAt: z.number().min(0).max(1).optional(),
    payoffFloor: z.number().min(0).max(1).optional(),
    lowConfBump: z.number().min(0).max(1).optional(),
  })
  .optional();

/**
 * UC#7 (11-17 calendar row, shipped 11-16 one day ahead): internet-BS
 * unified LIVE — batched screening walking the lane's ladder over the
 * MERGED email + YouTube corpus: 5 → 10 → All. The client may send
 * explicit items (dev/dogfood states) or ask for the bundled stream,
 * optionally narrowed by source. Non-rung limits are refused
 * server-side. clean / suspicious / bs is still decided IN CODE per
 * item; a failure on one item is isolated to its report. Per-source
 * tallies ride in the totals — the unified question answered in data.
 */
const body = z
  .object({
    items: z
      .array(
        z.object({
          id: z.string().min(1),
          source: z.enum(BS_SOURCES).optional(),
          label: z.string().max(400).optional(),
          state: z.string().min(1).max(8_000),
        }),
      )
      .min(1)
      .max(120)
      .optional(),
    sources: z.array(z.enum(BS_SOURCES)).min(1).optional(),
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
      parsed.data.items ?? buildBsCorpus(parsed.data.sources ?? undefined);
    const report = await runBsBatch(corpus, {
      limit: parsed.data.limit,
      gates: normalizeGates(parsed.data.gates),
    });
    return NextResponse.json(report);
  } catch (err) {
    const status =
      err instanceof GatewayError || err instanceof JevError ? 502 : 500;
    const message = err instanceof Error ? err.message : "BS batch failed";
    return NextResponse.json({ error: message }, { status });
  }
}
