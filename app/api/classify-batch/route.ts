import { NextResponse } from "next/server";
import { z } from "zod";
import { classifyBatch } from "@/lib/batch";
import { question } from "@/lib/schema";
import { GatewayError } from "@/lib/gateway";

export const runtime = "nodejs";
export const maxDuration = 300;

const batchRequest = z.object({
  items: z.array(z.object({ id: z.string(), state: z.string().min(1) })).min(1).max(200),
  questions: z.record(question).refine((q) => Object.keys(q).length > 0),
  concurrency: z.number().int().min(1).max(10).optional(),
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
      concurrency: parsed.data.concurrency ?? 5,
    });
    return NextResponse.json({ results });
  } catch (err) {
    const status = err instanceof GatewayError ? 502 : 500;
    const message = err instanceof Error ? err.message : "batch failed";
    return NextResponse.json({ error: message }, { status });
  }
}
