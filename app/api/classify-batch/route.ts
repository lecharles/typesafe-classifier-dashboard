import { NextResponse } from "next/server";
import { z } from "zod";
import { classifyBatch } from "@/lib/batch";
import { provider, question } from "@/lib/schema";
import { GatewayError } from "@/lib/gateway";
import { JevError } from "@/lib/jev";

export const runtime = "nodejs";
export const maxDuration = 300;

const batchRequest = z.object({
  items: z.array(z.object({ id: z.string(), state: z.string().min(1) })).min(1).max(200),
  questions: z.record(question).refine((q) => Object.keys(q).length > 0),
  concurrency: z.number().int().min(1).max(10).optional(),
  provider: provider.optional(),
  /** Dev mode (?dev=1): attach raw request/response traces + enable fallback. */
  dev: z.boolean().optional(),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = batchRequest.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }

  try {
    const results = await classifyBatch(parsed.data.items, parsed.data.questions, {
      // The gateway free tier allows ~5 requests/minute, so keep concurrency
      // modest there; Jev's per-org rate limits are checked in the console.
      // Both clients honor Retry-After regardless.
      concurrency: parsed.data.concurrency ?? 3,
      provider: parsed.data.provider,
      // Dev view (?dev=1): record raw payloads and let jev failures fall back to the gateway.
      trace: parsed.data.dev,
      fallback: parsed.data.dev,
    });
    return NextResponse.json({ results });
  } catch (err) {
    const status = err instanceof GatewayError || err instanceof JevError ? 502 : 500;
    const message = err instanceof Error ? err.message : "batch failed";
    return NextResponse.json({ error: message }, { status });
  }
}
