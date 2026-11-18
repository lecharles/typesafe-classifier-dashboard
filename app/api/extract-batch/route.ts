import { NextResponse } from "next/server";
import { z } from "zod";
import { runExtractBatch, normalizeGates } from "@/lib/extract";
import { BATCH_LADDER } from "@/lib/dispatch";
import { extractionCorpus } from "@/data/extraction-corpus";
import { GatewayError } from "@/lib/gateway";
import { JevError } from "@/lib/jev";

export const runtime = "nodejs";
export const maxDuration = 300;

const gatesSchema = z
  .object({
    resolveAt: z.number().min(0).max(10).optional(),
    ambiguousFloor: z.number().min(0).max(1).optional(),
    lowConfBump: z.number().min(0).max(1).optional(),
  })
  .optional();

/**
 * UC#8 (11-19 calendar row, shipped 11-18 one day ahead): batched
 * extraction walking the lane's ladder over the messy-snippet corpus:
 * 5 → 10 → All. The client may send explicit snippets (dev/dogfood)
 * or ask for the bundled stream. Non-rung limits are refused
 * server-side. Detection, validation, and normalization stay IN CODE
 * per candidate; a failure on one snippet is isolated to its report
 * and never aborts the batch. resolved / guessed / vague / rejected
 * tallies ride in the totals — every status a human would want to see.
 */
const body = z
  .object({
    items: z
      .array(
        z.object({
          id: z.string().min(1),
          text: z.string().min(1).max(8_000),
        }),
      )
      .min(1)
      .max(120)
      .optional(),
    anchor: z.string().max(40).optional(),
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
    const corpus = parsed.data.items ?? extractionCorpus;
    const report = await runExtractBatch(corpus, {
      limit: parsed.data.limit,
      anchor: parsed.data.anchor,
      gates: normalizeGates(parsed.data.gates),
    });
    return NextResponse.json(report);
  } catch (err) {
    const status =
      err instanceof GatewayError || err instanceof JevError ? 502 : 500;
    const message = err instanceof Error ? err.message : "extraction batch failed";
    return NextResponse.json({ error: message }, { status });
  }
}
