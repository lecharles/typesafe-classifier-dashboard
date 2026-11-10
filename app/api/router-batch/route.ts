import { NextResponse } from "next/server";
import { z } from "zod";
import { runRouterBatch, normalizeGates } from "@/lib/router";
import { BATCH_LADDER } from "@/lib/dispatch";
import { GatewayError } from "@/lib/gateway";
import { JevError } from "@/lib/jev";

export const runtime = "nodejs";
export const maxDuration = 180;

const gatesSchema = z
  .object({
    riskFloor: z.number().min(0).max(1).optional(),
    midAt: z.number().min(0).max(10).optional(),
    frontierAt: z.number().min(0).max(10).optional(),
    lowConfBump: z.number().min(0).max(1).optional(),
  })
  .optional();

/**
 * UC#2 batched routing over the email corpus, walking the same ladder the
 * dispatcher uses: 5 → 10 → All. Non-rung limits are refused server-side.
 */
const body = z
  .object({
    items: z
      .array(
        z.object({ id: z.string().min(1), prompt: z.string().min(1).max(4_000) }),
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
      b.limit >= b.items.length,
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
    const report = await runRouterBatch(parsed.data.items, {
      limit: parsed.data.limit,
      gates: normalizeGates(parsed.data.gates),
    });
    return NextResponse.json(report);
  } catch (err) {
    const status =
      err instanceof GatewayError || err instanceof JevError ? 502 : 500;
    const message = err instanceof Error ? err.message : "router batch failed";
    return NextResponse.json({ error: message }, { status });
  }
}
