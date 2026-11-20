import { NextResponse } from "next/server";
import { z } from "zod";
import { moderateChatMessage, normalizeGates } from "@/lib/chat";
import { GatewayError } from "@/lib/gateway";
import { JevError } from "@/lib/jev";

export const runtime = "nodejs";
export const maxDuration = 120;

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
 * UC#9 (11-21 calendar row, shipped 11-20 one day ahead): Twitch-style
 * chat filter — one live-chat message in, allow / hold / block out.
 * CODE decides: the classifier answers toxicity (Score) + promo &
 * spoiler (Noul); the action comes from the shipped rule ladder. The
 * handle rides the message because mods act on USERS. Dev flag
 * attaches the raw wire trace (?dev=1 contract).
 */
const body = z.object({
  message: z.string().min(1).max(2_000),
  user: z.string().max(64).optional(),
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
    const result = await moderateChatMessage(parsed.data.message, parsed.data.user ?? "viewer", {
      gates: normalizeGates(parsed.data.gates),
      trace: parsed.data.dev,
    });
    return NextResponse.json(result);
  } catch (err) {
    const status =
      err instanceof GatewayError || err instanceof JevError ? 502 : 500;
    const message = err instanceof Error ? err.message : "chat moderation failed";
    return NextResponse.json({ error: message }, { status });
  }
}
