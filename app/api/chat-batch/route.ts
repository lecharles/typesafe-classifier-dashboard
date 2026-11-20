import { NextResponse } from "next/server";
import { z } from "zod";
import { buildChatCorpus, runChatBatch, normalizeGates } from "@/lib/chat";
import { BATCH_LADDER } from "@/lib/dispatch";
import { GatewayError } from "@/lib/gateway";
import { JevError } from "@/lib/jev";

export const runtime = "nodejs";
export const maxDuration = 300;

const gatesSchema = z
  .object({
    blockAt: z.number().min(0).max(4).optional(),
    allowAt: z.number().min(0).max(4).optional(),
    promoBlockAt: z.number().min(0).max(1).optional(),
    spoilerFloor: z.number().min(0).max(1).optional(),
    lowConfBump: z.number().min(0).max(1).optional(),
  })
  .optional();

/**
 * UC#9 (11-21 calendar row, shipped 11-20 one day ahead): batched chat
 * moderation walking the lane's ladder over the live-chat scroll:
 * 5 → 10 → All. The client may send explicit messages (dev/dogfood)
 * or ask for the bundled stream. Non-rung limits are refused
 * server-side. Actions stay IN CODE per message; a failure on one
 * message is isolated to its report and never aborts the batch.
 * allow / hold / block tallies + the per-user offender rollup ride
 * in the report — timeout candidates in data, not vibes.
 */
const body = z
  .object({
    items: z
      .array(
        z.object({
          id: z.string().min(1),
          user: z.string().max(64).optional(),
          message: z.string().min(1).max(2_000),
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
      parsed.data.items ?? buildChatCorpus().map((c) => ({ id: c.id, user: c.user, message: c.message }));
    const report = await runChatBatch(corpus, {
      limit: parsed.data.limit,
      gates: normalizeGates(parsed.data.gates),
    });
    return NextResponse.json(report);
  } catch (err) {
    const status =
      err instanceof GatewayError || err instanceof JevError ? 502 : 500;
    const message = err instanceof Error ? err.message : "chat batch failed";
    return NextResponse.json({ error: message }, { status });
  }
}
