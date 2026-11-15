import { NextResponse } from "next/server";
import { z } from "zod";
import { runMemoryBatch, normalizeGates } from "@/lib/memory";
import { BATCH_LADDER } from "@/lib/dispatch";
import { GatewayError } from "@/lib/gateway";
import { JevError } from "@/lib/jev";

export const runtime = "nodejs";
export const maxDuration = 180;

const gatesSchema = z
  .object({
    keepAt: z.number().min(0).max(10).optional(),
    forgetAt: z.number().min(0).max(10).optional(),
    piiBlockAt: z.number().min(0).max(1).optional(),
    durableFloor: z.number().min(0).max(1).optional(),
    lowConfBump: z.number().min(0).max(1).optional(),
  })
  .optional();

/**
 * UC#6 (11-16 calendar row, shipped 11-15 one day ahead): memory curator
 * LIVE — batched curation walking the lane's ladder over the memory
 * candidate corpus: 5 → 10 → All. Non-rung limits are refused
 * server-side. keep / review / forget is still decided IN CODE per
 * candidate; a failure on one candidate is isolated to its report.
 */
const body = z
  .object({
    candidates: z
      .array(
        z.object({
          id: z.string().min(1),
          request: z.string().min(1).max(4_000),
          answer: z.string().max(4_000).optional(),
        }),
      )
      .min(1)
      .max(40),
    limit: z.number().int().min(1).nullable().optional(),
    gates: gatesSchema,
  })
  .refine(
    (b) =>
      b.limit === undefined ||
      b.limit === null ||
      (BATCH_LADDER as readonly number[]).includes(b.limit) ||
      b.limit >= b.candidates.length,
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
    const report = await runMemoryBatch(parsed.data.candidates, {
      limit: parsed.data.limit,
      gates: normalizeGates(parsed.data.gates),
    });
    return NextResponse.json(report);
  } catch (err) {
    const status =
      err instanceof GatewayError || err instanceof JevError ? 502 : 500;
    const message = err instanceof Error ? err.message : "memory batch failed";
    return NextResponse.json({ error: message }, { status });
  }
}
