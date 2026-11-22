import { NextResponse } from "next/server";
import { z } from "zod";
import { alignEntityPair, normalizeGates } from "@/lib/entities";
import { GatewayError } from "@/lib/gateway";
import { JevError } from "@/lib/jev";

export const runtime = "nodejs";
export const maxDuration = 120;

const recordSchema = z.object({
  id: z.string().min(1).max(32),
  name: z.string().min(1).max(160),
  brand: z.string().max(80).optional(),
  model: z.string().max(80).optional(),
  detail: z.string().max(160).optional(),
});

const gatesSchema = z
  .object({
    mergeAt: z.number().min(0).max(4).optional(),
    distinctAt: z.number().min(0).max(4).optional(),
    conflictFloor: z.number().min(0).max(1).optional(),
    collisionCap: z.number().min(0).max(1).optional(),
    lowConfBump: z.number().min(0).max(1).optional(),
  })
  .optional();

/**
 * UC#10 (11-23 calendar row, shipped 11-22 one day ahead): entity
 * alignment / dedup — two marketplace records in, distinct / review /
 * merge out. CODE decides: the classifier answers similarity (Score) +
 * conflict & genericName (Noul); the verdict comes from the shipped
 * rule ladder — the destructive merge lane is closed to doubt, and a
 * hard identifier contradiction forces the pair apart whatever the
 * name says. Dev flag attaches the raw wire trace (?dev=1 contract).
 */
const body = z.object({
  a: recordSchema,
  b: recordSchema,
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
    const result = await alignEntityPair(parsed.data.a, parsed.data.b, {
      gates: normalizeGates(parsed.data.gates),
      trace: parsed.data.dev,
    });
    return NextResponse.json(result);
  } catch (err) {
    const status =
      err instanceof GatewayError || err instanceof JevError ? 502 : 500;
    const message = err instanceof Error ? err.message : "entity alignment failed";
    return NextResponse.json({ error: message }, { status });
  }
}
