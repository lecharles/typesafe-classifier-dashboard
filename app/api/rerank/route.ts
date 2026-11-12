import { NextResponse } from "next/server";
import { z } from "zod";
import { rerankPassages, normalizeRerankGates } from "@/lib/rerank";
import { GatewayError } from "@/lib/gateway";
import { JevError } from "@/lib/jev";

export const runtime = "nodejs";
export const maxDuration = 180;

const gatesSchema = z
  .object({
    shipAt: z.number().min(0).max(10).optional(),
    benchAt: z.number().min(0).max(10).optional(),
    conflictBenchAt: z.number().min(0).max(1).optional(),
    conflictDropAt: z.number().min(0).max(1).optional(),
    lowConfBump: z.number().min(0).max(1).optional(),
    topK: z.number().int().min(0).max(10).optional(),
  })
  .optional();

/**
 * UC#5 (11-13 calendar row, shipped 11-12 one day ahead): RAG passage
 * re-ranker — every candidate passage is scored with typed questions and
 * the ship / bench / drop disposition, ranking, top-k cut, and coverage
 * are decided IN CODE.
 */
const body = z.object({
  query: z.string().min(1).max(2_000),
  passages: z
    .array(
      z.object({
        id: z.string().min(1),
        text: z.string().min(1).max(4_000),
      }),
    )
    .min(1)
    .max(24),
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
    const result = await rerankPassages(parsed.data.query, parsed.data.passages, {
      gates: normalizeRerankGates(parsed.data.gates),
      trace: parsed.data.dev,
    });
    return NextResponse.json(result);
  } catch (err) {
    const status =
      err instanceof GatewayError || err instanceof JevError ? 502 : 500;
    const message = err instanceof Error ? err.message : "rerank failed";
    return NextResponse.json({ error: message }, { status });
  }
}
