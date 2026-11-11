import { NextResponse } from "next/server";
import { z } from "zod";
import { screenExchange, normalizeGates } from "@/lib/guardrails";
import { GatewayError } from "@/lib/gateway";
import { JevError } from "@/lib/jev";

export const runtime = "nodejs";
export const maxDuration = 120;

const gatesSchema = z
  .object({
    reviewAt: z.number().min(0).max(10).optional(),
    blockAt: z.number().min(0).max(10).optional(),
    jailbreakFloor: z.number().min(0).max(1).optional(),
    leakReviewAt: z.number().min(0).max(1).optional(),
    leakBlockAt: z.number().min(0).max(1).optional(),
    lowConfBump: z.number().min(0).max(1).optional(),
  })
  .optional();

/**
 * UC#3 (11-12 on the calendar, shipped 11-11): guardrails — screen a
 * message in (and optionally an assistant reply out); the pass / review /
 * block verdict is decided IN CODE from the typed answers.
 */
const body = z.object({
  message: z.string().min(1).max(20_000),
  reply: z.string().max(20_000).optional(),
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
    const result = await screenExchange(parsed.data.message, parsed.data.reply, {
      gates: normalizeGates(parsed.data.gates),
      trace: parsed.data.dev,
    });
    return NextResponse.json(result);
  } catch (err) {
    const status =
      err instanceof GatewayError || err instanceof JevError ? 502 : 500;
    const message = err instanceof Error ? err.message : "guardrails failed";
    return NextResponse.json({ error: message }, { status });
  }
}
