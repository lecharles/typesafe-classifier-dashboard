// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_ITEMS,
  MAX_TEXT,
  MAX_LABEL,
  UPLOAD_FORMATS,
  OFFICIAL_APIS,
  UPLOAD_RUN_LANE,
  assertOfficialApiUrl,
  officialItemsFrom,
  fetchRealCorpus,
  isUploadBatchReport,
  parseCorpusIntake,
  runUploadBatch,
  uploadExportRows,
  uploadRunSummary,
  type UploadBatchReport,
} from "@/lib/upload";
import { bsBadgeClass, DEFAULT_GATES, type BsTally } from "@/lib/bs";
import { toCSV, toJSON } from "@/lib/export";
import { closeResultsDb, countRuns, loadLatestRun, openResultsDb, saveBatchRun } from "@/lib/sqlite";
import type { Answer, ClassifyResult } from "@/lib/schema";

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const noul = (p: number): Answer => ({ type: "noul", noul: p });
const score = (s: number, conf = 0.9): Answer => ({
  type: "score",
  score: s,
  probabilities: { [String(Math.round(s))]: conf },
  confidence: conf,
});

function fakeResult(answers: Record<string, Answer>, withTrace = false): ClassifyResult {
  return {
    answers,
    usage: { input_tokens: 10, output_tokens: 5 },
    model: "jev-test",
    provider: "gateway",
    ...(withTrace
      ? {
          trace: {
            provider_used: "gateway" as const,
            endpoint: "/v1/systemone",
            request: { q: 1 },
            response: { a: 1 },
            attempts: [{ status: 200 }],
            retries: 0,
          },
        }
      : {}),
  };
}

/** Content-keyed fake: "verify"/"FREE" reads bait, "gg"/"thanks" reads clean. */
function contentClassifier() {
  return (async (req: { state: string }) => {
    const s = req.state.toLowerCase();
    if (s.includes("verify") || s.includes("free money")) {
      return fakeResult({ bs: score(4.2, 0.95), malice: noul(0.9), payoff: noul(0.2) });
    }
    if (s.includes("maybe")) {
      return fakeResult({ bs: score(2.0, 0.4), malice: noul(0.2), payoff: noul(0.8) }); // low conf → demoted
    }
    return fakeResult({ bs: score(0.5, 0.9), malice: noul(0.02), payoff: noul(0.9) });
  }) as never;
}

/** Receipt invariant: rows === kept + rejected + duplicates + blankSkipped + capDropped. */
function expectBalanced(intake: ReturnType<typeof parseCorpusIntake>) {
  const c = intake.counts;
  expect(c.rows).toBe(c.kept + c.rejected + c.duplicates + c.blankSkipped + c.capDropped);
  expect(c.kept).toBe(intake.items.length);
  expect(c.rejected).toBe(intake.rejected.length);
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/* ------------------------------------------------------------------ *
 * Intake: THE PARSER NEVER TRUSTS THE PAYLOAD.
 * ------------------------------------------------------------------ */

describe("real-corpora intake — text format", () => {
  it("one item per line, deterministic ids, origin stamped", () => {
    const out = parseCorpusIntake("hello there\nsecond row\nthird row", "text", { origin: "paste" });
    expect(out.items.map((i) => i.id)).toEqual(["u-1", "u-2", "u-3"]);
    expect(out.items[1].text).toBe("second row");
    expect(out.items.every((i) => i.origin === "paste")).toBe(true);
    expect(out.headerError).toBeNull();
    expectBalanced(out);
  });

  it("blank lines are SKIPPED AND COUNTED, and kept rows keep their ORIGINAL line numbers", () => {
    const out = parseCorpusIntake("row one\n\n\n   \nrow five", "text");
    expect(out.counts.blankSkipped).toBe(3);
    expect(out.items.map((i) => i.id)).toEqual(["u-1", "u-5"]);
    expectBalanced(out);
  });

  it("rejects carry the original line number in the receipt", () => {
    const out = parseCorpusIntake("fine\n   \nalso fine\n" + "x".repeat(MAX_TEXT + 1) + "\ntail", "text");
    expect(out.items.map((i) => i.id)).toEqual(["u-1", "u-3", "u-5"]);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0].row).toBe(4);
    expect(out.rejected[0].reason).toContain(String(MAX_TEXT));
    expectBalanced(out);
  });

  it("CRLF + BOM never leak into the corpus", () => {
    const out = parseCorpusIntake("\uFEFFfirst line\r\nsecond line\r\n", "text");
    expect(out.items[0].text).toBe("first line");
    expect(out.items[1].text).toBe("second line");
    expect(out.items[0].text).not.toContain("\uFEFF");
    expect(out.items[0].text).not.toContain("\r");
    expectBalanced(out);
  });

  it("labels are display-only: long labels ride clipped, never rejected", () => {
    const out = parseCorpusIntake("body text", "text");
    expect(out.items[0].label.length).toBeLessThanOrEqual(MAX_LABEL);
    expectBalanced(out);
  });

  it("duplicates are dropped AND counted — first one wins", () => {
    const out = parseCorpusIntake("same text\nSAME   text\ndifferent\nsame text", "text");
    expect(out.counts.duplicates).toBe(2);
    expect(out.items).toHaveLength(2);
    expectBalanced(out);
  });

  it("over MAX_ITEMS the cap is VISIBLE: kept head + capDropped counted, never silent", () => {
    const lines = Array.from({ length: MAX_ITEMS + 7 }, (_, i) => `unique row ${i}`).join("\n");
    const out = parseCorpusIntake(lines, "text");
    expect(out.items).toHaveLength(MAX_ITEMS);
    expect(out.counts.capDropped).toBe(7);
    expectBalanced(out);
  });

  it("non-string payloads and unknown formats are refused outright", () => {
    const out = parseCorpusIntake(42 as never, "text");
    expect(out.headerError).toBe("payload is not text");
    expect(out.items).toHaveLength(0);
    expect(() => parseCorpusIntake("x", "xml" as never)).toThrow(/unknown format/);
    expect(UPLOAD_FORMATS).toEqual(["text", "csv", "json"]);
  });
});

describe("real-corpora intake — csv format", () => {
  it("quote-aware parsing: commas, escaped quotes, and newlines inside quotes", () => {
    const csv = 'id,text,label\na1,"hello, ""world""\nsecond line",greeting\na2,plain,x';
    const out = parseCorpusIntake(csv, "csv");
    expect(out.items).toHaveLength(2);
    expect(out.items[0].id).toBe("a1");
    expect(out.items[0].text).toBe('hello, "world"\nsecond line');
    expect(out.items[0].label).toBe("greeting");
    expectBalanced(out);
  });

  it('header without a "text" column refuses the WHOLE file', () => {
    const out = parseCorpusIntake("subject,body\nhi,there", "csv");
    expect(out.headerError).toMatch(/"text" column/);
    expect(out.items).toHaveLength(0);
  });

  it("column-count mismatches are rejected with their ORIGINAL row number", () => {
    const out = parseCorpusIntake("text,extra\nfine,a\nbroken\nlast,b", "csv");
    expect(out.items).toHaveLength(2);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0].row).toBe(2);
    expect(out.rejected[0].reason).toMatch(/column count mismatch \(1 vs 2\)/);
    expect(out.items[1].id).toBe("u-3");
    expectBalanced(out);
  });

  it("empty csv is a file-level refusal, not zero imaginary rows", () => {
    const out = parseCorpusIntake("", "csv");
    expect(out.headerError).toBe("empty csv");
    expect(out.items).toHaveLength(0);
  });

  it("header columns are matched case/whitespace-insensitively", () => {
    const out = parseCorpusIntake(" ID , Text \nx1, hello ", "csv");
    expect(out.items).toHaveLength(1);
    expect(out.items[0].id).toBe("x1");
    expectBalanced(out);
  });
});

describe("real-corpora intake — json format", () => {
  it("accepts a mixed array of strings and objects", () => {
    const out = parseCorpusIntake(JSON.stringify(["plain string", { id: "j2", text: "object row", label: "L" }]), "json");
    expect(out.items).toHaveLength(2);
    expect(out.items[0].id).toBe("u-1");
    expect(out.items[1].id).toBe("j2");
    expect(out.items[1].label).toBe("L");
    expectBalanced(out);
  });

  it("a root object (not an array) refuses the file", () => {
    const out = parseCorpusIntake('{"items": []}', "json");
    expect(out.headerError).toBe("JSON root must be an array");
  });

  it("broken JSON is a file-level refusal with a preview", () => {
    const out = parseCorpusIntake("{oops", "json");
    expect(out.headerError).toBe("not valid JSON");
  });

  it("rows that are neither text nor objects are rejected with row numbers", () => {
    const out = parseCorpusIntake('[ 7, ["a","b"], null, {"nope": 1}, {"text": "ok"} ]', "json");
    expect(out.items).toHaveLength(1);
    expect(out.rejected).toHaveLength(4);
    expect(out.rejected.map((r) => r.row)).toEqual([1, 2, 3, 4]);
    expect(out.rejected[3].reason).toMatch(/no "text" string/);
    expectBalanced(out);
  });

  it("a content alias rides like text (cookbook exports use it)", () => {
    const out = parseCorpusIntake('[{"content": "legacy field"}]', "json");
    expect(out.items[0].text).toBe("legacy field");
    expectBalanced(out);
  });
});

describe("real-corpora intake — shared guards", () => {
  it("empty / whitespace-only text is rejected, visibly", () => {
    const out = parseCorpusIntake('["   ", "ok"]', "json");
    expect(out.items).toHaveLength(1);
    expect(out.rejected[0].reason).toBe("empty text");
    expectBalanced(out);
  });

  it("over-MAX_TEXT rows are REJECTED, never silently clipped", () => {
    const out = parseCorpusIntake(JSON.stringify(["y".repeat(MAX_TEXT + 1)]), "json");
    expect(out.items).toHaveLength(0);
    expect(out.rejected[0].reason).toContain("chars");
    expectBalanced(out);
  });

  it("ids: bad characters, oversize, and duplicates each get their own refusal", () => {
    const out = parseCorpusIntake(
      JSON.stringify([
        { id: "bad id!", text: "one" },
        { id: "z".repeat(121), text: "two" },
        { id: "ok", text: "three" },
        { id: "ok", text: "four" },
      ]),
      "json",
    );
    expect(out.items).toHaveLength(1);
    expect(out.rejected.map((r) => r.reason)).toEqual([
      expect.stringContaining("[A-Za-z0-9._-]"),
      expect.stringContaining("[A-Za-z0-9._-]"),
      expect.stringContaining("duplicate id"),
    ]);
    expectBalanced(out);
  });

  it("id: a non-string id is refused, and an empty string id too", () => {
    const out = parseCorpusIntake('[{"id": 5, "text": "x"}, {"id": "  ", "text": "y"}]', "json");
    expect(out.items).toHaveLength(0);
    expect(out.rejected.every((r) => r.reason.includes("id"))).toBe(true);
    expectBalanced(out);
  });
});

/* ------------------------------------------------------------------ *
 * OFFICIAL APIs ONLY — the no-scraping wall, as code.
 * ------------------------------------------------------------------ */

describe("official-API allowlist wall", () => {
  it("pins https, the exact hostnames, and the /youtube/v3/ path", () => {
    expect(OFFICIAL_APIS.youtube.hosts).toContain("www.googleapis.com");
    expect(assertOfficialApiUrl("https://www.googleapis.com/youtube/v3/search?q=x").ok).toBe(true);
    expect(assertOfficialApiUrl("https://youtube.googleapis.com/youtube/v3/search").ok).toBe(true);
  });

  it("refuses http, junk hosts, suffix-spoof hosts, and lookalike prefixes", () => {
    expect(assertOfficialApiUrl("http://www.googleapis.com/youtube/v3/search").ok).toBe(false);
    expect(assertOfficialApiUrl("https://youtube.com/watch?v=abc").ok).toBe(false); // the FRONTEND, not the API
    expect(assertOfficialApiUrl("https://googleapis.com.evil.tld/youtube/v3/search").ok).toBe(false);
    expect(assertOfficialApiUrl("https://evil-www.googleapis.com/youtube/v3/search").ok).toBe(false);
  });

  it("refuses official hosts OUTSIDE the API path — no scraping side doors", () => {
    const r = assertOfficialApiUrl("https://www.googleapis.com/youtube/v3foo/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/path must live under/);
  });

  it("unparseable urls are refused with a human reason", () => {
    const r = assertOfficialApiUrl("not a url at all");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not a parseable URL");
  });
});

describe("fetchRealCorpus — provenance never lies", () => {
  const KEY = process.env.YOUTUBE_API_KEY;
  function withKey(v: string | undefined, fn: () => void) {
    if (v === undefined) delete process.env.YOUTUBE_API_KEY;
    else process.env.YOUTUBE_API_KEY = v;
    fn();
    if (KEY === undefined) delete process.env.YOUTUBE_API_KEY;
    else process.env.YOUTUBE_API_KEY = KEY;
  }

  it("no key → REFUSED with the honest message; the bundled sample never rides out", async () => {
    let fetched = false;
    const fetchImpl = (async () => {
      fetched = true;
      return {} as Response;
    }) as unknown as typeof fetch;
    const out = await withKeyPromise(undefined, async () =>
      fetchRealCorpus({ query: "espresso", fetchImpl }),
    );
    expect(out.ok).toBe(false);
    expect(fetched).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(400);
      expect(out.error).toMatch(/real data only/);
      expect(out.error).toMatch(/bundled synthetic/);
    }
  });

  function withKeyPromise<T>(v: string | undefined, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((res, rej) => {
      withKey(v, () => fn().then(res, rej));
    });
  }

  it("no query, no channel, no url → refused (never fetches a wildcard)", async () => {
    const out = await withKeyPromise("k", () => fetchRealCorpus({}));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(400);
  });

  it("a scrapish pasted apiUrl is refused BEFORE the wire", async () => {
    let fetched = false;
    const fetchImpl = (async () => {
      fetched = true;
      return {} as Response;
    }) as unknown as typeof fetch;
    const out = await withKeyPromise("k", () =>
      fetchRealCorpus({ apiUrl: "https://www.youtube.com/watch?v=x", fetchImpl }),
    );
    expect(out.ok).toBe(false);
    expect(fetched).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/not an official/);
  });

  it("a pasted key param is STRIPPED and replaced by the server key; the secret never echoes", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return { ok: true, status: 200, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;
    const out = await withKeyPromise("srv-key-999", () =>
      fetchRealCorpus({
        apiUrl: "https://www.googleapis.com/youtube/v3/search?key=pasted-s&part=snippet&type=video",
        fetchImpl,
      }),
    );
    expect(out.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("key=srv-key-999");
    expect(seen[0]).not.toContain("pasted-s");
    // exactly one key on the wire — the server's
    expect((seen[0].match(/key=/g) ?? []).length).toBe(1);
  });

  it("maps real API items into official-api provenance items (title+description)", async () => {
    const payload = {
      items: [
        { id: { videoId: "abc123" }, snippet: { title: "Real title", description: "Real desc" } },
        { id: { kind: "channel" }, snippet: { title: "not a video" } },
        { id: { videoId: "abc123" }, snippet: { title: "dupe video", description: "" } },
      ],
    };
    const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => payload })) as unknown as typeof fetch;
    const out = await withKeyPromise("k", () => fetchRealCorpus({ query: "real stuff", fetchImpl }));
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.api).toBe("YouTube Data API v3");
      expect(out.items).toHaveLength(1);
      expect(out.items[0]).toEqual({
        id: "yt-abc123",
        text: "Real title\n\nReal desc",
        label: "Real title",
        origin: "official-api",
      });
    }
  });

  it("HTTP failure → honest error, zero items, and the message never carries the key", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 403, json: async () => ({}) })) as unknown as typeof fetch;
    const out = await withKeyPromise("super-secret-key", () => fetchRealCorpus({ query: "x", fetchImpl }));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(502);
      expect(out.error).toBe("official API responded HTTP 403");
      expect(out.error).not.toContain("super-secret-key");
    }
  });

  it("network throw → unreachable, not a silent synthetic fallback", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const out = await withKeyPromise("k", () => fetchRealCorpus({ query: "x", fetchImpl }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe("official API unreachable (network)");
  });

  it("maxResults clamps to the API's own ceiling (1..50)", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return { ok: true, status: 200, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;
    await withKeyPromise("k", () => fetchRealCorpus({ query: "x", max: 999, fetchImpl }));
    await withKeyPromise("k", () => fetchRealCorpus({ query: "x", max: 0, fetchImpl }));
    expect(seen[0]).toContain("maxResults=50");
    expect(seen[1]).toContain("maxResults=1");
  });

  it("officialItemsFrom: junk shapes drop, never half-believe", () => {
    expect(officialItemsFrom(undefined)).toEqual([]);
    expect(officialItemsFrom("nope")).toEqual([]);
    expect(officialItemsFrom([null, 7, {}, { id: { videoId: "bad id!" }, snippet: { title: "x" } }])).toEqual([]);
    expect(officialItemsFrom([{ id: { videoId: "ok1" }, snippet: { title: " " } }])).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Screening the upload through the UC#7 ladder.
 * ------------------------------------------------------------------ */

const corpus = [
  { id: "e1", text: "please verify your account now", label: "phish", origin: "paste" as const },
  { id: "e2", text: "FREE MONEY send card number", label: "junk", origin: "paste" as const },
  { id: "e3", text: "maybe later I guess", label: "hedge", origin: "file" as const },
  { id: "e4", text: "thanks for the quick fix!", label: "kind", origin: "paste" as const },
  { id: "e5", text: "gg well played", label: "chat", origin: "official-api" as const },
  { id: "e6", text: "verify verify verify FREE MONEY again", label: "worst", origin: "paste" as const },
];

describe("runUploadBatch — the ladder rides YOUR data", () => {
  it("rung 5 gives exact in-code tallies + usage sums + model/provider", async () => {
    const report = await runUploadBatch(corpus, { classifyFn: contentClassifier(), limit: 5 });
    expect(report.items).toHaveLength(5);
    expect(report.totals.screened).toBe(5);
    expect(report.totals.errors).toBe(0);
    const v: BsTally = report.totals.verdicts;
    expect(v.bs).toBe(2); // e1 verify, e2 FREE MONEY
    expect(v.suspicious).toBe(1); // e3 maybe — low confidence demotion
    expect(v.clean).toBe(2); // e4, e5
    expect(report.totals.usage).toEqual({ input_tokens: 50, output_tokens: 25 });
    expect(report.model).toBe("jev-test");
    expect(report.provider).toBe("gateway");
  });

  it("ladder rungs 5 → 10 → All walk exact prefixes; default is rung 5", async () => {
    const r5 = await runUploadBatch(corpus, { classifyFn: contentClassifier(), limit: 5 });
    const rAll = await runUploadBatch(corpus, { classifyFn: contentClassifier(), limit: null });
    const rDef = await runUploadBatch(corpus, { classifyFn: contentClassifier() });
    const rBig = await runUploadBatch(corpus, { classifyFn: contentClassifier(), limit: 999 });
    expect(r5.items.map((i) => i.id)).toEqual(corpus.slice(0, 5).map((i) => i.id));
    expect(rAll.items).toHaveLength(6);
    expect(rAll.totals.screened).toBe(6);
    expect(rDef.items).toHaveLength(5);
    expect(rBig.items).toHaveLength(6); // clamped to the corpus, never padded
  });

  it("per-item failure is ISOLATED and COUNTED — the batch survives", async () => {
    const boom = (async (req: { state: string }) => {
      if (req.state.includes("verify")) throw new Error("jev exploded");
      return fakeResult({ bs: score(0.5, 0.9), malice: noul(0.02), payoff: noul(0.9) });
    }) as never;
    const report = await runUploadBatch(corpus, { classifyFn: boom, limit: null });
    expect(report.totals.screened).toBe(6);
    expect(report.totals.errors).toBe(2); // e1 + e6 carry verify
    const errored = report.items.filter((i) => i.error);
    expect(errored.map((i) => i.id).sort()).toEqual(["e1", "e6"]);
    expect(errored.every((i) => i.verdict === undefined)).toBe(true);
    // errored rows never feed the tally
    const t = report.totals.verdicts;
    expect(t.clean + t.suspicious + t.bs).toBe(4);
  });

  it("empty corpus: zero items, zero classifier calls, valid empty report", async () => {
    let calls = 0;
    const spy = (async () => {
      calls += 1;
      return fakeResult({ bs: score(0, 0.9), malice: noul(0), payoff: noul(0) });
    }) as never;
    const report = await runUploadBatch([], { classifyFn: spy, limit: null });
    expect(calls).toBe(0);
    expect(report.items).toEqual([]);
    expect(report.totals).toEqual({
      screened: 0,
      errors: 0,
      verdicts: { clean: 0, suspicious: 0, bs: 0 },
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  });

  it("input items are never mutated (purity)", async () => {
    const before = JSON.stringify(corpus);
    await runUploadBatch(corpus, { classifyFn: contentClassifier(), limit: null });
    expect(JSON.stringify(corpus)).toBe(before);
  });

  it("dev trace rides items only when asked; gates echo the merged sliders", async () => {
    const tracey = (async () => fakeResult({ bs: score(0.5, 0.9), malice: noul(0.02), payoff: noul(0.9) }, true)) as never;
    const dev = await runUploadBatch(corpus.slice(0, 2), { classifyFn: tracey, limit: null, trace: true });
    expect(dev.items.every((i) => i.trace !== undefined)).toBe(true);
    const off = await runUploadBatch(corpus.slice(0, 2), { classifyFn: tracey, limit: null });
    expect(off.items.every((i) => i.trace === undefined)).toBe(true);

    const gates = await runUploadBatch(corpus, { classifyFn: contentClassifier(), limit: null, gates: { bsAt: 0.1 } });
    expect(gates.gates.bsAt).toBe(0.1);
    expect(gates.gates.cleanAt).toBe(DEFAULT_GATES.cleanAt); // partial merge, like every lane
    expect(gates.totals.verdicts.bs).toBe(6); // razor gate: everything BS
  });
});

/* ------------------------------------------------------------------ *
 * D8 export surface.
 * ------------------------------------------------------------------ */

describe("upload export — D8 pipeline parity", () => {
  it("stable column order; errored rows ride verdict 'error'; numbers round to 3dp", async () => {
    const boom = (async (req: { state: string }) => {
      if (req.state.includes("boom")) throw new Error("nope");
      if (req.state.includes("verify")) {
        return fakeResult({ bs: score(4.1234, 0.95), malice: noul(0.8752), payoff: noul(0.1234) });
      }
      return fakeResult({ bs: score(0.5, 0.9), malice: noul(0.016), payoff: noul(0.9) });
    }) as never;
    const report = await runUploadBatch(
      [
        { id: "p1", text: "please verify now", label: 'has "quotes", and a comma' },
        { id: "p2", text: "boom state", label: "broken" },
      ],
      { classifyFn: boom, limit: null },
    );
    // p2 errored in isolation, p1 still screened
    const errored = report.items.find((i) => i.id === "p2");
    expect(errored?.error).toBe("nope");

    const rows = uploadExportRows(report.items);
    expect(Object.keys(rows[0])).toEqual(["id", "label", "origin", "verdict", "bs", "malice", "payoff", "confidence", "error"]);
    const csv = toCSV(rows);
    const lines = csv.split(/\r\n/);
    expect(lines[0]).toBe("id,label,origin,verdict,bs,malice,payoff,confidence,error");
    // RFC-style escaping: the quoted, comma-bearing label survives as ONE field
    expect(csv).toContain('"has ""quotes"", and a comma"');
    const json = JSON.parse(toJSON(rows));
    expect(json).toHaveLength(2);
    const p1 = json.find((r: { id: string }) => r.id === "p1");
    expect(p1.verdict).toBe("bs");
    expect(p1.bs).toBe(4.123);
    expect(p1.malice).toBe(0.875);
    expect(p1.payoff).toBe(0.123);
  });

  it("clean rows carry no error; verdict badges reuse the UC#7 classes", () => {
    expect(bsBadgeClass("clean")).toBe("good");
    const rows = uploadExportRows([
      { id: "c1", label: "l", origin: "paste", verdict: "clean", reasons: [], signals: { bs: 0, malice: 0, payoff: 0, confidence: 0.5 } },
    ]);
    expect(rows[0].verdict).toBe("clean");
    expect(rows[0].error).toBe("");
  });
});

/* ------------------------------------------------------------------ *
 * SQLite ride (UC#10-persist store, new lane).
 * ------------------------------------------------------------------ */

describe("upload report — shape + self-consistency guard", () => {
  async function build(): Promise<UploadBatchReport> {
    return runUploadBatch(corpus, { classifyFn: contentClassifier(), limit: null });
  }

  it("a real report passes; the summary is RECOMPUTED from items", async () => {
    const report = await build();
    expect(isUploadBatchReport(report)).toBe(true);
    expect(uploadRunSummary(report)).toEqual({ compared: 6, errors: 0 });
    expect(UPLOAD_RUN_LANE).toBe("upload");
  });

  it("a report that LIES about its own rows never passes", async () => {
    const report = await build();
    const lie = (mut: (p: UploadBatchReport) => void) => {
      const p = JSON.parse(JSON.stringify(report)) as UploadBatchReport;
      mut(p);
      expect(isUploadBatchReport(p)).toBe(false);
    };
    lie((p) => void (p.totals.screened = p.items.length + 1)); // screened disagrees
    lie((p) => void (p.totals.errors = 3)); // errors disagrees
    lie((p) => void (p.totals.verdicts.bs += 1)); // tally sum disagrees
    lie((p) => void ((p.items[0] as Record<string, unknown>).origin = "telegram")); // unknown origin
    lie((p) => void ((p.items[0] as Record<string, unknown>).verdict = "definitely-not"));
    lie((p) => void (p.provider = "sketchy" as never));
    lie((p) => void delete (p as unknown as Record<string, unknown>).gates);
    lie((p) => void ((p.items[1] as Record<string, unknown>).error = "sneaked an error into a screened row"));
    expect(isUploadBatchReport(null)).toBe(false);
    expect(isUploadBatchReport([])).toBe(false);
    expect(isUploadBatchReport({ items: "not even close" })).toBe(false);
  });

  it("errored reports still pass and summarize honestly", async () => {
    const boom = (async (req: { state: string }) => {
      if (req.state.includes("verify")) throw new Error("boom");
      return fakeResult({ bs: score(0.5, 0.9), malice: noul(0.02), payoff: noul(0.9) });
    }) as never;
    const report = await runUploadBatch(corpus, { classifyFn: boom, limit: null });
    expect(isUploadBatchReport(report)).toBe(true);
    expect(uploadRunSummary(report)).toEqual({ compared: 6, errors: 2 });
  });
});

describe("upload reports ride the shared SQLite store", () => {
  const tmps: string[] = [];
  function tmpDb(): string {
    const dir = mkdtempSync(join(tmpdir(), "upload-db-"));
    tmps.push(dir);
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return join(dir, "results.db");
  }

  it("save → reopen the file → the exact run comes back; entities-lane rows stay separate", async () => {
    const report = await runUploadBatch(corpus, { classifyFn: contentClassifier(), limit: 5 });
    const path = tmpDb();
    let db = openResultsDb(path);
    const saved = saveBatchRun(db, {
      lane: UPLOAD_RUN_LANE,
      payload: report,
      guard: isUploadBatchReport,
      summarize: uploadRunSummary,
      limit: 5,
      savedAt: "2026-11-24T09:00:00.000Z",
    });
    closeResultsDb(db);

    db = openResultsDb(path); // a full RESTART — the file is the memory
    const back = loadLatestRun<UploadBatchReport>(db, UPLOAD_RUN_LANE, isUploadBatchReport);
    expect(back).not.toBeNull();
    expect(back!.runId).toBe(saved.runId);
    expect(back!.summary).toEqual({ compared: 5, errors: 0 });
    expect(back!.payload.items.map((i) => i.id)).toEqual(report.items.map((i) => i.id));
    expect(countRuns(db, UPLOAD_RUN_LANE, isUploadBatchReport)).toEqual({ total: 1, readable: 1 });
    closeResultsDb(db);
  });

  it("the store refuses an unguarded payload at WRITE time", async () => {
    const path = tmpDb();
    const db = openResultsDb(path);
    expect(() =>
      saveBatchRun(db, {
        lane: UPLOAD_RUN_LANE,
        payload: { items: [], totals: "trust me" } as never,
        guard: isUploadBatchReport,
        summarize: () => ({ compared: 0, errors: 0 }),
      }),
    ).toThrow(/does not recognize/);
    closeResultsDb(db);
  });
});
