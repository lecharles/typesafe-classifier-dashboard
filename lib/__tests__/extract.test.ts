import { describe, it, expect } from "vitest";
import {
  DEFAULT_GATES,
  EXTRACT_STATUS,
  KIND_LEVELS,
  PRECISION_LEVELS,
  STATUS_NOTE,
  STATUS_RANK,
  daysInMonth,
  decideExtractionVerdict,
  detectCandidates,
  extractQuestions,
  extractState,
  extractText,
  isValidDate,
  normalizeDetected,
  normalizeGates,
  runExtractBatch,
  signalsFrom,
  statusBadgeClass,
  type Detected,
  type ExtractGates,
  type ExtractSignals,
  type Normalized,
} from "@/lib/extract";
import { extractionCorpus } from "@/data/extraction-corpus";
import type { Answer, ClassifyResult } from "@/lib/schema";

const choice = (c: string, conf = 0.9): Answer => ({
  type: "choice",
  choice: c,
  probabilities: { [c]: conf },
  confidence: conf,
});
const noul = (p: number): Answer => ({ type: "noul", noul: p });
const score = (s: number, conf = 0.9): Answer => ({
  type: "score",
  score: s,
  probabilities: { [String(Math.round(s))]: conf },
  confidence: conf,
});

function fakeResult(answers: Record<string, Answer>): ClassifyResult {
  return {
    answers,
    usage: { input_tokens: 10, output_tokens: 5 },
    model: "jev-test",
    provider: "gateway",
  };
}

function extractAnswers(
  over: Partial<{ kind: Answer; precision: Answer; ambiguous: Answer }> = {},
) {
  return {
    kind: choice("date"),
    precision: score(4),
    ambiguous: noul(0.05),
    ...over,
  } as Record<string, Answer>;
}

const sig = (over: Partial<ExtractSignals> = {}): ExtractSignals => ({
  kind: "date",
  precision: 4,
  ambiguous: 0.1,
  confidence: 0.9,
  ...over,
});

const clean: Normalized = { value: "2026-11-20" };

describe("UC#8 extraction statuses + questions", () => {
  it("status ladder is strictly ordered resolved < guessed < vague < rejected", () => {
    expect(EXTRACT_STATUS).toEqual(["resolved", "guessed", "vague", "rejected"]);
    expect(STATUS_RANK.resolved).toBeLessThan(STATUS_RANK.guessed);
    expect(STATUS_RANK.guessed).toBeLessThan(STATUS_RANK.vague);
    expect(STATUS_RANK.vague).toBeLessThan(STATUS_RANK.rejected);
  });

  it("every status has a badge class and a note", () => {
    expect(statusBadgeClass("resolved")).toBe("good");
    expect(statusBadgeClass("guessed")).toBe("warn");
    expect(statusBadgeClass("vague")).toBe("warn");
    expect(statusBadgeClass("rejected")).toBe("bad");
    for (const s of EXTRACT_STATUS) expect(STATUS_NOTE[s]).toMatch(/\w/);
  });

  it("questions declare one Choice (3 options) + one Score (5 levels) + one Noul", () => {
    const qs = extractQuestions();
    expect(Object.keys(qs).sort()).toEqual(["ambiguous", "kind", "precision"]);
    expect(qs.kind.type).toBe("choice");
    expect(qs.kind.type === "choice" && Object.keys(qs.kind.criteria).sort()).toEqual(
      ["date", "money", "other"],
    );
    expect(qs.precision.type).toBe("score");
    expect(qs.precision.type === "score" && qs.precision.criteria).toEqual(PRECISION_LEVELS);
    expect(PRECISION_LEVELS).toHaveLength(5);
    expect(KIND_LEVELS).toEqual(["date", "money", "other"]);
    expect(qs.ambiguous.type).toBe("noul");
    expect(qs.ambiguous.type === "noul" && qs.ambiguous.criteria?.true).toMatch(/reading/i);
  });

  it("default gates order the ladder sanely and normalizeGates merges", () => {
    expect(DEFAULT_GATES.resolveAt).toBeGreaterThan(0);
    expect(DEFAULT_GATES.resolveAt).toBeLessThan(PRECISION_LEVELS.length);
    expect(DEFAULT_GATES.ambiguousFloor).toBeGreaterThanOrEqual(0.5);
    expect(normalizeGates({ ambiguousFloor: 0.9 })).toEqual({
      ...DEFAULT_GATES,
      ambiguousFloor: 0.9,
    });
    expect(normalizeGates()).toEqual(DEFAULT_GATES);
  });
});

describe("UC#8 signalsFrom validation — declared-set discipline", () => {
  it("extracts signals from a full answer set", () => {
    const s = signalsFrom(extractAnswers({ precision: score(3, 0.85) }));
    expect(s).toEqual({ kind: "date", precision: 3, ambiguous: 0.05, confidence: 0.85 });
  });

  it("accepts fractional scores inside the declared levels", () => {
    expect(signalsFrom(extractAnswers({ precision: score(3.5) })).precision).toBe(3.5);
  });

  it("throws on undeclared or wrong-type kind", () => {
    expect(() => signalsFrom(extractAnswers({ kind: choice("timestamp") }))).toThrow(
      /outside the declared options/,
    );
    expect(() => signalsFrom(extractAnswers({ kind: score(1) }))).toThrow(
      /outside the declared options/,
    );
    const missing = extractAnswers();
    delete missing.kind;
    expect(() => signalsFrom(missing)).toThrow(/outside the declared options/);
  });

  it("throws on out-of-range precision or non-probability ambiguity", () => {
    expect(() => signalsFrom(extractAnswers({ precision: score(5) }))).toThrow(
      /outside the declared levels/,
    );
    expect(() => signalsFrom(extractAnswers({ precision: score(Number.NaN) }))).toThrow(
      /outside the declared levels/,
    );
    expect(() => signalsFrom(extractAnswers({ precision: noul(0.5) }))).toThrow(
      /outside the declared levels/,
    );
    expect(() => signalsFrom(extractAnswers({ ambiguous: score(1) }))).toThrow(/ambiguous/);
    expect(() => signalsFrom(extractAnswers({ ambiguous: noul(1.5) }))).toThrow(/ambiguous/);
  });
});

describe("UC#8 code detection — messy tokens found by grammar", () => {
  it("detects ISO, numeric, month-name, relative, and money tokens in one snippet", () => {
    const dets = detectCandidates(
      "Signed 2026-11-20T14:30:00Z, invoice 11/25/2026, kickoff Nov 3 2026, follow-up next Friday, paid $1,200.50 plus €3m deposit.",
    );
    const tokens = dets.map((x) => x.token);
    expect(tokens).toContain("2026-11-20T14:30:00Z");
    expect(tokens).toContain("11/25/2026");
    expect(tokens).toContain("Nov 3 2026");
    expect(tokens).toContain("next Friday");
    expect(tokens).toContain("$1,200.50");
    expect(tokens).toContain("€3m");
    expect(dets.find((x) => x.token === "$1,200.50")?.kind).toBe("money");
    expect(dets.find((x) => x.token === "11/25/2026")?.kind).toBe("date");
    expect(dets.every((x, i) => i === 0 || x.index >= dets[i - 1].index)).toBe(true);
  });

  it("ISO spans are claimed first — a numeric pass never tears 2026-11-20 apart", () => {
    const dets = detectCandidates("deadline 2026-11-20 firm");
    expect(dets).toHaveLength(1);
    expect(dets[0].token).toBe("2026-11-20");
    expect(dets[0].shape).toMatchObject({ shape: "iso", y: 2026, mo: 11, d: 20 });
  });

  it("non-values never become candidates", () => {
    expect(detectCandidates("Lunch soon, nothing was charged.")).toHaveLength(0);
    expect(detectCandidates("running 512 GB on Node 25, http://10.0.3.1")).toHaveLength(0);
  });

  it("currency codes in both positions and multipliers are money", () => {
    const dets = detectCandidates("fee GBP 250, later 1200 EUR, cap $2b");
    expect(dets.map((d) => d.token)).toEqual(["GBP 250", "1200 EUR", "$2b"]);
    expect(dets.every((d) => d.kind === "money")).toBe(true);
  });
});

describe("UC#8 validate-in-code — real calendar, real numbers", () => {
  it("leap rules: 2028-02-29 valid, 2026-02-29 and 2026-02-30 never are", () => {
    expect(isValidDate(2028, 2, 29)).toBe(true);
    expect(isValidDate(2026, 2, 29)).toBe(false);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2100, 2)).toBe(28); // century non-leap
    expect(daysInMonth(2000, 2)).toBe(29); // 400-rule leap
    const norm = normalizeDetected(
      { token: "2026-02-30", kind: "date", shape: { shape: "iso", y: 2026, mo: 2, d: 30 }, index: 0 },
      "2026-11-18",
    );
    expect(norm.parseError).toMatch(/not a real calendar date/);
    expect(norm.value).toBeNull();
  });

  it("ISO normalization keeps time + zone as written", () => {
    const d: Detected = {
      token: "2027-01-05T00:00:00Z",
      kind: "date",
      shape: { shape: "iso", y: 2027, mo: 1, d: 5, hh: "00", mi: "00", ss: "00", tz: "Z" },
      index: 0,
    };
    expect(normalizeDetected(d).value).toBe("2027-01-05T00:00:00Z");
  });

  it("numeric dates disambiguate by validity, both-orders-invalid is refused", () => {
    const num = (a: number, b: number, y: number, two = false): Detected => ({
      token: `${a}/${b}/${y}`,
      kind: "date",
      shape: { shape: "numeric", a, b, y, twoDigitYear: two },
      index: 0,
    });
    expect(normalizeDetected(num(11, 25, 2026)).value).toBe("2026-11-25"); // b>12 → M/D
    expect(normalizeDetected(num(31, 12, 2026)).value).toBe("2026-12-31"); // a>12 → D/M
    expect(normalizeDetected(num(13, 45, 2026)).parseError).toMatch(/no valid month/);
    expect(normalizeDetected(num(2, 30, 2026)).parseError).toMatch(/not a real calendar date/);
  });

  it("both ≤ 12 adopts MM/DD and floors to guessed — the convention is flagged, never clean", () => {
    const d: Detected = {
      token: "03/04/2026",
      kind: "date",
      shape: { shape: "numeric", a: 3, b: 4, y: 2026, twoDigitYear: false },
      index: 0,
    };
    const norm = normalizeDetected(d);
    expect(norm.value).toBe("2026-03-04");
    expect(norm.codeFloor).toBe("guessed");
    expect(norm.note).toMatch(/MM\/DD\/YYYY convention chosen/);
  });

  it("two-digit years expand, and the expansion is noted", () => {
    const d: Detected = {
      token: "07/01/26",
      kind: "date",
      shape: { shape: "numeric", a: 7, b: 1, y: 26, twoDigitYear: true },
      index: 0,
    };
    const norm = normalizeDetected(d, "2026-11-18");
    expect(norm.value).toBe("2026-07-01");
    expect(norm.note).toMatch(/expanded to 2026/);
  });

  it("month-name dates are deterministic; February 30, 2026 is refused", () => {
    const dets = detectCandidates("due Nov 3 2026, rescheduled February 30, 2026");
    expect(dets).toHaveLength(2);
    expect(normalizeDetected(dets[0]).value).toBe("2026-11-03");
    expect(normalizeDetected(dets[1]).parseError).toMatch(/not a real calendar date/);
  });

  it("money normalizes to CODE + 2dp with multiplier shorthand applied", () => {
    const dets = detectCandidates("paid $1,200.50; deposit €3m; cap $2b");
    expect(normalizeDetected(dets[0], "2026-11-18").value).toBe("USD 1200.50");
    expect(normalizeDetected(dets[1], "2026-11-18").value).toBe("EUR 3000000.00");
    expect(normalizeDetected(dets[1], "2026-11-18").note).toMatch(/shorthand 'm'/);
    expect(normalizeDetected(dets[2], "2026-11-18").value).toBe("USD 2000000000.00");
  });

  it("relatives pin against an anchor — tomorrow, next Friday, in 30 days, next month clamp", () => {
    const rel = (token: string, shape: Detected["shape"]): Detected => ({
      token,
      kind: "date",
      shape,
      index: 0,
    });
    expect(
      normalizeDetected(rel("tomorrow", { shape: "relative", rel: "tomorrow" }), "2026-11-18").value,
    ).toBe("2026-11-19");
    const fri = normalizeDetected(
      rel("next Friday", { shape: "relative", rel: "next-weekday", weekday: 5 }),
      "2026-11-18",
    );
    expect(fri.value).toBe("2026-11-20"); // Wed 11-18 → Fri 11-20
    expect(
      normalizeDetected(
        rel("in 30 days", { shape: "relative", rel: "in-days", n: 30 }),
        "2026-11-18",
      ).value,
    ).toBe("2026-12-18");
    const clamp = normalizeDetected(
      rel("next month", { shape: "relative", rel: "in-months", n: 1 }),
      "2026-01-31",
    );
    expect(clamp.value).toBe("2026-02-28");
    expect(clamp.codeFloor).toBe("guessed");
    expect(clamp.note).toMatch(/clamped/i);
  });

  it("a relative WITHOUT an anchor is code-floored to vague — value never invented", () => {
    const norm = normalizeDetected({
      token: "tomorrow",
      kind: "date",
      shape: { shape: "relative", rel: "tomorrow" },
      index: 0,
    });
    expect(norm.value).toBeNull();
    expect(norm.codeFloor).toBe("vague");
    expect(norm.note).toMatch(/no reference date/);
  });

  it("a bad anchor is a hard error — never silent drift", () => {
    expect(() =>
      normalizeDetected(
        { token: "tomorrow", kind: "date", shape: { shape: "relative", rel: "tomorrow" }, index: 0 },
        "tomorrow",
      ),
    ).toThrow(/anchor is not a valid ISO date/);
  });
});

describe("UC#8 in-code status ladder", () => {
  it("sharp + agreeing + unambiguous → RESOLVED with the canonical value", () => {
    const d = decideExtractionVerdict(sig(), clean, "date");
    expect(d.status).toBe("resolved");
    expect(d.value).toBe("2026-11-20");
    expect(d.reasons[d.reasons.length - 1]).toContain("resolved (");
  });

  it("precision below the resolve gate → VAGUE, and the value is NOT emitted", () => {
    const d = decideExtractionVerdict(sig({ precision: 2 }), clean, "date");
    expect(d.status).toBe("vague");
    expect(d.value).toBeNull();
    expect(d.reasons.join(" ")).toMatch(/too coarse or unanchored/);
  });

  it("validate-in-code floor is absolute — rejected even at razor-sharp signals", () => {
    const d = decideExtractionVerdict(
      sig({ precision: 4 }),
      { value: null, parseError: "2026-02-30 is not a real calendar date" },
      "date",
    );
    expect(d.status).toBe("rejected");
    expect(d.value).toBeNull();
    expect(d.reasons.join(" ")).toMatch(/validate-in-code/);
  });

  it("code-chosen convention floors resolved to guessed — flagged, never clean", () => {
    const d = decideExtractionVerdict(
      sig(),
      {
        value: "2026-03-04",
        note: "both components ≤ 12 — MM/DD/YYYY convention chosen",
        codeFloor: "guessed",
      },
      "date",
    );
    expect(d.status).toBe("guessed");
    expect(d.value).toBe("2026-03-04"); // emitted, but flagged
    expect(d.reasons.join(" ")).toMatch(/code floor guessed/);
  });

  it("a vague base is never RESCUED by a guessed floor", () => {
    const d = decideExtractionVerdict(
      sig({ precision: 1 }),
      { value: "2026-12-18", note: "next month clamp", codeFloor: "guessed" },
      "date",
    );
    expect(d.status).toBe("vague");
  });

  it("kind disagreement caps resolved to guessed — the reader can flag but not fabricate", () => {
    const d = decideExtractionVerdict(sig({ kind: "other" }), { value: "USD 500.00" }, "money");
    expect(d.status).toBe("guessed");
    expect(d.value).toBe("USD 500.00");
    expect(d.reasons.join(" ")).toMatch(/kind disagreement/);
  });

  it("ambiguity at or above the floor caps resolved to guessed (exact boundary)", () => {
    expect(decideExtractionVerdict(sig({ ambiguous: DEFAULT_GATES.ambiguousFloor }), clean, "date").status).toBe(
      "guessed",
    );
    expect(
      decideExtractionVerdict(sig({ ambiguous: DEFAULT_GATES.ambiguousFloor - 0.01 }), clean, "date").status,
    ).toBe("resolved");
  });

  it("ambiguity never escalates a vague base toward rejected", () => {
    const d = decideExtractionVerdict(
      sig({ precision: 1, ambiguous: 0.99 }),
      clean,
      "date",
    );
    expect(d.status).toBe("vague");
  });

  it("low confidence demotes resolved to guessed, NEVER past guessed", () => {
    const d = decideExtractionVerdict(sig({ confidence: 0.2 }), clean, "date");
    expect(d.status).toBe("guessed");
    expect(d.reasons.join(" ")).toMatch(/ships flagged, never silently/);
    const onVague = decideExtractionVerdict(
      sig({ precision: 1, confidence: 0.2 }),
      clean,
      "date",
    );
    expect(onVague.status).toBe("vague");
  });

  it("sliders are honored: raising resolveAt demotes, raising the floors spares", () => {
    const strict: ExtractGates = { ...DEFAULT_GATES, resolveAt: 3.5 };
    expect(decideExtractionVerdict(sig({ precision: 3 }), clean, "date", strict).status).toBe(
      "vague",
    );
    const relaxed: ExtractGates = { ...DEFAULT_GATES, ambiguousFloor: 0.95 };
    expect(
      decideExtractionVerdict(sig({ ambiguous: 0.7 }), clean, "date", relaxed).status,
    ).toBe("resolved");
  });

  it("convention notes ride in the reasons for guessed outputs", () => {
    const d = decideExtractionVerdict(
      sig({ ambiguous: 0.8 }),
      { value: "USD 5000.00", note: "magnitude shorthand 'k' applied (×1000)" },
      "money",
    );
    expect(d.status).toBe("guessed");
    expect(d.reasons.join(" ")).toMatch(/convention: magnitude shorthand 'k'/);
  });
});

describe("UC#8 live single-text extraction", () => {
  it("extractState frames text + candidate for the classifier", () => {
    expect(extractState("due 11/20/2026", "11/20/2026")).toBe(
      "TEXT:\ndue 11/20/2026\n\nCANDIDATE:\n11/20/2026",
    );
  });

  it("classifies every detected candidate and sums usage", async () => {
    const states: string[] = [];
    const classifyFn = (async (req: { state: string }) => {
      states.push(req.state);
      return fakeResult(extractAnswers());
    }) as never;
    const out = await extractText("sign 11/20/2026 for $1,200.50", {
      classifyFn,
      anchor: "2026-11-18",
    });
    expect(out.results).toHaveLength(2);
    expect(states).toHaveLength(2);
    expect(states[0]).toMatch(/CANDIDATE:\n11\/20\/2026/);
    expect(out.usage).toEqual({ input_tokens: 20, output_tokens: 10 });
    expect(out.model).toBe("jev-test");
    expect(out.anchor).toBe("2026-11-18");
  });

  it("an invalid date is REJECTED live even when the reader is razor-sharp", async () => {
    const classifyFn = (async () => fakeResult(extractAnswers())) as never;
    const out = await extractText("payroll closes 2026-02-30", {
      classifyFn,
      anchor: "2026-11-18",
    });
    expect(out.results[0].status).toBe("rejected");
    expect(out.results[0].value).toBeNull();
    expect(out.results[0].reasons.join(" ")).toMatch(/validate-in-code/);
  });

  it("a relative pinned to an anchor yields a canonical date in the live path", async () => {
    const classifyFn = (async () => fakeResult(extractAnswers())) as never;
    const out = await extractText("kickoff tomorrow", {
      classifyFn,
      anchor: "2026-11-18",
    });
    expect(out.results[0].normalized.value).toBe("2026-11-19");
    // the reader calls it relative (precision 1) → VAGUE despite the pin
    const coarse = (async () =>
      fakeResult(extractAnswers({ precision: score(1) }))) as never;
    const vagueOut = await extractText("kickoff tomorrow", {
      classifyFn: coarse,
      anchor: "2026-11-18",
    });
    expect(vagueOut.results[0].status).toBe("vague");
    expect(vagueOut.results[0].value).toBeNull();
  });

  it("zero candidates is a clean empty result — nothing extracted, never fabricated", async () => {
    const classifyFn = (async () => {
      throw new Error("must not classify when no candidates exist");
    }) as never;
    const out = await extractText("see you soon-ish", { classifyFn });
    expect(out.results).toEqual([]);
  });

  it("a bad anchor fails fast", async () => {
    const classifyFn = (async () => fakeResult(extractAnswers())) as never;
    await expect(
      extractText("due 11/20/2026", { classifyFn, anchor: "soon" }),
    ).rejects.toThrow(/anchor is not a valid ISO date/);
  });

  it("attaches the dev trace when asked, and omits it otherwise", async () => {
    const traceResult = (answers: Record<string, Answer>): ClassifyResult => ({
      ...fakeResult(answers),
      trace: { provider_used: "gateway", endpoint: "x", request: {}, attempts: [], retries: 0 },
    });
    const classifyFn = (async () => traceResult(extractAnswers())) as never;
    const dev = await extractText("due 11/20/2026", { classifyFn, trace: true });
    expect(dev.trace).toBeDefined();
    const plain = await extractText("due 11/20/2026", { classifyFn });
    expect(plain.trace).toBeUndefined();
  });

  it("propagates classifier errors and validator hard-fails — no silent values", async () => {
    const boom = (async () => {
      throw new Error("gateway down");
    }) as never;
    await expect(extractText("due 11/20/2026", { classifyFn: boom })).rejects.toThrow(
      /gateway down/,
    );
    const bad = (async () => fakeResult({ kind: choice("date") })) as never;
    await expect(extractText("due 11/20/2026", { classifyFn: bad })).rejects.toThrow(
      /outside the declared levels/,
    );
  });
});

describe("UC#8-live runExtractBatch (snippet ladder 5 → 10 → All)", () => {
  // 12 synthetic snippets exercising every rung of the ladder.
  const snippets = [
    { id: "s1", text: "durable deadline 11/20/2026" },
    { id: "s2", text: "fee $1,200.50 approved" },
    { id: "s3", text: "boom on 2026-05-01 please" },
    { id: "s4", text: "sign 03/04/2026 renewal" },
    { id: "s5", text: "no values in this note at all" },
    { id: "s6", text: "payroll 2026-02-30 is a trap" },
    { id: "s7", text: "kickoff tomorrow" },
    { id: "s8", text: "deposit €3m wired" },
    { id: "s9", text: "event February 30, 2026" },
    { id: "s10", text: "form due 07/01/26" },
    { id: "s11", text: "paid 1200 EUR today" },
    { id: "s12", text: "sync next month, then 2026-09-14" },
  ];

  const fakeFn = (async (req: { state: string }) => {
    if (req.state.includes("boom")) throw new Error("gateway down for s3");
    if (req.state.includes("11/20/2026"))
      return fakeResult(extractAnswers({ kind: choice("date"), precision: score(4) }));
    if (req.state.includes("2026-02-30") || req.state.includes("February 30, 2026"))
      return fakeResult(extractAnswers({ precision: score(4) })); // sharp but code refuses
    if (req.state.includes("03/04/2026") || req.state.includes("07/01/26"))
      return fakeResult(extractAnswers({ precision: score(3) }));
    if (req.state.includes("tomorrow") || req.state.includes("next month"))
      return fakeResult(extractAnswers({ precision: score(1) }));
    if (req.state.includes("€3m"))
      return fakeResult(extractAnswers({ kind: choice("other") })); // kind disagreement
    if (req.state.includes("1200 EUR"))
      return fakeResult(extractAnswers({ precision: score(4), ambiguous: noul(0.1) }));
    if (req.state.includes("$1,200.50"))
      return fakeResult(extractAnswers({ kind: choice("money"), precision: score(4) }));
    return fakeResult(extractAnswers({ precision: score(3) }));
  }) as never;

  it("processes the first ladder rung by default", async () => {
    const report = await runExtractBatch(snippets, {
      classifyFn: fakeFn,
      anchor: "2026-11-18",
    });
    expect(report.totals.snippets).toBe(5);
    expect(report.items.map((x) => x.id)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
  });

  it("limit 10 widens the ladder; limit null runs All; past-length is clamped", async () => {
    const ten = await runExtractBatch(snippets, { classifyFn: fakeFn, limit: 10, anchor: "2026-11-18" });
    expect(ten.totals.snippets).toBe(10);
    const all = await runExtractBatch(snippets, { classifyFn: fakeFn, limit: null, anchor: "2026-11-18" });
    expect(all.totals.snippets).toBe(12);
    const clamped = await runExtractBatch(snippets, { classifyFn: fakeFn, limit: 40, anchor: "2026-11-18" });
    expect(clamped.totals.snippets).toBe(12);
  });

  it("errors are isolated per snippet — one boom never aborts the batch", async () => {
    const report = await runExtractBatch(snippets, { classifyFn: fakeFn, limit: null, anchor: "2026-11-18" });
    expect(report.totals.errors).toBe(1);
    const failed = report.items.find((x) => x.error);
    expect(failed?.id).toBe("s3");
    expect(failed?.results).toBeUndefined();
    expect(report.items.filter((x) => !x.error)).toHaveLength(11);
  });

  it("status tallies are decided IN CODE across every candidate", async () => {
    const report = await runExtractBatch(snippets, { classifyFn: fakeFn, limit: null, anchor: "2026-11-18" });
    const { statuses } = report.totals;
    // RESOLVED: s1 (forced M/D), s2 (money agrees), s11's "today" (pinned,
    //   reader sharp) — plus nothing else.
    // GUESSED: s4 + s10 (MM/DD conventions), s8 ("€3m" kind disagreement),
    //   s11's "1200 EUR" (reader says date for a money token).
    // VAGUE: s7 "tomorrow" at precision 1 (a pin exists but the reader
    //   calls it relative), both s12 candidates (snippet branch pins
    //   precision 1 — the ISO too).
    // REJECTED: s6 + s9 — invalid calendar, razor-sharp reader be damned.
    expect(statuses).toEqual({ resolved: 3, guessed: 4, vague: 3, rejected: 2 });
    expect(report.totals.candidates).toBe(12);
    expect(
      statuses.resolved + statuses.guessed + statuses.vague + statuses.rejected,
    ).toBe(report.totals.candidates);
    const byId = (id: string) => report.items.find((x) => x.id === id);
    expect(byId("s4")?.results?.[0].value).toBe("2026-03-04"); // flagged convention
    expect(byId("s6")?.results?.[0].status).toBe("rejected"); // Feb 30 never ships
    expect(byId("s6")?.results?.[0].value).toBeNull();
    expect(byId("s5")?.results).toEqual([]);
    expect(byId("s8")?.results?.[0].value).toBe("EUR 3000000.00"); // flagged, not fabricated
    expect(byId("s8")?.results?.[0].status).toBe("guessed");
  });

  it("values flow only for resolved/guessed, anchors + gates ride the report", async () => {
    const report = await runExtractBatch(snippets, {
      classifyFn: fakeFn,
      limit: null,
      anchor: "2026-11-18",
      gates: { resolveAt: 3.5 },
    });
    expect(report.anchor).toBe("2026-11-18");
    expect(report.gates).toEqual(normalizeGates({ resolveAt: 3.5 }));
    // with a stricter resolve gate, precision-3 items fall off the ladder
    // even where a convention had produced a value — no pin, no ship.
    const s4 = report.items.find((x) => x.id === "s4")?.results?.[0];
    expect(s4?.status).toBe("vague");
    expect(s4?.value).toBeNull();
    // precision 4 still clears 3.5 — money agreement unaffected…
    const s2 = report.items.find((x) => x.id === "s2")?.results?.[0];
    expect(s2?.status).toBe("resolved");
    // …while s11's money token keeps its kind-disagreement flag
    const s11 = report.items.find((x) => x.id === "s11")?.results;
    expect(s11?.some((c) => c.status === "guessed")).toBe(true);
  });

  it("usage sums across snippets and the model/provider are reported", async () => {
    const report = await runExtractBatch(snippets, { classifyFn: fakeFn, limit: 5, anchor: "2026-11-18" });
    // s1: 1 cand, s2: 1, s3: error, s4: 1, s5: 0 → 3 classify calls × {10↑, 5↓}
    expect(report.totals.usage).toEqual({ input_tokens: 30, output_tokens: 15 });
    expect(report.model).toBe("jev-test");
    expect(report.provider).toBe("gateway");
  });

  it("empty corpus is an empty report, not a crash", async () => {
    const report = await runExtractBatch([], { classifyFn: fakeFn });
    expect(report.totals.snippets).toBe(0);
    expect(report.totals.candidates).toBe(0);
    expect(report.items).toEqual([]);
    expect(report.totals.statuses).toEqual({
      resolved: 0,
      guessed: 0,
      vague: 0,
      rejected: 0,
    });
  });
});

describe("UC#8 shipped snippet corpus", () => {
  it("has unique ids, >10 snippets so the All rung exceeds 10, non-empty texts", () => {
    expect(extractionCorpus.length).toBeGreaterThan(10);
    const ids = extractionCorpus.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of extractionCorpus) expect(s.text.trim().length).toBeGreaterThan(0);
  });

  it("ships every trap: impossible dates, ambiguous orders, relatives, multipliers", () => {
    const joined = extractionCorpus.map((s) => s.text).join(" ");
    expect(joined).toMatch(/2026-02-30|February 30, 2026/); // validate-in-code traps
    expect(joined).toMatch(/03\/04\/2026/); // ambiguous MM/DD
    expect(joined).toMatch(/tomorrow|next Friday|next month|today/); // anchor traps
    expect(joined).toMatch(/\$\d+[kmb]?|€3m/); // money shorthand
    // deterministically: at least one snippet has zero candidates for the
    // "never fabricate" path
    const noTokens = extractionCorpus.filter((s) => detectCandidates(s.text).length === 0);
    expect(noTokens.length).toBeGreaterThanOrEqual(1);
  });

  it("deterministic code-side normalization of the corpus traps under a fixed anchor", () => {
    const detByToken = (needle: string): Detected | undefined =>
      extractionCorpus
        .flatMap((s) => detectCandidates(s.text))
        .find((d) => d.token === needle);
    const trap = detByToken("2026-02-30");
    expect(trap).toBeDefined();
    expect(normalizeDetected(trap!, "2026-11-18").parseError).toMatch(/not a real calendar date/);
    const amb = detByToken("03/04/2026");
    expect(amb).toBeDefined();
    const norm = normalizeDetected(amb!, "2026-11-18");
    expect(norm.value).toBe("2026-03-04");
    expect(norm.codeFloor).toBe("guessed");
    const leap = detByToken("2028-02-29");
    expect(leap).toBeDefined();
    expect(normalizeDetected(leap!, "2026-11-18").value).toBe("2028-02-29");
  });
});
