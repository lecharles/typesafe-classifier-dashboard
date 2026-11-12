import { NextResponse } from "next/server";
import { z } from "zod";
import { runRerankBatch, normalizeRerankGates } from "@/lib/rerank";
import { BATCH_LADDER } from "@/lib/dispatch";
import { GatewayError } from "@/lib/gateway";
import { JevError } from "@/lib/jev";

export const runtime = "nodejs";
export const maxDuration = 180;

const gatesSchema = z
  .object({
    shipAt: z.number().min(0).max(10).optional(),
    benchAt: z.number().min(0).max(10).optional(),
    conflictBenchAt: z.number().min(0).max(1).optional(),
    conflictDropAt: z.number().min(0).max(1).optional(),
    lowConfBump: z.number().min(0).max(1).optional(),
    topK: z.number().int().min(0).max(10).optional(),
  })
  .optional();

/**
 * UC#5 batched passage reranking, walking the lane's ladder over the
 * PASSAGES: 5 → 10 → All. Non-rung limits are refused server-side.
 */
const body = z
  .object({
    query: z.string().min(1).max(2_000),
    passages: z
      .array(
        z.object({
          id: z.string().min(1),
          text: z.string().min(1).max(4_000),
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
      b.limit >= b.passages.length,
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
    const report = await runRerankBatch(parsed.data.query, parsed.data.passages, {
      limit: parsed.data.limit,
      gates: normalizeRerankGates(parsed.data.gates),
    });
    return NextResponse.json(report);
  } catch (err) {
    const status =
      err instanceof GatewayError || err instanceof JevError ? 502 : 500;
    const message = err instanceof Error ? err.message : "rerank batch failed";
    return NextResponse.json({ error: message }, { status });
  }
}
