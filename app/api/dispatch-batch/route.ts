import { NextResponse } from "next/server";
import { z } from "zod";
import { runDispatchBatch, BATCH_LADDER } from "@/lib/dispatch";
import { GatewayError } from "@/lib/gateway";
import { JevError } from "@/lib/jev";

export const runtime = "nodejs";
export const maxDuration = 180;

/**
 * UC#1-live (11-10): batched tool-call dispatch with confidence-gated
 * execution in code. The client walks the batch ladder 5 → 10 → All; the
 * server refuses any step that is not a ladder rung (standing batch rule).
 */
const body = z
  .object({
    items: z
      .array(z.object({ id: z.string().min(1), state: z.string().min(1).max(4_000) }))
      .min(1)
      .max(40),
    limit: z.number().int().min(1).nullable().optional(),
    gate: z.number().min(0).max(1).optional(),
    execGate: z.number().min(0).max(1).optional(),
  })
  .refine(
    (b) => b.limit === undefined || b.limit === null || (BATCH_LADDER as readonly number[]).includes(b.limit) || b.limit >= b.items.length,
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
    const report = await runDispatchBatch(parsed.data.items, {
      limit: parsed.data.limit,
      gate: parsed.data.gate,
      execGate: parsed.data.execGate,
    });
    return NextResponse.json(report);
  } catch (err) {
    const status = err instanceof GatewayError || err instanceof JevError ? 502 : 500;
    const message = err instanceof Error ? err.message : "dispatch batch failed";
    return NextResponse.json({ error: message }, { status });
  }
}
