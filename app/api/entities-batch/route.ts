import { NextResponse } from "next/server";
import { z } from "zod";
import { buildEntityCorpus, runEntityBatch, normalizeGates } from "@/lib/entities";
import { BATCH_LADDER } from "@/lib/dispatch";
import { GatewayError } from "@/lib/gateway";
import { JevError } from "@/lib/jev";

export const runtime = "nodejs";
export const maxDuration = 300;

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
 * UC#10 (11-23 calendar row, shipped 11-22 one day ahead): batched
 * entity alignment walking the lane's ladder over the 25-pair market
 * audit: 5 → 10 → All. The client may send explicit pairs
 * (dev/dogfood) or ask for the bundled audit. Non-rung limits are
 * refused server-side. Verdicts stay IN CODE per pair; a failure on
 * one pair is isolated to its report and never aborts the batch.
 * distinct / review / merge tallies + the contradiction-safe cluster
 * fold (merge edges union, a chain never overrules a called
 * separation, refused joins are LOGGED) ride in the report.
 */
const body = z
  .object({
    items: z
      .array(
        z.object({
          id: z.string().min(1),
          a: recordSchema,
          b: recordSchema,
        }),
      )
      .min(1)
      .max(200)
      .optional(),
    limit: z.number().int().min(1).nullable().optional(),
    gates: gatesSchema,
  })
  .refine(
    (b) =>
      b.limit === undefined ||
      b.limit === null ||
      (BATCH_LADDER as readonly number[]).includes(b.limit) ||
      (b.items !== undefined && b.limit >= b.items.length),
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
    const corpus =
      parsed.data.items ?? buildEntityCorpus().map((c) => ({ id: c.id, a: c.a, b: c.b }));
    const report = await runEntityBatch(corpus, {
      limit: parsed.data.limit,
      gates: normalizeGates(parsed.data.gates),
    });
    return NextResponse.json(report);
  } catch (err) {
    const status =
      err instanceof GatewayError || err instanceof JevError ? 502 : 500;
    const message = err instanceof Error ? err.message : "entity batch failed";
    return NextResponse.json({ error: message }, { status });
  }
}
