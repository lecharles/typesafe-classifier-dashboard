import { NextResponse } from "next/server";
import { z } from "zod";
import { planDispatch, executePlan } from "@/lib/dispatch";
import { GatewayError } from "@/lib/gateway";
import { JevError } from "@/lib/jev";

export const runtime = "nodejs";
export const maxDuration = 120;

const body = z.object({
  state: z.string().min(1).max(20_000),
  gate: z.number().min(0).max(1).optional(),
  /** UC#1-live: also EXECUTE the plan in code, with its own confidence gate. */
  execute: z.boolean().optional(),
  execGate: z.number().min(0).max(1).optional(),
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
    const plan = await planDispatch(parsed.data.state, {
      gate: parsed.data.gate,
      trace: parsed.data.dev,
    });
    if (!parsed.data.execute) {
      return NextResponse.json(plan);
    }
    const records = executePlan(plan, { execGate: parsed.data.execGate });
    return NextResponse.json({ ...plan, records });
  } catch (err) {
    const status = err instanceof GatewayError || err instanceof JevError ? 502 : 500;
    const message = err instanceof Error ? err.message : "dispatch failed";
    return NextResponse.json({ error: message }, { status });
  }
}
