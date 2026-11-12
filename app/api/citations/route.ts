import { NextResponse } from "next/server";
import { z } from "zod";
import { checkCitation, normalizeCitationGates } from "@/lib/citations";
import { GatewayError } from "@/lib/gateway";
import { JevError } from "@/lib/jev";

export const runtime = "nodejs";
export const maxDuration = 120;

const gatesSchema = z
  .object({
    specificAt: z.number().min(0).max(10).optional(),
    fabricationReviewAt: z.number().min(0).max(1).optional(),
    fabricationFlagAt: z.number().min(0).max(1).optional(),
    lowConfBump: z.number().min(0).max(1).optional(),
  })
  .optional();

/**
 * UC#4 (11-13 calendar row, shipped 11-12 one day ahead): citation
 * checker — does the quote support the claim? The pass / review / flag
 * verdict is decided IN CODE from the typed answers.
 */
const body = z.object({
  claim: z.string().min(1).max(4_000),
  quote: z.string().min(1).max(8_000),
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
    const result = await checkCitation(parsed.data.claim, parsed.data.quote, {
      gates: normalizeCitationGates(parsed.data.gates),
      trace: parsed.data.dev,
    });
    return NextResponse.json(result);
  } catch (err) {
    const status =
      err instanceof GatewayError || err instanceof JevError ? 502 : 500;
    const message = err instanceof Error ? err.message : "citation check failed";
    return NextResponse.json({ error: message }, { status });
  }
}
