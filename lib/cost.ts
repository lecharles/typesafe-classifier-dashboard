/**
 * Cost/token dashboard (11-27 row): Jev $/Mtok tracking, decided IN CODE.
 *
 * Every lane in this hub burns tokens; until now the spend was a rumor.
 * This lane turns real usage receipts into a priced ledger: per receipt,
 * per lane, per provider, and an EFFECTIVE $/Mtok that is weighted by the
 * tokens actually moved — never an average of averages.
 *
 * Receipt sources (all three ride the same ledger):
 *  - "harness" — the D14 comparison run yields TWO receipts, one per side
 *    (jev / gateway), each carrying its own totals column. A side with
 *    zero live items is SKIPPED-AND-COUNTED: a dead backend never books
 *    a $0 spend story.
 *  - "store" — the SQLite store outlives the process, so a day's spend
 *    does too: guarded entities + upload reports become receipts
 *    straight off disk. Calibration-style lanes (no usage contract) are
 *    skipped-and-counted, never guessed at.
 *  - "manual" — paste your own (lane, provider, items, tokens) receipts.
 *    THE INTAKE NEVER TRUSTS A PAYLOAD: refused rows ride the receipt
 *    with 1-based row numbers and the counts balance by construction.
 *
 * House rules this module never breaks:
 *  - RATES ARE DATA, NOT DOGMA — the $/Mtok rates are inputs (defaults
 *    documented, editable in the UI), and every snapshot stores the
 *    rates it was priced at. A cost computed at one rate can NEVER be
 *    silently re-priced by a later edit: the guard recomputes from the
 *    receipts with the STORED rates and refuses any ledger that lies.
 *  - WEIGHTED, NOT AVERAGED — effective $/Mtok = Σcost / Σtokens × 1e6.
 *    One loud receipt cannot drown the quiet ones (same lesson as ECE).
 *  - NOTHING IS FABRICATED — zero tokens → effective rate null, zero
 *    items → $/item null, empty ledger → a loud nothing-to-price verdict.
 *  - DETERMINISTIC — lines sort provider → lane → id BEFORE any float is
 *    summed, so shuffling the receipts cannot move a decimal.
 *  - EXPORT RIDES D8 — stable column order; totals + verdict ride row 0.
 */

import type { Provider, Usage } from "@/lib/schema";
import type { ExportRow } from "@/lib/export";
import type { HarnessReport } from "@/lib/harness";
import { isEntityBatchReport } from "@/lib/entities";
import { isUploadBatchReport } from "@/lib/upload";

/* ------------------------------------------------------------------ *
 * Rates: inputs, validated in code, stored with every snapshot.
 * ------------------------------------------------------------------ */

export type CostRate = { inputUsdPerMtok: number; outputUsdPerMtok: number };
export type CostRates = { jev: CostRate; gateway: CostRate };

/** Absurd-rate ceiling — a $/Mtok above this is a typo, not a price. */
export const RATE_CAP_USD_PER_MTOK = 10_000;

/**
 * Live-VPS billing rates (ROADMAP-YEAR-END standing risk #4): gateway
 * credits meter at $0.042/Mtok in. Output is priced the same until a
 * real bill says otherwise — and BOTH fields are editable on the page;
 * every snapshot carries the rates it was priced at, so history never
 * re-prices itself under you.
 */
export const DEFAULT_RATES: CostRates = {
  jev: { inputUsdPerMtok: 0.042, outputUsdPerMtok: 0.042 },
  gateway: { inputUsdPerMtok: 0.042, outputUsdPerMtok: 0.042 },
};

/** Default watch budget for the hub — the balance the risks note says to watch. */
export const DEFAULT_BUDGET_USD = 1.0;
/** A ledger past this share of budget earns a warn before it ever hits "over". */
export const BUDGET_WARN_SHARE = 0.8;

function isBelievableMoney(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= RATE_CAP_USD_PER_MTOK;
}

function isRate(x: unknown): x is CostRate {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const r = x as Record<string, unknown>;
  return isBelievableMoney(r.inputUsdPerMtok) && isBelievableMoney(r.outputUsdPerMtok);
}

/**
 * Rates are refused loudly, never rescued: a partial sheet, a string,
 * a negative, an absurd number — all throw with a message the route
 * turns into a 400. Zero rates are legal (a free-credit lane).
 */
export function normalizeRates(raw: unknown): CostRates {
  if (raw === undefined || raw === null) return { jev: { ...DEFAULT_RATES.jev }, gateway: { ...DEFAULT_RATES.gateway } };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("cost: rates must be an object {jev, gateway} of $/Mtok rates");
  }
  const p = raw as Record<string, unknown>;
  if (!isRate(p.jev) || !isRate(p.gateway)) {
    throw new Error(
      "cost: rates.jev and rates.gateway must each be {inputUsdPerMtok, outputUsdPerMtok} — finite numbers in [0, 10000]",
    );
  }
  return {
    jev: { inputUsdPerMtok: p.jev.inputUsdPerMtok, outputUsdPerMtok: p.jev.outputUsdPerMtok },
    gateway: { inputUsdPerMtok: p.gateway.inputUsdPerMtok, outputUsdPerMtok: p.gateway.outputUsdPerMtok },
  };
}

/** The price of one usage receipt at one rate — micro-dollars, exact math. */
export function costUsd(usage: unknown, rate: unknown): number {
  if (!isUsage(usage)) {
    throw new Error("cost: usage must be {input_tokens, output_tokens} — finite non-negative numbers");
  }
  if (!isRate(rate)) {
    throw new Error("cost: rate must be {inputUsdPerMtok, outputUsdPerMtok} — finite numbers in [0, 10000]");
  }
  return round6(
    (usage.input_tokens / 1e6) * rate.inputUsdPerMtok + (usage.output_tokens / 1e6) * rate.outputUsdPerMtok,
  );
}

/* ------------------------------------------------------------------ *
 * Receipts: the atom of the ledger — one priced batch of calls.
 * ------------------------------------------------------------------ */

export type CostSource = "harness" | "store" | "manual";

export type CostReceipt = {
  id: string;
  source: CostSource;
  lane: string;
  provider: Provider;
  items: number;
  usage: Usage;
};

export type CostReject = {
  row: number;
  reason: string;
  preview: string;
};

export type CostIntake = {
  receipts: CostReceipt[];
  rejected: CostReject[];
  counts: { seen: number; kept: number; rejected: number };
};

function isUsage(x: unknown): x is Usage {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const u = x as Record<string, unknown>;
  return (
    typeof u.input_tokens === "number" &&
    Number.isFinite(u.input_tokens) &&
    u.input_tokens >= 0 &&
    typeof u.output_tokens === "number" &&
    Number.isFinite(u.output_tokens) &&
    u.output_tokens >= 0
  );
}

function isReceipt(x: unknown): x is CostReceipt {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    r.id.length > 0 &&
    r.id.length <= 160 &&
    (r.source === "harness" || r.source === "store" || r.source === "manual") &&
    typeof r.lane === "string" &&
    r.lane.length > 0 &&
    r.lane.length <= 64 &&
    (r.provider === "jev" || r.provider === "gateway") &&
    typeof r.items === "number" &&
    Number.isInteger(r.items) &&
    r.items >= 0 &&
    r.items <= 1_000_000 &&
    isUsage(r.usage)
  );
}

function previewOf(entry: unknown): string {
  try {
    return (typeof entry === "string" ? entry : JSON.stringify(entry) ?? String(entry))
      .replace(/\s+/g, " ")
      .slice(0, 60);
  } catch {
    return "[unserializable row]";
  }
}

/**
 * Manual lane: {lane, provider, items, usage} rows in, guarded receipts
 * out. THE INTAKE NEVER RESCUES: every refused row rides the receipt
 * with its 1-based row number, and seen = kept + refused is structural.
 */
export function costReceiptsFromPayload(raw: unknown): CostIntake {
  const receipts: CostReceipt[] = [];
  const rejected: CostReject[] = [];
  if (!Array.isArray(raw)) {
    return {
      receipts,
      rejected: [{ row: 0, reason: "payload must be an array of {lane, provider, items, usage}", preview: String(typeof raw) }],
      counts: { seen: 0, kept: 0, rejected: 1 },
    };
  }
  raw.forEach((entry, i) => {
    const preview = previewOf(entry);
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      rejected.push({ row: i + 1, reason: "row is not an object", preview });
      return;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.lane !== "string" || !/^[A-Za-z0-9._/ -]{1,64}$/.test(e.lane.trim())) {
      rejected.push({ row: i + 1, reason: "lane must be 1-64 printable chars", preview });
      return;
    }
    if (e.provider !== "jev" && e.provider !== "gateway") {
      rejected.push({ row: i + 1, reason: 'provider must be "jev" or "gateway"', preview });
      return;
    }
    if (typeof e.items !== "number" || !Number.isInteger(e.items) || e.items < 0 || e.items > 1_000_000) {
      rejected.push({ row: i + 1, reason: "items must be an integer in [0, 1000000]", preview });
      return;
    }
    if (!isUsage(e.usage)) {
      rejected.push({ row: i + 1, reason: "usage must be {input_tokens, output_tokens} — finite non-negative numbers", preview });
      return;
    }
    receipts.push({
      id: typeof e.id === "string" && e.id.trim() ? e.id.trim().slice(0, 160) : `manual-${i + 1}`,
      source: "manual",
      lane: e.lane.trim(),
      provider: e.provider,
      items: e.items,
      usage: { input_tokens: e.usage.input_tokens, output_tokens: e.usage.output_tokens },
    });
  });
  return {
    receipts,
    rejected,
    counts: { seen: raw.length, kept: receipts.length, rejected: rejected.length },
  };
}

/* ------------------------------------------------------------------ *
 * Harness lane: one report, TWO receipts — Jev and emulated, priced
 * side by side from the same states. A dead side is skipped-and-counted.
 * ------------------------------------------------------------------ */

export type HarnessCostDerivation = {
  receipts: CostReceipt[];
  counts: {
    itemsSeen: number;
    jevItems: number;
    gatewayItems: number;
    sidesSkipped: number;
  };
};

/**
 * Walk the D14 report CODE-side: each side's usage totals only count
 * what that side actually answered. A side with zero live items is
 * EXCLUDED AND COUNTED — never a booked $0.
 */
export function costReceiptsFromHarness(report: HarnessReport): HarnessCostDerivation {
  const items = Array.isArray(report?.items) ? report.items : [];
  const totals = (report?.totals ?? {}) as Partial<HarnessReport["totals"]>;
  const jevItems = items.filter((it) => it?.jev?.ok).length;
  const gatewayItems = items.filter((it) => it?.emulated?.ok).length;
  const receipts: CostReceipt[] = [];
  let sidesSkipped = 0;

  const push = (provider: Provider, lane: string, id: string, itemCount: number, usage: unknown) => {
    if (itemCount <= 0) {
      sidesSkipped += 1; // a dead side books nothing — excluded AND counted
      return;
    }
    receipts.push({
      id,
      source: "harness",
      lane,
      provider,
      items: itemCount,
      usage: isUsage(usage) ? { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } : { input_tokens: 0, output_tokens: 0 },
    });
  };

  push("jev", "harness/jev", "harness-jev", jevItems, totals.jevUsage);
  push("gateway", "harness/gateway", "harness-gateway", gatewayItems, totals.emulatedUsage);

  return {
    receipts,
    counts: { itemsSeen: items.length, jevItems, gatewayItems, sidesSkipped },
  };
}

/* ------------------------------------------------------------------ *
 * Store lane: yesterday's runs are still on disk — price them.
 * ------------------------------------------------------------------ */

export type StoreRowWire = { lane: string; runId: string; payload: unknown };

export type StoreCostDerivation = {
  receipts: CostReceipt[];
  counts: { seen: number; kept: number; skippedNoUsage: number; rejected: number };
};

/**
 * Read guarded batch reports off disk (whatever the lane is called here,
 * the run id rides the receipt, so the ledger links back to the store).
 *  - entities / upload reports: real usage columns → receipts.
 *  - other lanes (e.g. "calibration" — no usage contract): SKIPPED-AND-
 *    COUNTED, never guessed at.
 *  - a row whose payload will not even parse: refused and counted.
 */
export function costReceiptsFromStoreRows(rows: StoreRowWire[]): StoreCostDerivation {
  const receipts: CostReceipt[] = [];
  let skippedNoUsage = 0;
  let rejected = 0;
  for (const row of rows ?? []) {
    if (!row || typeof row.lane !== "string" || typeof row.runId !== "string") {
      rejected += 1;
      continue;
    }
    if (row.payload && isEntityBatchReport(row.payload)) {
      receipts.push({
        id: `store-entities-${row.runId}`,
        source: "store",
        lane: "entities",
        provider: row.payload.provider,
        items: row.payload.items.length,
        usage: {
          input_tokens: row.payload.totals.usage.input_tokens,
          output_tokens: row.payload.totals.usage.output_tokens,
        },
      });
      continue;
    }
    if (row.payload && isUploadBatchReport(row.payload)) {
      receipts.push({
        id: `store-upload-${row.runId}`,
        source: "store",
        lane: "upload",
        provider: row.payload.provider,
        items: row.payload.items.length,
        usage: {
          input_tokens: row.payload.totals.usage.input_tokens,
          output_tokens: row.payload.totals.usage.output_tokens,
        },
      });
      continue;
    }
    if (row.payload === null || row.payload === undefined) {
      rejected += 1; // corrupt row: counted, never silently dropped
      continue;
    }
    skippedNoUsage += 1; // a valid lane with no usage contract (calibration, future lanes)
  }
  return {
    receipts,
    counts: { seen: (rows ?? []).length, kept: receipts.length, skippedNoUsage, rejected },
  };
}

/* ------------------------------------------------------------------ *
 * The ledger: lines, lane rollups, provider rollups, grand total.
 * ------------------------------------------------------------------ */

const round6 = (n: number) => Number(n.toFixed(6));

export type CostLine = {
  id: string;
  source: CostSource;
  lane: string;
  provider: Provider;
  items: number;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  rate: CostRate;
  costUsd: number;
  /** cost / items — null when the receipt booked no items (never divides by zero) */
  usdPerItem: number | null;
  /** weighted effective rate for THIS receipt — null on zero tokens */
  usdPerMtok: number | null;
};

export type CostRollup = {
  receipts: number;
  items: number;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  costUsd: number;
  usdPerItem: number | null;
  usdPerMtok: number | null;
};

export type CostBudget = {
  budgetUsd: number | null;
  share: number | null;
  status: "unset" | "ok" | "warn" | "over";
  marginUsd: number | null;
};

export type CostLedger = {
  lines: CostLine[];
  lanes: { key: string; lane: string; provider: Provider; rollup: CostRollup }[];
  byProvider: Record<Provider, CostRollup>;
  total: CostRollup;
  rates: CostRates;
  budget: CostBudget;
  verdict: string;
};

function emptyRollup(): CostRollup {
  return {
    receipts: 0,
    items: 0,
    inputTokens: 0,
    outputTokens: 0,
    tokens: 0,
    costUsd: 0,
    usdPerItem: null,
    usdPerMtok: null,
  };
}

function finalizeRollup(acc: {
  receipts: number;
  items: number;
  inputTokens: number;
  outputTokens: number;
  costSum: number;
}): CostRollup {
  const tokens = acc.inputTokens + acc.outputTokens;
  return {
    receipts: acc.receipts,
    items: acc.items,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    tokens,
    costUsd: round6(acc.costSum),
    usdPerItem: acc.items > 0 ? round6(acc.costSum / acc.items) : null,
    // WEIGHTED, not averaged: Σcost / Σtokens × 1e6 — one loud receipt
    // cannot drown the quiet ones.
    usdPerMtok: tokens > 0 ? round6((acc.costSum / tokens) * 1e6) : null,
  };
}

export function readBudget(costUsdTotal: number, budgetUsd: unknown): CostBudget {
  const b =
    budgetUsd === null || budgetUsd === undefined
      ? null
      : typeof budgetUsd === "number" && Number.isFinite(budgetUsd) && budgetUsd > 0
        ? round6(budgetUsd)
        : null;
  if (b === null) {
    return { budgetUsd: null, share: null, status: "unset", marginUsd: null };
  }
  const share = round6(costUsdTotal / b);
  const status: CostBudget["status"] = share >= 1 ? "over" : share >= BUDGET_WARN_SHARE ? "warn" : "ok";
  return { budgetUsd: b, share, status, marginUsd: round6(b - costUsdTotal) };
}

/**
 * The ledger. Pure, deterministic, order-free: lines are sorted BEFORE
 * any float is summed, so shuffling the receipts cannot move a decimal.
 */
export function buildCostLedger(
  receipts: CostReceipt[],
  rates: CostRates,
  budgetUsd: unknown = DEFAULT_BUDGET_USD,
): CostLedger {
  const sorted = [...receipts].sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.lane.localeCompare(b.lane) || a.id.localeCompare(b.id),
  );

  const lines: CostLine[] = sorted.map((r) => {
    const rate = rates[r.provider];
    const cost = costUsd(r.usage, rate);
    const tokens = r.usage.input_tokens + r.usage.output_tokens;
    return {
      id: r.id,
      source: r.source,
      lane: r.lane,
      provider: r.provider,
      items: r.items,
      inputTokens: r.usage.input_tokens,
      outputTokens: r.usage.output_tokens,
      tokens,
      rate: { ...rate },
      costUsd: cost,
      usdPerItem: r.items > 0 ? round6(cost / r.items) : null,
      usdPerMtok: tokens > 0 ? round6((cost / tokens) * 1e6) : null,
    };
  });

  // per-lane rollups (provider::lane), sorted by key
  const laneAcc = new Map<string, ReturnType<typeof emptyRollup> & { costSum: number; lane: string; provider: Provider }>();
  for (const l of lines) {
    const key = `${l.provider}::${l.lane}`;
    const acc = laneAcc.get(key) ?? { ...emptyRollup(), costSum: 0, lane: l.lane, provider: l.provider };
    acc.receipts += 1;
    acc.items += l.items;
    acc.inputTokens += l.inputTokens;
    acc.outputTokens += l.outputTokens;
    acc.costSum += l.costUsd;
    laneAcc.set(key, acc);
  }
  const lanes = [...laneAcc.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, acc]) => ({ key, lane: acc.lane, provider: acc.provider, rollup: finalizeRollup(acc) }));

  const byProvider: Record<Provider, CostRollup> = {
    jev: emptyRollup(),
    gateway: emptyRollup(),
  };
  for (const prov of ["gateway", "jev"] as Provider[]) {
    const acc = { ...emptyRollup(), costSum: 0 };
    for (const l of lines) {
      if (l.provider !== prov) continue;
      acc.receipts += 1;
      acc.items += l.items;
      acc.inputTokens += l.inputTokens;
      acc.outputTokens += l.outputTokens;
      acc.costSum += l.costUsd;
    }
    byProvider[prov] = finalizeRollup(acc);
  }

  const grand = { ...emptyRollup(), costSum: 0 };
  for (const l of lines) {
    grand.receipts += 1;
    grand.items += l.items;
    grand.inputTokens += l.inputTokens;
    grand.outputTokens += l.outputTokens;
    grand.costSum += l.costUsd;
  }
  const total = finalizeRollup(grand);
  const budget = readBudget(total.costUsd, budgetUsd);

  let verdict: string;
  if (lines.length === 0) {
    verdict = "nothing priced yet — no usage receipts in this ledger";
  } else {
    const eff = total.usdPerMtok === null ? "no tokens moved" : `effective $${total.usdPerMtok}/Mtok`;
    const perItem = total.usdPerItem === null ? "—" : `$${total.usdPerItem}/item`;
    const budgetNote =
      budget.status === "unset"
        ? "no budget set"
        : budget.status === "over"
          ? `OVER budget by $${Math.abs(budget.marginUsd ?? 0)}`
          : `${Math.round((budget.share ?? 0) * 100)}% of the $${budget.budgetUsd} budget`;
    verdict = `${lines.length} receipt(s) · $${total.costUsd} spent · ${eff} · ${perItem} · ${budgetNote}`;
  }

  return { lines, lanes, byProvider, total, rates: normalizeRates(rates), budget, verdict };
}

/* ------------------------------------------------------------------ *
 * Persisted snapshot: the store NEVER TRUSTS A PAYLOAD.
 * ------------------------------------------------------------------ */

export type CostCounts = { seen: number; kept: number; rejected: number; skipped: number };

export type CostSnapshot = {
  sourceKind: CostSource;
  /** the RAW receipts — the ledger's evidence, kept so the guard can re-derive it */
  receipts: CostReceipt[];
  rates: CostRates;
  ledger: CostLedger;
  counts: CostCounts;
  generatedAt: string;
};

export const COST_RUN_LANE = "cost";

function isCostCounts(x: unknown): x is CostCounts {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const c = x as Record<string, unknown>;
  return (
    typeof c.seen === "number" && Number.isInteger(c.seen) && c.seen >= 0 &&
    typeof c.kept === "number" && Number.isInteger(c.kept) && c.kept >= 0 &&
    typeof c.rejected === "number" && Number.isInteger(c.rejected) && c.rejected >= 0 &&
    typeof c.skipped === "number" && Number.isInteger(c.skipped) && c.skipped >= 0 &&
    // the receipt BALANCES by construction: seen = kept + rejected + skipped
    c.seen === c.kept + c.rejected + c.skipped
  );
}

/**
 * Shape AND self-consistency: a stored ledger that disagrees with its
 * own receipts (or with the rates it claims) is structurally impossible
 * to reload. The whole table is RECOMPUTED from the stored evidence —
 * a report that lies about its own spend never survives.
 */
export function isCostSnapshot(payload: unknown): payload is CostSnapshot {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const p = payload as Record<string, unknown>;
  if (p.sourceKind !== "harness" && p.sourceKind !== "store" && p.sourceKind !== "manual") return false;
  if (typeof p.generatedAt !== "string" || !Number.isInteger(Date.parse(p.generatedAt))) return false;
  if (!Array.isArray(p.receipts) || !p.receipts.every(isReceipt)) return false;
  const receipts = p.receipts as CostReceipt[];
  if (!isRateObj(p.rates)) return false;
  if (!isCostCounts(p.counts)) return false;
  const counts = p.counts as CostCounts;
  // the ledger can only have been built from THESE receipts
  if (counts.kept !== receipts.length) return false;

  const l = p.ledger as Record<string, unknown> | undefined;
  if (!l || Array.isArray(l)) return false;
  if (!Array.isArray(l.lines) || !Array.isArray(l.lanes)) return false;
  if (!l.byProvider || typeof l.byProvider !== "object") return false;
  if (!l.total || typeof l.total !== "object") return false;
  if (!l.budget || typeof l.budget !== "object" || Array.isArray(l.budget)) return false;
  const budgetUsd = (l.budget as CostBudget).budgetUsd;
  if (budgetUsd !== null && !(typeof budgetUsd === "number" && Number.isFinite(budgetUsd))) return false;

  // RECOMPUTE the WHOLE ledger from the stored evidence with the stored
  // rates. Floats round-trip exactly through JSON, so a byte-equal
  // comparison is the honest check: any tampered cost, rate, rollup,
  // verdict, or budget read fails.
  let rebuilt: CostLedger;
  try {
    rebuilt = buildCostLedger(receipts, p.rates as CostRates, budgetUsd ?? null);
  } catch {
    return false; // rates the builder itself refuses → the snapshot cannot be true
  }
  return eqLedger(rebuilt, l as unknown as CostLedger);
}

function eqLedger(a: CostLedger, b: CostLedger): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isRateObj(x: unknown): x is CostRates {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const r = x as Record<string, unknown>;
  return isRate(r.jev) && isRate(r.gateway);
}

/**
 * Recompute the store summary FROM THE RECEIPT — never accept one.
 *  - compared = rows the lane looked at (seen)
 *  - errors   = rows that did NOT become receipts (rejected + skipped)
 * seen = kept + rejected + skipped is asserted by the guard, so
 * errors ≤ compared is STRUCTURAL — an inverted summary cannot exist.
 */
export function costRunSummary(payload: unknown): { compared: number; errors: number } {
  const p = payload as CostSnapshot;
  const c = p.counts;
  return { compared: c.seen, errors: c.rejected + c.skipped };
}

/* ------------------------------------------------------------------ *
 * D8 export surface — stable columns; totals + verdict ride row 0.
 * ------------------------------------------------------------------ */

export function costExportRows(ledger: CostLedger): ExportRow[] {
  const cols = (extra: Partial<Record<string, string | number | null>> = {}) => ({
    receiptId: "",
    source: "",
    lane: "",
    provider: "",
    items: "",
    inputTokens: "",
    outputTokens: "",
    tokens: "",
    rateInUsdPerMtok: "",
    rateOutUsdPerMtok: "",
    costUsd: "",
    usdPerItem: "",
    usdPerMtok: "",
    totalCostUsd: ledger.total.costUsd,
    totalUsdPerMtok: ledger.total.usdPerMtok ?? "",
    totalUsdPerItem: ledger.total.usdPerItem ?? "",
    jevCostUsd: ledger.byProvider.jev.costUsd,
    jevUsdPerMtok: ledger.byProvider.jev.usdPerMtok ?? "",
    gatewayCostUsd: ledger.byProvider.gateway.costUsd,
    gatewayUsdPerMtok: ledger.byProvider.gateway.usdPerMtok ?? "",
    budgetUsd: ledger.budget.budgetUsd ?? "",
    budgetStatus: ledger.budget.status,
    verdict: ledger.verdict,
    ...extra,
  });

  if (ledger.lines.length === 0) {
    // an empty ledger still exports its loud nothing — headers ride one
    // summary row; nothing is fabricated, the numbers are the real zeros.
    return [cols()];
  }
  return ledger.lines.map((l, i) =>
    cols({
      receiptId: l.id,
      source: l.source,
      lane: l.lane,
      provider: l.provider,
      items: l.items,
      inputTokens: l.inputTokens,
      outputTokens: l.outputTokens,
      tokens: l.tokens,
      rateInUsdPerMtok: l.rate.inputUsdPerMtok,
      rateOutUsdPerMtok: l.rate.outputUsdPerMtok,
      costUsd: l.costUsd,
      usdPerItem: l.usdPerItem ?? "",
      usdPerMtok: l.usdPerMtok ?? "",
      // totals + verdict ride row 0 only (the calibration pattern)
      ...(i === 0
        ? {}
        : { totalCostUsd: "", totalUsdPerMtok: "", totalUsdPerItem: "", jevCostUsd: "", jevUsdPerMtok: "", gatewayCostUsd: "", gatewayUsdPerMtok: "", budgetUsd: "", budgetStatus: "", verdict: "" }),
    }),
  );
}
