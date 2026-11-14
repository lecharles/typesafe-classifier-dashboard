import { NextResponse } from "next/server";
import { z } from "zod";
import { curateExchange, normalizeGates } from "@/lib/memory";
import { GatewayError } from "@/lib/gateway";
import { JevError } from "@/lib/jev";

export const runtime = "nodejs";
export const maxDuration = 120;

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
 * UC#6 (11-15 on the calendar, shipped 11-14): memory curator scaffold —
 * curate one request/answer pair; keep / review / forget is decided IN
 * CODE from reuse (Score) + durability & PII (Noul). Batched curation
 * (5 → 10 → All) lands with the 11-16 row.
 */
const body = z.object({
  request: z.string().min(1).max(20_000),
  answer: z.string().max(20_000).optional(),
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
    const result = await curateExchange(parsed.data.request, parsed.data.answer, {
      gates: normalizeGates(parsed.data.gates),
      trace: parsed.data.dev,
    });
    return NextResponse.json(result);
  } catch (err) {
    const status =
      err instanceof GatewayError || err instanceof JevError ? 502 : 500;
    const message = err instanceof Error ? err.message : "memory curation failed";
    return NextResponse.json({ error: message }, { status });
  }
}
