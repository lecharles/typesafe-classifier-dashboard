import { NextResponse } from "next/server";
import { z } from "zod";
import {
  MAX_ITEMS,
  MAX_TEXT,
  UPLOAD_FORMATS,
  parseCorpusIntake,
  fetchRealCorpus,
  assertOfficialApiUrl,
} from "@/lib/upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Real-corpora upload (11-25 row): the intake door of the hub.
 *
 * POST { kind: "intake", format: text|csv|json, raw, origin? } parses a
 * pasted/uploaded corpus IN CODE — every refused row rides the receipt
 * with its row number and reason, caps are visible, duplicates are
 * dropped AND counted, and the receipt's counters always balance.
 *
 * POST { kind: "official", query?|channelId?|apiUrl?, max? } pulls a
 * REAL corpus through the official YouTube Data API v3 ONLY: https,
 * exact-host allowlist, pinned API path prefix — and when the key is
 * missing or the API refuses, the lane ERRORS instead of smuggling the
 * bundled synthetic sample in. No scraping, ever (ROADMAP standing
 * rule); here it's a wall, not a signpost.
 */
const MAX_RAW = 2_000_000;

const intakeSchema = z.object({
  kind: z.literal("intake"),
  format: z.enum(UPLOAD_FORMATS),
  raw: z.string().max(MAX_RAW),
  origin: z.enum(["paste", "file", "official-api"]).optional(),
  idPrefix: z.string().max(24).optional(),
});

const officialSchema = z.object({
  kind: z.literal("official"),
  query: z.string().min(1).max(400).optional(),
  channelId: z.string().max(80).optional(),
  apiUrl: z
    .string()
    .max(2000)
    .optional()
    .refine((u) => u === undefined || assertOfficialApiUrl(u).ok, {
      message:
        "apiUrl must be an official YouTube Data API v3 url (https, googleapis host, /youtube/v3/ path)",
    }),
  max: z.number().int().min(1).max(50).optional(),
});

const body = z.discriminatedUnion("kind", [intakeSchema, officialSchema]);

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

  if (parsed.data.kind === "intake") {
    const intake = parseCorpusIntake(parsed.data.raw, parsed.data.format, {
      origin: parsed.data.origin ?? "paste",
      idPrefix: parsed.data.idPrefix,
    });
    return NextResponse.json({ ...intake, cap: MAX_ITEMS, textCap: MAX_TEXT });
  }

  const pulled = await fetchRealCorpus({
    query: parsed.data.query,
    channelId: parsed.data.channelId,
    apiUrl: parsed.data.apiUrl,
    max: parsed.data.max,
  });
  if (!pulled.ok) {
    // a refused pull is a 4xx decision the client can show verbatim —
    // never a silent downgrade to synthetic data
    return NextResponse.json({ error: pulled.error }, { status: pulled.status });
  }
  return NextResponse.json(pulled);
}
