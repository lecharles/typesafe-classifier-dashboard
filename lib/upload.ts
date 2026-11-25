/**
 * Real-corpora upload (11-25 row): bring your OWN data to the hub.
 *
 * Everything before this row classified shipped synthetic corpora. This
 * lane is the door the other way in: paste-in text or a CSV/JSON file is
 * PARSED IN CODE into a screening corpus, and live pulls ride ONLY the
 * official APIs (YouTube Data API v3 through a host allowlist — the
 * ROADMAP's standing rule: no fine-tuning, no scraping, official APIs
 * only, and here that rule is CODE, not prose).
 *
 * Intake discipline, same family as every code-side rule in the repo:
 *
 *  - THE PARSER NEVER TRUSTS THE PAYLOAD. Every row walks the shape
 *    guard; a row it can't believe is REJECTED with its row number and
 *    reason — broken rows are counted, never silently dropped.
 *  - CAPS ARE VISIBLE. Over MAX_ITEMS the intake keeps the head and
 *    sets `truncated` + counts.capDropped — the damage is on the
 *    receipt, not buried.
 *  - DUPLICATES ARE DROPPED AND COUNTED. Real exports ship duelist
 *    rows (double-exports, merged dumps); the normalized text hash
 *    dedupes them exactly once, `duplicatesDropped` says how often.
 *  - PROVENANCE NEVER LIES. Every item carries its origin
 *    (paste / file / official-api), and the official pull REFUSES when
 *    no key is set or the API fails — it never smuggles the bundled
 *    synthetic sample into a lane that promises real data.
 *  - THE OFFICIAL-API GUARD IS A WALL, NOT A SIGNPOST. https only,
 *    hostname EXACT match against the allowlist (googleapis.com.evil.tld
 *    is not googleapis.com), path prefix pinned to the API surface, and
 *    a caller-supplied key param is stripped and replaced server-side —
 *    the secret rides the request, never the echo.
 */

import { BATCH_LADDER } from "@/lib/dispatch";
import {
  BS_VERDICTS,
  DEFAULT_GATES,
  normalizeGates,
  screenBsItem,
  type BsGates,
  type BsSignals,
  type BsTally,
  type BsVerdict,
} from "@/lib/bs";
import { classify } from "@/lib/classify";
import type { Provider, Usage } from "@/lib/schema";
import type { ExportRow } from "@/lib/export";

/* ------------------------------------------------------------------ *
 * Intake shapes.
 * ------------------------------------------------------------------ */

export const UPLOAD_FORMATS = ["text", "csv", "json"] as const;
export type UploadFormat = (typeof UPLOAD_FORMATS)[number];

export const UPLOAD_ORIGINS = ["paste", "file", "official-api"] as const;
export type UploadOrigin = (typeof UPLOAD_ORIGINS)[number];

/** Hard ceiling on a corpus a single screen batch walks (like the entities route cap). */
export const MAX_ITEMS = 200;
/** Same ceiling /api/bs enforces on a pasted state — uploads must be screenable. */
export const MAX_TEXT = 20_000;
/** Display-only metadata cap, mirroring /api/bs's label. */
export const MAX_LABEL = 400;
/** Ids ride exports; keep them CSV-safe and short. */
export const MAX_ID = 120;
/** How much of a rejected row rides the receipt (so you can FIND it). */
export const REJECT_PREVIEW = 60;

const ID_SHAPE = /^[A-Za-z0-9._-]+$/;

export type UploadItem = {
  id: string;
  /** the full text handed to the classifier */
  text: string;
  /** display-only */
  label: string;
  origin: UploadOrigin;
};

export type RejectedRow = {
  /** 1-based DATA row (after the header for csv) */
  row: number;
  reason: string;
  preview: string;
};

export type IntakeCounts = {
  /** data rows seen (header excluded) */
  rows: number;
  kept: number;
  rejected: number;
  duplicates: number;
  blankSkipped: number;
  capDropped: number;
};

export type CorpusIntake = {
  format: UploadFormat;
  origin: UploadOrigin;
  items: UploadItem[];
  rejected: RejectedRow[];
  /** whole-file refusal (bad JSON, missing header…) — a file-level no, not a row-level one */
  headerError: string | null;
  /** integrity invariant the tests lean on (row-level):
   *  rows === kept + rejected + duplicates + blankSkipped + capDropped */
  counts: IntakeCounts;
};

/**
 * The whole intake is decided IN CODE. A file is never partially
 * believed: rows pass the guard or they ride `rejected` with row
 * numbers — the receipt always balances (see IntakeCounts).
 */
export function parseCorpusIntake(
  raw: unknown,
  format: UploadFormat,
  opts: { origin?: UploadOrigin; idPrefix?: string } = {},
): CorpusIntake {
  if (!UPLOAD_FORMATS.includes(format)) {
    throw new Error(`upload: unknown format '${String(format)}' (text | csv | json)`);
  }
  const origin: UploadOrigin = opts.origin ?? "paste";
  const prefix = (opts.idPrefix ?? "u").trim() || "u";

  const refused = (reason: string, preview = ""): CorpusIntake => ({
    format,
    origin,
    items: [],
    rejected: [{ row: 0, reason, preview }],
    headerError: reason,
    counts: { rows: 0, kept: 0, rejected: 1, duplicates: 0, blankSkipped: 0, capDropped: 0 },
  });

  if (typeof raw !== "string") return refused("payload is not text");
  const text = raw.replace(/^\uFEFF/, ""); // BOM: stripped, not a mystery char in row 1

  if (format === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return refused("not valid JSON", text.slice(0, REJECT_PREVIEW));
    }
    if (!Array.isArray(parsed)) return refused("JSON root must be an array", text.slice(0, REJECT_PREVIEW));
    const entries: RowIn[] = (parsed as Array<Record<string, unknown> | string>).map(
      (value, i) => ({ row: i + 1, value }),
    );
    return finalize(format, origin, entries, [], prefix, 0, parsed.length);
  }

  if (format === "csv") {
    const records = parseCsvRecords(text);
    if (records.length === 0) return refused("empty csv");
    const header = records[0].map((h) => h.trim().toLowerCase());
    const textCol = header.indexOf("text");
    if (textCol < 0) {
      return refused('csv header must include a "text" column', records[0].join(",").slice(0, REJECT_PREVIEW));
    }
    const idCol = header.indexOf("id");
    const labelCol = header.indexOf("label");
    const dataRows = records.slice(1);
    const entries: RowIn[] = [];
    const preRejects: RejectedRow[] = [];
    dataRows.forEach((cells, i) => {
      if (cells.length !== header.length) {
        preRejects.push({
          row: i + 1,
          reason: `column count mismatch (${cells.length} vs ${header.length})`,
          preview: cells.join(" ").slice(0, REJECT_PREVIEW),
        });
        return;
      }
      const entry: Record<string, unknown> = { text: cells[textCol] };
      if (idCol >= 0 && cells[idCol].trim()) entry.id = cells[idCol].trim();
      if (labelCol >= 0 && cells[labelCol].trim()) entry.label = cells[labelCol].trim();
      entries.push({ row: i + 1, value: entry });
    });
    return finalize(format, origin, entries, preRejects, prefix, 0, dataRows.length);
  }

  // text: one item per line. Blank lines are SKIPPED AND COUNTED — and
  // kept rows keep their ORIGINAL line numbers for the receipt.
  const lines = text.split(/\r\n|\r|\n/);
  const entries: RowIn[] = [];
  lines.forEach((l, i) => {
    if (l.trim() !== "") entries.push({ row: i + 1, value: l });
  });
  return finalize(format, origin, entries, [], prefix, lines.length - entries.length, lines.length);
}

/* ------------------------------------------------------------------ *
 * Shared row ingestion for every formats. THE GUARD LIVES HERE.
 * ------------------------------------------------------------------ */

type RowIn = { row: number; value: unknown };

function finalize(
  format: UploadFormat,
  origin: UploadOrigin,
  entries: RowIn[],
  preRejects: RejectedRow[],
  prefix: string,
  blankSkipped: number,
  rowsOverride?: number,
): CorpusIntake {
  const items: UploadItem[] = [];
  const rejected: RejectedRow[] = [...preRejects];
  const seenText = new Set<string>();
  const seenId = new Set<string>();
  let duplicates = 0;
  let capDropped = 0;

  const total = Math.max(rowsOverride ?? entries.length, entries.length + preRejects.length);
  for (let i = 0; i < entries.length; i++) {
    const rowNum = entries[i].row;
    const entry = entries[i].value;

    let textRaw = "";
    let id: string | undefined;
    let label: string | undefined;

    if (format === "text") {
      textRaw = String(entry ?? "");
    } else if (typeof entry === "string") {
      textRaw = entry;
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const e = entry as Record<string, unknown>;
      if (typeof e.text === "string") textRaw = e.text;
      else if (typeof e.content === "string") textRaw = e.content;
      else {
        rejected.push({ row: rowNum, reason: 'no "text" string on the row', preview: safePreview(e) });
        continue;
      }
      if (e.id !== undefined) {
        if (typeof e.id !== "string" || e.id.trim() === "") {
          rejected.push({ row: rowNum, reason: "id must be a non-empty string", preview: safePreview(e) });
          continue;
        }
        id = e.id.trim();
      }
      if (e.label !== undefined) {
        if (typeof e.label !== "string") {
          rejected.push({ row: rowNum, reason: "label must be a string", preview: safePreview(e) });
          continue;
        }
        label = e.label;
      }
    } else {
      rejected.push({ row: rowNum, reason: "row is neither text nor an object", preview: safePreview(entry) });
      continue;
    }

    const trimmed = textRaw.trim();
    if (!trimmed) {
      rejected.push({ row: rowNum, reason: "empty text", preview: safePreview(trimmed) });
      continue;
    }
    if (trimmed.length > MAX_TEXT) {
      // NEVER silently clip: a screen of a cut-down text would classify
      // something the user never uploaded.
      rejected.push({ row: rowNum, reason: `text over ${MAX_TEXT} chars`, preview: trimmed.slice(0, REJECT_PREVIEW) });
      continue;
    }

    if (id !== undefined) {
      if (id.length > MAX_ID || !ID_SHAPE.test(id)) {
        rejected.push({ row: rowNum, reason: `id must be ≤${MAX_ID} chars of [A-Za-z0-9._-]`, preview: safePreview(trimmed) });
        continue;
      }
      if (seenId.has(id)) {
        rejected.push({ row: rowNum, reason: `duplicate id '${id}'`, preview: safePreview(trimmed) });
        continue;
      }
    }

    const normKey = trimmed.toLowerCase().replace(/\s+/g, " ");
    if (seenText.has(normKey)) {
      duplicates += 1;
      continue;
    }

    if (items.length >= MAX_ITEMS) {
      // the cap: THIS row and everything still unseen, all counted
      capDropped = total - (items.length + rejected.length + duplicates + blankSkipped);
      break;
    }

    const finalId = id ?? `${prefix}-${rowNum}`;
    seenId.add(finalId);
    seenText.add(normKey);
    items.push({
      id: finalId,
      text: trimmed,
      // label is display metadata — clipped, never a reason to reject a row
      label: (label ?? trimmed).trim().slice(0, MAX_LABEL) || trimmed.slice(0, MAX_LABEL),
      origin,
    });
  }

  return {
    format,
    origin,
    items,
    rejected,
    headerError: null,
    counts: {
      rows: total,
      kept: items.length,
      rejected: rejected.length,
      duplicates,
      blankSkipped,
      capDropped,
    },
  };
}

function safePreview(x: unknown): string {
  let s: string;
  try {
    s = typeof x === "string" ? x : JSON.stringify(x) ?? String(x);
  } catch {
    s = "[unserializable row]";
  }
  return s.replace(/\s+/g, " ").slice(0, REJECT_PREVIEW);
}

/* ------------------------------------------------------------------ *
 * CSV reader (quote-aware: "" escapes, newlines inside quotes ride).
 * ------------------------------------------------------------------ */

export function parseCsvRecords(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const src = text.replace(/^\uFEFF/, "");

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

/* ------------------------------------------------------------------ *
 * OFFICIAL APIs ONLY — the no-scraping rule, as code.
 * ------------------------------------------------------------------ */

export type OfficialApiSpec = {
  label: string;
  /** EXACT hostnames — a suffix match would let evil.com.host pass */
  hosts: readonly string[];
  /** pinned API surface — not the watch pages, not the frontend */
  pathPrefix: string;
};

export const OFFICIAL_APIS = {
  youtube: {
    label: "YouTube Data API v3",
    hosts: ["www.googleapis.com", "youtube.googleapis.com"],
    pathPrefix: "/youtube/v3/",
  },
} as const satisfies Record<string, OfficialApiSpec>;

export type OfficialApiId = keyof typeof OFFICIAL_APIS;

/**
 * The allowlist wall. Returns the parsed URL or a human reason the pull
 * was refused — the reason never contains a key.
 */
export function assertOfficialApiUrl(
  rawUrl: string,
  api: OfficialApiId = "youtube",
): { ok: true; url: URL } | { ok: false; reason: string } {
  const spec = OFFICIAL_APIS[api];
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "not a parseable URL" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: "official API pulls are https-only" };
  }
  if (!(spec.hosts as readonly string[]).includes(url.hostname)) {
    return { ok: false, reason: `'${url.hostname}' is not an official ${spec.label} host` };
  }
  if (!url.pathname.startsWith(spec.pathPrefix)) {
    return { ok: false, reason: `path must live under ${spec.pathPrefix} — this lane never scrapes` };
  }
  return { ok: true, url };
}

export type OfficialPullOptions = {
  query?: string;
  channelId?: string;
  /** a pasted OFFICIAL API v3 url — guard-walled before anything hits the wire */
  apiUrl?: string;
  max?: number;
  fetchImpl?: typeof fetch;
};

export type OfficialPullResult =
  | { ok: true; api: string; items: UploadItem[] }
  | { ok: false; error: string; status: 400 | 502 };

/**
 * Pull a REAL corpus through the official YouTube Data API v3. The
 * bundled synthetic sample is NEVER an option on this path — if the key
 * is missing or the API refuses, the lane says so. PROVENANCE NEVER
 * LIES.
 */
export async function fetchRealCorpus(opts: OfficialPullOptions = {}): Promise<OfficialPullResult> {
  const spec = OFFICIAL_APIS.youtube;
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    return {
      ok: false,
      error: "YOUTUBE_API_KEY is not set — this lane carries real data only and will not fall back to the bundled synthetic sample",
      status: 400,
    };
  }

  let url: URL;
  if (opts.apiUrl && opts.apiUrl.trim()) {
    const guard = assertOfficialApiUrl(opts.apiUrl.trim(), "youtube");
    if (!guard.ok) return { ok: false, error: `apiUrl refused: ${guard.reason}`, status: 400 };
    url = guard.url;
    // The caller's url NEVER rides its own secret: strip any key param
    // they pasted, re-attach the server-side key.
    url.searchParams.delete("key");
  } else {
    const q = opts.query?.trim();
    const ch = opts.channelId?.trim();
    if (!q && !ch) {
      return { ok: false, error: "give a search query, a channelId, or an official API url", status: 400 };
    }
    url = new URL("https://www.googleapis.com/youtube/v3/search");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("type", "video");
    url.searchParams.set("order", "date");
    if (q) url.searchParams.set("q", q);
    if (ch) url.searchParams.set("channelId", ch);
  }
  const max = Math.max(1, Math.min(opts.max ?? 25, 50));
  url.searchParams.set("maxResults", String(max));
  url.searchParams.set("key", key);

  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  let res: Awaited<ReturnType<typeof doFetch>>;
  try {
    res = await doFetch(url.toString());
  } catch {
    return { ok: false, error: "official API unreachable (network)", status: 502 };
  }
  if (!res.ok) {
    // res.status is safe; the body of an error can echo the request — never read it here.
    return { ok: false, error: `official API responded HTTP ${res.status}`, status: 502 };
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return { ok: false, error: "official API returned unreadable JSON", status: 502 };
  }
  const items = officialItemsFrom((payload as { items?: unknown }).items);
  return { ok: true, api: spec.label, items };
}

/** Map raw API v3 search items into UploadItems — shape-guarded; junk entries drop as 0 items, never half-believed. */
export function officialItemsFrom(rawItems: unknown): UploadItem[] {
  if (!Array.isArray(rawItems)) return [];
  const out: UploadItem[] = [];
  const seen = new Set<string>();
  for (const it of rawItems) {
    if (!it || typeof it !== "object") continue;
    const rec = it as Record<string, unknown>;
    const idWrap = rec.id as Record<string, unknown> | undefined;
    const vid = typeof idWrap?.videoId === "string" ? idWrap.videoId : "";
    if (!vid || !ID_SHAPE.test(vid)) continue;
    const sn = rec.snippet as Record<string, unknown> | undefined;
    const title = typeof sn?.title === "string" ? sn.title.trim() : "";
    const desc = typeof sn?.description === "string" ? sn.description.trim() : "";
    if (!title) continue;
    const key = vid.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const text = `${title}\n\n${desc}`.trim().slice(0, MAX_TEXT);
    out.push({
      id: `yt-${vid}`,
      text,
      label: title.slice(0, MAX_LABEL),
      origin: "official-api",
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Screening the upload through the UC#7 BS ladder.
 * ------------------------------------------------------------------ */

export type UploadBatchItemIn = {
  id: string;
  text: string;
  label?: string;
  origin?: UploadOrigin;
};

export type UploadBatchItem = {
  id: string;
  label: string;
  origin: UploadOrigin;
  verdict?: BsVerdict;
  reasons?: string[];
  signals?: BsSignals;
  usage?: Usage;
  error?: string;
  trace?: unknown;
};

export type UploadBatchReport = {
  items: UploadBatchItem[];
  totals: {
    screened: number;
    errors: number;
    verdicts: BsTally;
    usage: Usage;
  };
  gates: BsGates;
  model: string;
  provider: Provider;
};

export type RunUploadBatchOptions = {
  classifyFn?: typeof classify;
  gates?: Partial<BsGates>;
  /** ladder rung; null = All. Default 5 (first rung), same contract as every lane. */
  limit?: number | null;
  concurrency?: number;
  trace?: boolean;
};

function emptyTally(): BsTally {
  return { clean: 0, suspicious: 0, bs: 0 };
}

/**
 * Screen an UPLOADED corpus with the exact UC#7 ladder — clean /
 * suspicious / bs decided IN CODE per item, a failure on one row is
 * isolated and counted and never aborts the batch.
 */
export async function runUploadBatch(
  items: UploadBatchItemIn[],
  opts: RunUploadBatchOptions = {},
): Promise<UploadBatchReport> {
  const run = opts.classifyFn ?? classify;
  const gates = normalizeGates(opts.gates);
  const limit = opts.limit === null ? items.length : (opts.limit ?? BATCH_LADDER[0]);
  const scoped = items.slice(0, Math.max(0, Math.min(limit, items.length)));
  const concurrency = Math.min(Math.max(1, opts.concurrency ?? 3), scoped.length || 1);

  const reports: (UploadBatchItem | undefined)[] = new Array(scoped.length);
  let cursor = 0;
  let model = "";
  let provider: Provider = "gateway";

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= scoped.length) return;
      const c = scoped[i];
      const report: UploadBatchItem = {
        id: c.id,
        label: c.label?.trim() || c.text.slice(0, 80),
        origin: c.origin ?? "paste",
      };
      try {
        const scr = await screenBsItem(c.text, report.label, {
          classifyFn: run,
          gates,
          trace: opts.trace,
        });
        report.verdict = scr.decision.verdict;
        report.reasons = scr.decision.reasons;
        report.signals = scr.signals;
        report.usage = scr.usage;
        if (scr.trace !== undefined) report.trace = scr.trace;
        model = scr.model;
        provider = scr.provider;
      } catch (err) {
        report.error = err instanceof Error ? err.message : "upload screen failed";
      }
      reports[i] = report;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const totals: UploadBatchReport["totals"] = {
    screened: scoped.length,
    errors: 0,
    verdicts: emptyTally(),
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  for (const r of reports.filter((x): x is UploadBatchItem => !!x)) {
    if (r.error) {
      totals.errors += 1;
      continue;
    }
    if (r.verdict) totals.verdicts[r.verdict] += 1;
    if (r.usage) {
      totals.usage.input_tokens += r.usage.input_tokens;
      totals.usage.output_tokens += r.usage.output_tokens;
    }
  }

  return {
    items: reports.filter((x): x is UploadBatchItem => !!x),
    totals,
    gates,
    model,
    provider,
  };
}

/* ------------------------------------------------------------------ *
 * D8 export surface — stable columns, errored rows ride as "error".
 * ------------------------------------------------------------------ */

const round3 = (n: number) => Number(n.toFixed(3));

export function uploadExportRows(items: UploadBatchItem[]): ExportRow[] {
  return items.map((r) => ({
    id: r.id,
    label: r.label,
    origin: r.origin,
    verdict: r.error ? "error" : r.verdict ?? "",
    bs: r.signals ? round3(r.signals.bs) : null,
    malice: r.signals ? round3(r.signals.malice) : null,
    payoff: r.signals ? round3(r.signals.payoff) : null,
    confidence: r.signals ? round3(r.signals.confidence) : null,
    error: r.error ?? "",
  }));
}

/* ------------------------------------------------------------------ *
 * SQLite ride (lane-agnostic store from UC#10-persist): an upload
 * screen is a finished report too — persist it, survive the restart.
 * ------------------------------------------------------------------ */

export const UPLOAD_RUN_LANE = "upload";

const UPLOAD_PROVIDERS = new Set<string>(["jev", "gateway"]);
const UPLOAD_GATE_KEYS: (keyof BsGates)[] = ["bsAt", "cleanAt", "maliceBlockAt", "payoffFloor", "lowConfBump"];

function isFiniteNum(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function isUsageShape(x: unknown): x is Usage {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const u = x as Record<string, unknown>;
  return isFiniteNum(u.input_tokens) && isFiniteNum(u.output_tokens) &&
    u.input_tokens >= 0 && u.output_tokens >= 0;
}

function isUploadItemShape(x: unknown): x is UploadBatchItem {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const i = x as Record<string, unknown>;
  if (typeof i.id !== "string" || typeof i.label !== "string") return false;
  if (typeof i.origin !== "string" || !UPLOAD_ORIGINS.includes(i.origin as UploadOrigin)) return false;
  if (typeof i.error === "string") return true; // errored items carry only their failure
  if (i.error !== undefined) return false;
  if (typeof i.verdict !== "string" || !BS_VERDICTS.includes(i.verdict as BsVerdict)) return false;
  const s = i.signals as Record<string, unknown> | undefined;
  if (!s || !isFiniteNum(s.bs) || !isFiniteNum(s.malice) || !isFiniteNum(s.payoff) || !isFiniteNum(s.confidence)) {
    return false;
  }
  if (!Array.isArray(i.reasons) || !i.reasons.every((r) => typeof r === "string")) return false;
  return isUsageShape(i.usage);
}

/**
 * Shape + SELF-CONSISTENCY guard: screened must equal the item count,
 * errors the errored items, and the verdict tally must sum to
 * screened − errors. A stored report that lies about its own rows
 * never reloads.
 */
export function isUploadBatchReport(payload: unknown): payload is UploadBatchReport {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const p = payload as Record<string, unknown>;
  if (!Array.isArray(p.items) || !p.items.every(isUploadItemShape)) return false;
  const items = p.items as UploadBatchItem[];

  const t = p.totals as Record<string, unknown> | undefined;
  if (!t || !isFiniteNum(t.screened) || !isFiniteNum(t.errors)) return false;
  const v = t.verdicts as Record<string, unknown> | undefined;
  if (!v || !BS_VERDICTS.every((k) => isFiniteNum(v[k]))) return false;
  if (!isUsageShape(t.usage)) return false;

  const errored = items.filter((i) => typeof i.error === "string").length;
  if (t.screened !== items.length) return false;
  if (t.errors !== errored) return false;
  const tallied = BS_VERDICTS.reduce((n, k) => n + (v[k] as number), 0);
  if (tallied !== items.length - errored) return false;

  const g = p.gates as Record<string, unknown> | undefined;
  if (!g || !UPLOAD_GATE_KEYS.every((k) => isFiniteNum(g[k]))) return false;
  if (typeof p.model !== "string") return false;
  if (typeof p.provider !== "string" || !UPLOAD_PROVIDERS.has(p.provider)) return false;
  return true;
}

/** Recompute the store summary FROM THE ITEMS — never accepted from a caller. */
export function uploadRunSummary(payload: unknown): { compared: number; errors: number } {
  const p = payload as UploadBatchReport;
  return {
    compared: p.items.length,
    errors: p.items.filter((i) => typeof i.error === "string").length,
  };
}

/** The bundled sample lives on the youtube page; this lane imports nothing from it — real data only. */
