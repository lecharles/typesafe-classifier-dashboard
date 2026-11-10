import { NextResponse } from "next/server";
import { z } from "zod";
import { routePrompt, normalizeGates } from "@/lib/router";
import { GatewayError } from "@/lib/gateway";
import { JevError } from "@/lib/jev";

export const runtime = "nodejs";
export const maxDuration = 120;

const gatesSchema = z
  .object({
    riskFloor: z.number().min(0).max(1).optional(),
    midAt: z.number().min(0).max(10).optional(),
    frontierAt: z.number().min(0).max(10).optional(),
    lowConfBump: z.number().min(0).max(1).optional(),
  })
  .optional();

/**
 * UC#2 (11-11 on the calendar, shipped 11-10): model router — classify
 * intent/difficulty/risk with the Jev primitives, then route the request
 * to a cheap vs frontier tier IN CODE.
 */
const body = z.object({
  prompt: z.string().min(1).max(20_000),
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
    const result = await routePrompt(parsed.data.prompt, {
      gates: normalizeGates(parsed.data.gates),
      trace: parsed.data.dev,
    });
    return NextResponse.json(result);
  } catch (err) {
    const status =
      err instanceof GatewayError || err instanceof JevError ? 502 : 500;
    const message = err instanceof Error ? err.message : "router failed";
    return NextResponse.json({ error: message }, { status });
  }
}
