import { NextResponse } from "next/server";
import { z } from "zod";
import { extractText, normalizeGates } from "@/lib/extract";
import { GatewayError } from "@/lib/gateway";
import { JevError } from "@/lib/jev";

export const runtime = "nodejs";
export const maxDuration = 120;

const gatesSchema = z
  .object({
    resolveAt: z.number().min(0).max(10).optional(),
    ambiguousFloor: z.number().min(0).max(1).optional(),
    lowConfBump: z.number().min(0).max(1).optional(),
  })
  .optional();

/**
 * UC#8 (11-19 calendar row, shipped 11-18 one day ahead): date/value
 * extraction — one messy text in, candidate-by-candidate normalized
 * values out. CODE detects, validates, and normalizes every token; the
 * classifier answers kind (Choice) + precision (Score) + ambiguity
 * (Noul) per candidate; resolved / guessed / vague / rejected is
 * decided IN CODE. The optional anchor pins relative expressions
 * ("tomorrow", "next Friday"); without it they land vague, never
 * guessed wrong. Dev flag attaches the raw wire trace (?dev=1 contract).
 */
const body = z.object({
  text: z.string().min(1).max(20_000),
  anchor: z.string().max(40).optional(),
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
    const result = await extractText(parsed.data.text, {
      gates: normalizeGates(parsed.data.gates),
      anchor: parsed.data.anchor,
      trace: parsed.data.dev,
    });
    return NextResponse.json(result);
  } catch (err) {
    const status =
      err instanceof GatewayError || err instanceof JevError
        ? 502
        : err instanceof Error && /anchor/.test(err.message)
          ? 400
          : 500;
    const message = err instanceof Error ? err.message : "extraction failed";
    return NextResponse.json({ error: message }, { status });
  }
}
