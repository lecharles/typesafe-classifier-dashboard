// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  BUDGET_WARN_SHARE,
  COST_RUN_LANE,
  DEFAULT_BUDGET_USD,
  DEFAULT_RATES,
  RATE_CAP_USD_PER_MTOK,
  buildCostLedger,
  costExportRows,
  costReceiptsFromHarness,
  costReceiptsFromPayload,
  costReceiptsFromStoreRows,
  costRunSummary,
  costUsd,
  isCostSnapshot,
  normalizeRates,
  readBudget,
  type CostRates,
  type CostReceipt,
  type CostSnapshot,
} from "@/lib/cost";
import { toCSV } from "@/lib/export";
import type { HarnessReport } from "@/lib/harness";
import { openResultsDb, saveBatchRun, loadLatestRun, countRuns, scanAllRuns, laneSummaries } from "@/lib/sqlite";

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const SHEET: CostRates = {
  jev: { inputUsdPerMtok: 1, outputUsdPerMtok: 2 },
  gateway: { inputUsdPerMtok: 0.06, outputUsdPerMtok: 0.24 },
};

const R = (
  id: string,
  lane: string,
  provider: "jev" | "gateway",
  items: number,
  input: number,
  output: number,
): CostReceipt => ({
  id,
  source: "manual",
  lane,
  provider,
  items,
  usage: { input_tokens: input, output_tokens: output },
});

/** A minimal VALID entities report (passes isEntityBatchReport). */
function entityReport(usage: { input_tokens: number; output_tokens: number }, provider: "jev" | "gateway") {
  return {
    items: [
      {
        id: "p1",
        a: { id: "a1", name: "Widget 12" },
        b: { id: "b1", name: "Widget 12 Pro" },
        aId: "a1",
        bId: "b1",
        verdict: "distinct",
        reasons: ["conflict floor"],
        signals: { similarity: 4.2, conflict: 0.9, genericName: 0.1, confidence: 0.95 },
        usage,
      },
    ],
    totals: { compared: 1, errors: 0, verdicts: { distinct: 1, review: 0, merge: 0 }, usage },
    clusters: [],
    blocked: [],
    gates: { mergeAt: 4.2, distinctAt: 1.5, conflictFloor: 0.6, collisionCap: 0.6, lowConfBump: 0.6 },
    model: "jev-latest",
    provider,
  };
}

/** A minimal VALID upload report (passes isUploadBatchReport). */
function uploadReport(usage: { input_tokens: number; output_tokens: number }, provider: "jev" | "gateway") {
  return {
    items: [
      {
        id: "u1",
        label: "row 1",
        origin: "paste",
        verdict: "clean",
        reasons: ["clean"],
        signals: { bs: 1.2, malice: 0.1, payoff: 0.8, confidence: 0.9 },
        usage,
      },
    ],
    totals: { screened: 1, errors: 0, verdicts: { clean: 1, suspicious: 0, bs: 0 }, usage },
    gates: { bsAt: 3.5, cleanAt: 1.5, maliceBlockAt: 0.6, payoffFloor: 0.5, lowConfBump: 0.6 },
    model: "jev-latest",
    provider,
  };
}

/** A D14-shaped harness report with per-side live items + usage columns. */
function harnessReport(
  jevOk: number,
  gwOk: number,
  jevUsage: unknown,
  gwUsage: unknown,
): HarnessReport {
  const items = Array.from({ length: Math.max(jevOk, gwOk) }, (_, i) => ({
    id: `h${i}`,
    dataset: "emails",
    jev: { provider: "jev", ok: i < jevOk },
    emulated: { provider: "gateway", ok: i < gwOk },
  }));
  return {
    items,
    totals: { jevUsage, emulatedUsage: gwUsage },
    ladder: [5],
    generatedAt: "2026-11-27T05:00:00.000Z",
  } as unknown as HarnessReport;
}

function snapshotFor(
  receipts: CostReceipt[],
  rates: CostRates = SHEET,
  budgetUsd: number | null = DEFAULT_BUDGET_USD,
  counts?: CostSnapshot["counts"],
): CostSnapshot {
  const c = counts ?? { seen: receipts.length, kept: receipts.length, rejected: 0, skipped: 0 };
  return {
    sourceKind: "manual",
    receipts,
    rates: normalizeRates(rates),
    ledger: buildCostLedger(receipts, rates, budgetUsd),
    counts: c,
    generatedAt: "2026-11-27T05:00:00.000Z",
  };
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/* ------------------------------------------------------------------ *
 * Rates: validated inputs that travel with the snapshot
 * ------------------------------------------------------------------ */

describe("normalizeRates", () => {
  it("falls back to the documented VPS billing defaults when absent", () => {
    const sheet = normalizeRates(undefined);
    expect(sheet).toEqual(DEFAULT_RATES);
    expect(sheet.jev.inputUsdPerMtok).toBe(0.042);
  });

  it("returns a COPY — mutating the sheet cannot edit the constants", () => {
    const sheet = normalizeRates(null);
    sheet.jev.inputUsdPerMtok = 999;
    expect(DEFAULT_RATES.jev.inputUsdPerMtok).toBe(0.042);
  });

  it("accepts a full explicit sheet, zeros included (a free-credit lane is legal)", () => {
    const sheet = normalizeRates({
      jev: { inputUsdPerMtok: 0, outputUsdPerMtok: 0 },
      gateway: { inputUsdPerMtok: 0.06, outputUsdPerMtok: 0.24 },
    });
    expect(sheet.jev.inputUsdPerMtok).toBe(0);
    expect(sheet.gateway.outputUsdPerMtok).toBe(0.24);
  });

  it("refuses a PARTIAL sheet — no silent half-defaults", () => {
    expect(() => normalizeRates({ jev: { inputUsdPerMtok: 1, outputUsdPerMtok: 1 } })).toThrow(/rates/);
  });

  it("refuses negatives, NaN, non-numbers, and absurd rates", () => {
    const bad = (inRate: unknown) => ({
      jev: { inputUsdPerMtok: inRate, outputUsdPerMtok: 1 },
      gateway: { inputUsdPerMtok: 1, outputUsdPerMtok: 1 },
    });
    expect(() => normalizeRates(bad(-0.001))).toThrow();
    expect(() => normalizeRates(bad(Number.NaN))).toThrow();
    expect(() => normalizeRates(bad("0.042"))).toThrow();
    expect(() => normalizeRates(bad(RATE_CAP_USD_PER_MTOK + 1))).toThrow();
  });

  it("refuses non-object payloads outright", () => {
    expect(() => normalizeRates("rates")).toThrow();
    expect(() => normalizeRates([1, 2])).toThrow();
    expect(() => normalizeRates(7)).toThrow();
  });
});

describe("costUsd", () => {
  it("prices a receipt EXACTLY: tokens per million times the per-side rate", () => {
    expect(costUsd({ input_tokens: 1_000_000, output_tokens: 500_000 }, SHEET.jev)).toBe(2);
  });

  it("zero tokens cost zero, at any rate", () => {
    expect(costUsd({ input_tokens: 0, output_tokens: 0 }, SHEET.jev)).toBe(0);
  });

  it("rounds to micro-dollars — sub-micro usage books a true 0, never 1e-9 noise", () => {
    expect(costUsd({ input_tokens: 100, output_tokens: 0 }, { inputUsdPerMtok: 0.042, outputUsdPerMtok: 0.042 })).toBe(0.000004);
  });

  it("refuses unusable receipts and unusable rates (never rescues)", () => {
    expect(() => costUsd({ input_tokens: -5, output_tokens: 1 }, SHEET.jev)).toThrow();
    expect(() => costUsd({ input_tokens: Number.NaN, output_tokens: 1 }, SHEET.jev)).toThrow();
    expect(() => costUsd({ input_tokens: "1000", output_tokens: 1 }, SHEET.jev)).toThrow();
    expect(() => costUsd({ input_tokens: 1, output_tokens: 1 }, { inputUsdPerMtok: -1, outputUsdPerMtok: 1 })).toThrow();
    expect(() => costUsd(null, SHEET.jev)).toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * The ledger — weighted, deterministic, fabrication-proof
 * ------------------------------------------------------------------ */

describe("buildCostLedger", () => {
  it("an empty ledger says a loud nothing: real zeros, null rates, never a fabricated price", () => {
    const led = buildCostLedger([], SHEET, DEFAULT_BUDGET_USD);
    expect(led.lines).toEqual([]);
    expect(led.total.costUsd).toBe(0);
    expect(led.total.usdPerMtok).toBeNull();
    expect(led.total.usdPerItem).toBeNull();
    expect(led.byProvider.jev.receipts).toBe(0);
    expect(led.byProvider.gateway.costUsd).toBe(0);
    expect(led.verdict).toMatch(/nothing priced yet/);
  });

  it("lines sort provider → lane → id BEFORE any sum (gateway, then jev)", () => {
    const led = buildCostLedger(
      [R("z1", "zeta", "jev", 1, 1000, 100), R("a1", "alpha", "gateway", 2, 2000, 200)],
      SHEET,
    );
    expect(led.lines.map((l) => l.id)).toEqual(["a1", "z1"]);
  });

  it("determinism under input shuffle: the whole ledger is byte-identical", () => {
    const receipts = [
      R("r1", "entities", "jev", 10, 40_000, 3_000),
      R("r2", "upload", "gateway", 5, 12_000, 900),
      R("r3", "entities", "jev", 25, 100_000, 7_500),
    ];
    const shuffled = [receipts[2], receipts[0], receipts[2], receipts[1]].filter(
      (v, i, a) => a.findIndex((x) => x.id === v.id) === i,
    );
    const a = buildCostLedger(receipts, SHEET);
    const b = buildCostLedger(shuffled, SHEET);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("effective $/Mtok is WEIGHTED — Σcost ÷ Σtokens, not an average of averages", () => {
    // jev 2M in @ $1/Mtok = $2 ; gateway 1M out @ $0.24/Mtok = $0.24
    // blended = 2.24 / 3M × 1e6 = 0.746667 — the mean of the per-receipt
    // rates (1.0 vs 0.24 → 0.62) would be a DIFFERENT, wrong number.
    const led = buildCostLedger(
      [R("heavy", "big", "jev", 10, 2_000_000, 0), R("light", "small", "gateway", 5, 0, 1_000_000)],
      SHEET,
    );
    expect(led.total.costUsd).toBe(2.24);
    expect(led.total.usdPerMtok).toBe(Number((2.24 / 3).toFixed(6)));
    expect(led.total.usdPerMtok).not.toBe(0.62);
  });

  it("per-provider rollups keep Jev and emulated spend SEPARATE", () => {
    const led = buildCostLedger(
      [R("j1", "h/jev", "jev", 5, 100_000, 1_000), R("g1", "h/gw", "gateway", 5, 100_000, 1_000)],
      SHEET,
    );
    expect(led.byProvider.jev.receipts).toBe(1);
    expect(led.byProvider.jev.costUsd).toBe(0.102);
    expect(led.byProvider.gateway.costUsd).toBe(0.00624);
  });

  it("lane rollups fold receipts by provider::lane and stay sorted", () => {
    const led = buildCostLedger(
      [
        R("e2", "entities", "jev", 4, 4_000, 400),
        R("e1", "entities", "jev", 6, 6_000, 600),
        R("u1", "upload", "gateway", 2, 2_000, 200),
      ],
      SHEET,
    );
    expect(led.lanes.map((l) => l.key)).toEqual(["gateway::upload", "jev::entities"]);
    const ent = led.lanes[1].rollup;
    expect(ent.receipts).toBe(2);
    expect(ent.items).toBe(10);
    expect(ent.inputTokens).toBe(10_000);
  });

  it("$/item is null on a zero-item receipt — the ledger never divides by zero", () => {
    const led = buildCostLedger([R("z", "ghost", "jev", 0, 5_000, 500)], SHEET);
    expect(led.lines[0].usdPerItem).toBeNull();
    expect(led.total.usdPerItem).toBeNull();
  });

  it("$/Mtok is null when zero tokens moved — booked items with no usage are visible, not invisible", () => {
    const led = buildCostLedger([R("t", "silent", "jev", 7, 0, 0)], SHEET);
    expect(led.lines[0].costUsd).toBe(0);
    expect(led.lines[0].usdPerMtok).toBeNull();
  });

  it("carries the rates it was priced at (normalized copy)", () => {
    const mutable = clone(SHEET);
    const led = buildCostLedger([], mutable);
    mutable.jev.inputUsdPerMtok = 999;
    expect(led.rates.jev.inputUsdPerMtok).toBe(1);
  });

  it("verdict names spend, receipts, effective rate, and budget state", () => {
    const led = buildCostLedger([R("v", "ops", "jev", 10, 100_000, 0)], SHEET, 1);
    expect(led.verdict).toContain("1 receipt(s)");
    expect(led.verdict).toContain("$0.1");
    expect(led.verdict).toContain("effective $1/Mtok");
    expect(led.verdict).toContain("10% of the $1 budget");
  });
});

describe("readBudget", () => {
  it("unset: null, zero, negative, and garbage budgets never divide", () => {
    for (const b of [null, undefined, 0, -5, "10", Number.NaN]) {
      const r = readBudget(0.5, b as unknown);
      expect(r.status).toBe("unset");
      expect(r.share).toBeNull();
    }
  });

  it("ok → warn → over at the exported thresholds (warn at EXACTLY 80%, over at exactly 100%)", () => {
    expect(readBudget(0.79, 1).status).toBe("ok");
    expect(readBudget(0.8 * BUDGET_WARN_SHARE * 1.25, 1).status).toBe("warn");
    expect(readBudget(0.9, 1).status).toBe("warn");
    expect(readBudget(1, 1).status).toBe("over");
    expect(readBudget(3, 1).status).toBe("over");
  });

  it("margin goes NEGATIVE when over — the debt is stated, not hidden", () => {
    expect(readBudget(1.4, 1).marginUsd).toBeCloseTo(-0.4, 6);
  });
});

/* ------------------------------------------------------------------ *
 * Manual intake — the ledger never trusts a payload
 * ------------------------------------------------------------------ */

describe("costReceiptsFromPayload", () => {
  it("keeps good rows and auto-numbers their ids", () => {
    const intake = costReceiptsFromPayload([
      { lane: "ops", provider: "jev", items: 10, usage: { input_tokens: 48_000, output_tokens: 3_600 } },
      { id: "mine", lane: "nightly", provider: "gateway", items: 2, usage: { input_tokens: 100, output_tokens: 10 } },
    ]);
    expect(intake.counts).toEqual({ seen: 2, kept: 2, rejected: 0 });
    expect(intake.receipts[0].id).toBe("manual-1");
    expect(intake.receipts[1].id).toBe("mine");
  });

  it("a non-array payload is refused whole, with the receipt still balanced", () => {
    const intake = costReceiptsFromPayload({ nope: true });
    expect(intake.counts).toEqual({ seen: 0, kept: 0, rejected: 1 });
    expect(intake.rejected[0].row).toBe(0);
  });

  it("refuses junk rows with 1-BASED row numbers and previews", () => {
    const intake = costReceiptsFromPayload([
      { lane: "ok", provider: "jev", items: 1, usage: { input_tokens: 10, output_tokens: 1 } },
      "not-an-object",
      { lane: "x", provider: "openai", items: 1, usage: { input_tokens: 10, output_tokens: 1 } },
      { lane: "x", provider: "jev", items: 1.5, usage: { input_tokens: 10, output_tokens: 1 } },
      { lane: "x", provider: "jev", items: 1, usage: { input_tokens: -3, output_tokens: 1 } },
      { lane: "x", provider: "jev", items: 1, usage: { input_tokens: "10", output_tokens: 1 } },
      { lane: "x", provider: "jev", items: 1 },
    ]);
    expect(intake.counts.kept).toBe(1);
    expect(intake.rejected.map((r) => r.row)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(intake.counts.seen).toBe(intake.counts.kept + intake.counts.rejected);
  });

  it("refuses overlong lanes and caps ids — CSV-safe by construction", () => {
    const intake = costReceiptsFromPayload([
      { lane: "L".repeat(65), provider: "jev", items: 1, usage: { input_tokens: 1, output_tokens: 1 } },
      { lane: "ok", provider: "gateway", items: 1, usage: { input_tokens: 1, output_tokens: 1 }, id: "x".repeat(300) },
    ]);
    expect(intake.rejected.length).toBe(1);
    expect(intake.receipts[0].id.length).toBeLessThanOrEqual(160);
  });
});

/* ------------------------------------------------------------------ *
 * Harness lane — two receipts, a dead side books nothing
 * ------------------------------------------------------------------ */

describe("costReceiptsFromHarness", () => {
  it("books BOTH sides of a live report with their own usage columns", () => {
    const der = costReceiptsFromHarness(
      harnessReport(3, 2, { input_tokens: 30_000, output_tokens: 2_400 }, { input_tokens: 20_000, output_tokens: 1_800 }),
    );
    expect(der.receipts.length).toBe(2);
    const jev = der.receipts.find((r) => r.provider === "jev")!;
    expect(jev.items).toBe(3);
    expect(jev.usage.input_tokens).toBe(30_000);
    expect(der.counts).toEqual({ itemsSeen: 3, jevItems: 3, gatewayItems: 2, sidesSkipped: 0 });
  });

  it("a DEAD side is skipped-and-counted — never a booked $0", () => {
    const der = costReceiptsFromHarness(harnessReport(0, 2, { input_tokens: 0, output_tokens: 0 }, { input_tokens: 9_000, output_tokens: 500 }));
    expect(der.receipts.map((r) => r.provider)).toEqual(["gateway"]);
    expect(der.counts.sidesSkipped).toBe(1);
  });

  it("a garbage report yields ZERO receipts — it cannot fake a ledger", () => {
    const der = costReceiptsFromHarness({ items: "junk", totals: null } as unknown as HarnessReport);
    expect(der.receipts).toEqual([]);
    expect(der.counts.sidesSkipped).toBe(2);
  });

  it("a live side with an unusable usage column books ZERO tokens, visibly", () => {
    const der = costReceiptsFromHarness(harnessReport(2, 0, { input_tokens: "lots", output_tokens: 1 }, null));
    const jev = der.receipts[0];
    expect(jev.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect(jev.items).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * Store lane — yesterday's runs are still on disk, price them
 * ------------------------------------------------------------------ */

describe("costReceiptsFromStoreRows", () => {
  it("prices guarded entities + upload reports with their own providers", () => {
    const der = costReceiptsFromStoreRows([
      { lane: "entities", runId: "entities-1", payload: entityReport({ input_tokens: 1_000, output_tokens: 200 }, "jev") },
      { lane: "upload", runId: "upload-1", payload: uploadReport({ input_tokens: 500, output_tokens: 100 }, "gateway") },
    ]);
    expect(der.receipts.map((r) => `${r.lane}:${r.provider}`)).toEqual(["entities:jev", "upload:gateway"]);
    expect(der.receipts[0].id).toBe("store-entities-entities-1");
    expect(der.counts).toEqual({ seen: 2, kept: 2, skippedNoUsage: 0, rejected: 0 });
  });

  it("lanes with no usage contract are skipped-AND-counted, never guessed at", () => {
    const der = costReceiptsFromStoreRows([
      { lane: "calibration", runId: "calibration-1", payload: { source: "manual", table: {}, points: [] } },
      { lane: "mystery", runId: "mystery-1", payload: { anything: true } },
    ]);
    expect(der.receipts).toEqual([]);
    expect(der.counts.skippedNoUsage).toBe(2);
  });

  it("corrupt rows (unparseable payloads) are refused-AND-counted, not silently dropped", () => {
    const der = costReceiptsFromStoreRows([
      { lane: "entities", runId: "x", payload: null },
      { lane: "entities", runId: "y", payload: entityReport({ input_tokens: 10, output_tokens: 1 }, "gateway") },
    ]);
    expect(der.counts).toEqual({ seen: 2, kept: 1, skippedNoUsage: 0, rejected: 1 });
  });

  it("a report that fails its own guard is REFUSED — a lying run on disk never prices", () => {
    const liar = clone(entityReport({ input_tokens: 1_000, output_tokens: 200 }, "jev"));
    (liar.totals as { compared: number }).compared = 99; // summary disagrees with items
    const der = costReceiptsFromStoreRows([{ lane: "entities", runId: "l", payload: liar }]);
    expect(der.receipts).toEqual([]);
    expect(der.counts.rejected + der.counts.skippedNoUsage).toBe(1);
  });

  it("the receipt balances: seen = kept + skipped + refused", () => {
    const der = costReceiptsFromStoreRows([
      { lane: "entities", runId: "a", payload: entityReport({ input_tokens: 5, output_tokens: 5 }, "jev") },
      { lane: "calibration", runId: "b", payload: {} },
      { lane: "upload", runId: "c", payload: null },
    ]);
    const c = der.counts;
    expect(c.seen).toBe(c.kept + c.skippedNoUsage + c.rejected);
  });
});

/* ------------------------------------------------------------------ *
 * Snapshot guard — a report that lies about its spend never reloads
 * ------------------------------------------------------------------ */

describe("isCostSnapshot + persistence", () => {
  it("an honest snapshot round-trips through SQLite (the store never trusted it, the guard did)", () => {
    const db = openResultsDb(":memory:");
    const snap = snapshotFor([R("s1", "entities", "jev", 4, 12_000, 900), R("s2", "upload", "gateway", 6, 8_000, 400)]);
    const saved = saveBatchRun(db, {
      lane: COST_RUN_LANE,
      payload: snap,
      guard: isCostSnapshot,
      summarize: costRunSummary,
      limit: null,
      savedAt: "2026-11-27T05:00:00.000Z",
    });
    expect(saved.summary).toEqual({ compared: 2, errors: 0 });
    const loaded = loadLatestRun<CostSnapshot>(db, COST_RUN_LANE, isCostSnapshot);
    expect(loaded!.payload.ledger.total.costUsd).toBe(snap.ledger.total.costUsd);
    expect(countRuns(db, COST_RUN_LANE, isCostSnapshot)).toEqual({ total: 1, readable: 1 });
  });

  it("a tampered line cost is REFUSED — the ledger must equal its own recompute", () => {
    const snap = clone(snapshotFor([R("t1", "ops", "jev", 1, 10_000, 0)], SHEET));
    snap.ledger.lines[0].costUsd = 0.000001;
    expect(isCostSnapshot(snap)).toBe(false);
  });

  it("a tampered grand total, verdict, or lane rollup is REFUSED", () => {
    const base = [R("a", "x", "jev", 5, 5_000, 500), R("b", "y", "gateway", 5, 5_000, 500)];
    const t = clone(snapshotFor(base, SHEET));
    t.ledger.total.costUsd += 1;
    expect(isCostSnapshot(t)).toBe(false);
    const v = clone(snapshotFor(base, SHEET));
    v.ledger.verdict = "everything is fine and cheap";
    expect(isCostSnapshot(v)).toBe(false);
    const l = clone(snapshotFor(base, SHEET));
    l.ledger.lanes[0].rollup.receipts = 99;
    expect(isCostSnapshot(l)).toBe(false);
    const p = clone(snapshotFor(base, SHEET));
    p.ledger.byProvider.jev.items = 999;
    expect(isCostSnapshot(p)).toBe(false);
  });

  it("changing a rate under a stored ledger is REFUSED — history never re-prices itself", () => {
    const snap = clone(snapshotFor([R("p", "ops", "jev", 1, 1_000_000, 0)], SHEET));
    snap.rates.jev.inputUsdPerMtok = 2;
    expect(isCostSnapshot(snap)).toBe(false);
  });

  it("receipts added after the ledger was built are REFUSED (kept must equal evidence)", () => {
    const snap = clone(snapshotFor([R("one", "ops", "jev", 1, 10, 1)], SHEET));
    snap.receipts.push(R("two", "ops", "jev", 1, 10, 1));
    expect(isCostSnapshot(snap)).toBe(false);
  });

  it("an UNBALANCED receipt is refused: seen must equal kept + rejected + skipped", () => {
    const snap = clone(snapshotFor([R("u", "ops", "jev", 1, 10, 1)], SHEET, 1, {
      seen: 5,
      kept: 1,
      rejected: 1,
      skipped: 1,
    }));
    expect(isCostSnapshot(snap)).toBe(false);
  });

  it("garbage snapshots die at SHAPE checks before any recompute", () => {
    expect(isCostSnapshot(null)).toBe(false);
    expect(isCostSnapshot("snapshot")).toBe(false);
    const s = clone(snapshotFor([], SHEET));
    s.sourceKind = "wizard" as CostSnapshot["sourceKind"];
    expect(isCostSnapshot(s)).toBe(false);
    const g = clone(snapshotFor([], SHEET));
    g.generatedAt = "not-a-date";
    expect(isCostSnapshot(g)).toBe(false);
    const r = clone(snapshotFor([], SHEET));
    r.rates.jev.inputUsdPerMtok = -1;
    expect(isCostSnapshot(r)).toBe(false);
  });

  it("the liar is also refused AT WRITE time", () => {
    const db = openResultsDb(":memory:");
    const snap = clone(snapshotFor([R("w", "ops", "gateway", 2, 20, 2)], SHEET));
    snap.ledger.byProvider.gateway.costUsd = 42;
    expect(() =>
      saveBatchRun(db, { lane: COST_RUN_LANE, payload: snap, guard: isCostSnapshot, summarize: costRunSummary }),
    ).toThrow(/does not recognize/);
  });

  it("summary errors ≤ compared BY CONSTRUCTION (the receipt balances before it stores)", () => {
    const snap = snapshotFor([R("m1", "ops", "jev", 1, 10, 1)], SHEET, 1, {
      seen: 10,
      kept: 1,
      rejected: 4,
      skipped: 5,
    });
    // fix the ledger to match (the counts knob only applies when honest):
    snap.receipts = [R("m1", "ops", "jev", 1, 10, 1)];
    expect(costRunSummary(snap)).toEqual({ compared: 10, errors: 9 });
    expect(isCostSnapshot(snap)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Cross-lane scan helpers on the shared store
 * ------------------------------------------------------------------ */

describe("scanAllRuns + laneSummaries", () => {
  it("walks EVERY lane: ordered by lane asc then newest first; corrupt payloads come back null", () => {
    const db = openResultsDb(":memory:");
    saveBatchRun(db, {
      lane: "entities",
      payload: entityReport({ input_tokens: 10, output_tokens: 1 }, "jev"),
      guard: () => true,
      summarize: () => ({ compared: 1, errors: 0 }),
      savedAt: "2026-11-27T01:00:00.000Z",
    });
    saveBatchRun(db, {
      lane: "entities",
      payload: entityReport({ input_tokens: 20, output_tokens: 2 }, "gateway"),
      guard: () => true,
      summarize: () => ({ compared: 1, errors: 0 }),
      savedAt: "2026-11-27T02:00:00.000Z",
    });
    saveBatchRun(db, {
      lane: "calibration",
      payload: { no: "usage here" },
      guard: () => true,
      summarize: () => ({ compared: 1, errors: 0 }),
      savedAt: "2026-11-27T01:30:00.000Z",
    });
    db.prepare("UPDATE batch_runs SET payload = '{broken' WHERE lane = 'calibration'").run();

    const rows = scanAllRuns(db, 100);
    expect(rows.map((r) => `${r.lane}@${r.savedAt.slice(11, 16)}`)).toEqual([
      "calibration@01:30",
      "entities@02:00",
      "entities@01:00",
    ]);
    expect(rows[0].payload).toBeNull(); // corrupt: counted, never trusted

    const sums = laneSummaries(db);
    expect(sums.map((s) => s.lane)).toEqual(["calibration", "entities"]);
    expect(sums[1].runs).toBe(2);

    const der = costReceiptsFromStoreRows(rows);
    expect(der.counts).toEqual({ seen: 3, kept: 2, skippedNoUsage: 0, rejected: 1 });
  });

  it("cap is an INTEGER ceiling, clamped to the list cap; 0 means nothing", () => {
    const db = openResultsDb(":memory:");
    expect(() => scanAllRuns(db, 1.5)).toThrow(/integer/);
    expect(scanAllRuns(db, 0)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * D8 export — stable columns, totals ride row 0
 * ------------------------------------------------------------------ */

describe("costExportRows", () => {
  it("keeps a stable column order and rides totals + verdict on row 0", () => {
    const led = buildCostLedger(
      [R("x", "ops", "jev", 3, 30_000, 300), R("y", "ops", "gateway", 2, 10_000, 100)],
      SHEET,
      1,
    );
    const rows = costExportRows(led);
    expect(rows.length).toBe(2);
    expect(Object.keys(rows[0])).toEqual([
      "receiptId", "source", "lane", "provider", "items", "inputTokens", "outputTokens", "tokens",
      "rateInUsdPerMtok", "rateOutUsdPerMtok", "costUsd", "usdPerItem", "usdPerMtok",
      "totalCostUsd", "totalUsdPerMtok", "totalUsdPerItem", "jevCostUsd", "jevUsdPerMtok",
      "gatewayCostUsd", "gatewayUsdPerMtok", "budgetUsd", "budgetStatus", "verdict",
    ]);
    expect(rows[0].verdict).toBe(led.verdict);
    expect(rows[1].verdict).toBe("");
    expect(rows[0].totalCostUsd).toBe(led.total.costUsd);
    expect(rows[1].totalCostUsd).toBe("");
  });

  it("an empty ledger exports its REAL zeros and the loud verdict — headers never lie", () => {
    const rows = costExportRows(buildCostLedger([], DEFAULT_RATES, DEFAULT_BUDGET_USD));
    expect(rows.length).toBe(1);
    expect(rows[0].totalCostUsd).toBe(0);
    expect(rows[0].usdPerMtok).toBe("");
    expect(String(rows[0].verdict)).toMatch(/nothing priced yet/);
  });

  it("rides the D8 CSV pipeline through toCSV: header + one row per receipt", () => {
    const csv = toCSV(costExportRows(buildCostLedger([R("c", "ops", "jev", 1, 1000, 100)], SHEET, 1)));
    const lines = csv.split("\r\n");
    expect(lines.length).toBe(2);
    expect(lines[0].startsWith("receiptId,source,lane,provider,")).toBe(true);
    expect(lines[1].startsWith("c,manual,ops,jev,")).toBe(true);
    const weird = toCSV(
      costExportRows(buildCostLedger([R("q,1", "lane, with, commas", "gateway", 1, 1000, 100)], SHEET, 1)),
    );
    expect(weird).toContain('"q,1"');
    expect(weird).toContain('"lane, with, commas"');
  });
});

/* ------------------------------------------------------------------ *
 * End-to-end: receipts on disk → priced snapshot → reload
 * ------------------------------------------------------------------ */

describe("the day's spend end to end", () => {
  it("store scan + default VPS rates → the ledger survives a simulated restart byte-identical", () => {
    const db = openResultsDb(":memory:");
    saveBatchRun(db, {
      lane: "entities",
      payload: entityReport({ input_tokens: 60_000, output_tokens: 4_800 }, "jev"),
      guard: () => true,
      summarize: () => ({ compared: 1, errors: 0 }),
      savedAt: "2026-11-27T04:00:00.000Z",
    });
    saveBatchRun(db, {
      lane: "upload",
      payload: uploadReport({ input_tokens: 30_000, output_tokens: 2_000 }, "gateway"),
      guard: () => true,
      summarize: () => ({ compared: 1, errors: 0 }),
      savedAt: "2026-11-27T04:30:00.000Z",
    });

    const rows = scanAllRuns(db, 100);
    const der = costReceiptsFromStoreRows(rows);
    const rates = normalizeRates(undefined); // documented $0.042/Mtok defaults
    const ledger = buildCostLedger(der.receipts, rates, DEFAULT_BUDGET_USD);
    const snap: CostSnapshot = {
      sourceKind: "store",
      receipts: der.receipts,
      rates,
      ledger,
      counts: { seen: der.counts.seen, kept: der.counts.kept, rejected: der.counts.rejected, skipped: der.counts.skippedNoUsage },
      generatedAt: "2026-11-27T05:00:00.000Z",
    };
    // lines round to micro-dollars BEFORE summing: 0.002722 + 0.001344 = 0.004066
    expect(ledger.total.costUsd).toBe(0.004066);
    // blend rides the ROUNDED line costs: 0.004066/96800×1e6 = 0.042004 —
    // micro-dollar rounding shifts the effective rate by 4e-6, stated not hidden
    expect(ledger.total.usdPerMtok).toBe(0.042004);
    expect(ledger.byProvider.jev.costUsd).toBe(0.002722);

    saveBatchRun(db, { lane: COST_RUN_LANE, payload: snap, guard: isCostSnapshot, summarize: costRunSummary, savedAt: "2026-11-27T05:00:01.000Z" });
    const reloaded = loadLatestRun<CostSnapshot>(db, COST_RUN_LANE, isCostSnapshot);
    expect(reloaded!.payload.ledger.verdict).toBe(snap.ledger.verdict);
    expect(JSON.stringify(reloaded!.payload.ledger)).toBe(JSON.stringify(snap.ledger));
  });
});
