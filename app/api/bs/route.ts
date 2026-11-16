import { NextResponse } from "next/server";
import { z } from "zod";
import { screenBsItem, normalizeGates } from "@/lib/bs";
import { GatewayError } from "@/lib/gateway";
import { JevError } from "@/lib/jev";

export const runtime = "nodejs";
export const maxDuration = 120;

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
 * unified — screen ONE piece of internet junk (email or video, or any
 * pasted state); clean / suspicious / bs is decided IN CODE from
 * intensity (Score) + malice & payoff (Noul). Batched screening
 * (5 → 10 → All over the merged corpus) lands on /api/bs-batch.
 */
const body = z.object({
  state: z.string().min(1).max(20_000),
  label: z.string().max(400).optional(),
  gates: gatesSchema,
  dev: z.boolean().optional(),
});

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
    const result = await screenBsItem(parsed.data.state, parsed.data.label ?? "item", {
      gates: normalizeGates(parsed.data.gates),
      trace: parsed.data.dev,
    });
    return NextResponse.json(result);
  } catch (err) {
    const status =
      err instanceof GatewayError || err instanceof JevError ? 502 : 500;
    const message = err instanceof Error ? err.message : "BS screen failed";
    return NextResponse.json({ error: message }, { status });
  }
}
