import { NextResponse } from "next/server";
import { z } from "zod";
import { buildHarnessItems, runHarness } from "@/lib/harness";
import { BATCH_LADDER } from "@/lib/dispatch";
import { GatewayError } from "@/lib/gateway";
import { JevError } from "@/lib/jev";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * D14 (11-14 calendar row, pulled forward onto 11-13): the emulated-vs-Jev
 * comparison harness. Every item runs through BOTH backends and CODE reports
 * agreement. The client may send explicit items (dev/dogfood states) or ask
 * for the bundled corpus by dataset; non-ladder limits are refused.
 */
const body = z
  .object({
    items: z
      .array(
        z.object({
          id: z.string().min(1),
          dataset: z.enum(["emails", "youtube"]),
          state: z.string().min(1).max(8_000),
        }),
      )
      .min(1)
      .max(120)
      .optional(),
    datasets: z.array(z.enum(["emails", "youtube"])).min(1).optional(),
    limit: z.number().int().min(1).nullable().optional(),
  })
  .refine(
    (b) =>
      b.limit === undefined ||
      b.limit === null ||
      (BATCH_LADDER as readonly number[]).includes(b.limit) ||
      (b.items !== undefined && b.limit >= b.items.length),
    { message: "limit must be a batch ladder rung (5, 10) or All" },
  )
  .refine((b) => b.items !== undefined || b.datasets !== undefined, {
    message: "send items or datasets",
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
  const items = parsed.data.items ?? buildHarnessItems(parsed.data.datasets);
  try {
    const report = await runHarness(items, { limit: parsed.data.limit });
    return NextResponse.json(report);
  } catch (err) {
    const status =
      err instanceof GatewayError || err instanceof JevError ? 502 : 500;
    const message = err instanceof Error ? err.message : "comparison harness failed";
    return NextResponse.json({ error: message }, { status });
  }
}
