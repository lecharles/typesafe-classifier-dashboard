"use client";

import { useEffect, useState } from "react";
import {
  BUDGET_WARN_SHARE,
  DEFAULT_BUDGET_USD,
  DEFAULT_RATES,
  costExportRows,
  type CostLedger,
  type CostLine,
  type CostReceipt,
  type CostRollup,
} from "@/lib/cost";
import { ExportButtons } from "@/components/ExportButtons";

type Snapshot = {
  sourceKind: "harness" | "store" | "manual";
  receipts: CostReceipt[];
  rates: typeof DEFAULT_RATES;
  ledger: CostLedger;
  counts: { seen: number; kept: number; rejected: number; skipped: number };
  generatedAt: string;
};

type WireResponse = Snapshot & {
  note?: string | null;
  rejected?: { row: number; reason: string; preview: string }[];
  persisted?: { runId: string; savedAt: string; limit: number | null } | null;
  persistError?: string | null;
  error?: string;
};

type StoredRunWire = {
  runId: string;
  lane: string;
  savedAt: string;
  limit: number | null;
  summary: { compared: number; errors: number };
  payload: Snapshot;
};

const RUNGS = [5, 10, null] as const; // null = All

const money = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `$${x}`);
const tok = (x: number) => x.toLocaleString("en-US");

const budgetBadge = (b: CostLedger["budget"]) =>
  b.status === "over" ? "bad" : b.status === "warn" ? "warn" : b.status === "ok" ? "good" : "neutral";

function ProviderCard({ label, rollup }: { label: string; rollup: CostRollup }) {
  return (
    <div className="card" style={{ flex: 1, minWidth: 220 }}>
      <div className="num">{label}</div>
      <h3 style={{ margin: "4px 0" }}>{money(rollup.costUsd)}</h3>
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        <span className="badge neutral">{rollup.receipts} receipts</span>
        <span className="badge neutral">{rollup.items} items</span>
        <span className="badge neutral">{tok(rollup.tokens)} tok</span>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        effective {rollup.usdPerMtok === null ? "—" : `$${rollup.usdPerMtok}/Mtok`} · per item{" "}
        {rollup.usdPerItem === null ? "—" : `$${rollup.usdPerItem}`}
      </div>
    </div>
  );
}

function LineRow({ l, total }: { l: CostLine; total: number }) {
  const share = total > 0 ? Math.min(100, (l.costUsd / total) * 100) : 0;
  return (
    <tr>
      <td className="mono" title={l.id}>
        {l.lane}
        <div style={{ position: "relative", height: 6, background: "rgba(255,255,255,.05)", borderRadius: 3, marginTop: 4 }}>
          <div style={{ position: "absolute", left: 0, top: 0, height: 6, width: `${share}%`, background: "rgba(94,234,212,.55)", borderRadius: 3 }} />
        </div>
      </td>
      <td>
        <span className={`badge ${l.provider === "jev" ? "good" : "neutral"}`}>{l.provider}</span>
      </td>
      <td>{l.source}</td>
      <td className="mono">{l.items}</td>
      <td className="mono">{tok(l.inputTokens)}</td>
      <td className="mono">{tok(l.outputTokens)}</td>
      <td className="mono">{money(l.costUsd)}</td>
      <td className="mono">{l.usdPerItem === null ? "—" : money(l.usdPerItem)}</td>
      <td className="mono">{l.usdPerMtok === null ? "—" : `$${l.usdPerMtok}`}</td>
    </tr>
  );
}

export default function CostPage() {
  const [snap, setSnap] = useState<WireResponse | null>(null);
  const [restored, setRestored] = useState<StoredRunWire | null>(null);
  const [store, setStore] = useState<{ lane: string; runs: number; newest: string }[]>([]);
  const [storeCounts, setStoreCounts] = useState<{ total: number; readable: number } | null>(null);
  const [history, setHistory] = useState<{ runId: string; savedAt: string; summary: { compared: number; errors: number } }[]>([]);
  const [running, setRunning] = useState<number | "store" | "manual" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [manualJson, setManualJson] = useState("");
  const [jevIn, setJevIn] = useState(String(DEFAULT_RATES.jev.inputUsdPerMtok));
  const [jevOut, setJevOut] = useState(String(DEFAULT_RATES.jev.outputUsdPerMtok));
  const [gwIn, setGwIn] = useState(String(DEFAULT_RATES.gateway.inputUsdPerMtok));
  const [gwOut, setGwOut] = useState(String(DEFAULT_RATES.gateway.outputUsdPerMtok));
  const [budget, setBudget] = useState(String(DEFAULT_BUDGET_USD));

  useEffect(() => {
    fetch("/api/cost")
      .then((r) => r.json())
      .then((d) => {
        if (d?.run) {
          setRestored(d.run);
          setSnap(d.run.payload as WireResponse);
        }
        if (d?.recent) setHistory(d.recent);
        if (d?.counts) setStoreCounts(d.counts);
        if (d?.store) setStore(d.store);
      })
      .catch(() => {});
  }, []);

  function rateOverrides() {
    const jevInN = Number(jevIn);
    const jevOutN = Number(jevOut);
    const gwInN = Number(gwIn);
    const gwOutN = Number(gwOut);
    if (![jevInN, jevOutN, gwInN, gwOutN].every((x) => Number.isFinite(x) && x >= 0)) {
      throw new Error("rates must be finite non-negative $/Mtok numbers — the guard never rescues");
    }
    const budgetN = budget.trim() === "" || budget.trim().toLowerCase() === "null" ? null : Number(budget);
    if (budgetN !== null && (!Number.isFinite(budgetN) || budgetN <= 0)) {
      throw new Error("budget must be a positive number or empty (unset)");
    }
    return {
      rates: {
        jev: { inputUsdPerMtok: jevInN, outputUsdPerMtok: jevOutN },
        gateway: { inputUsdPerMtok: gwInN, outputUsdPerMtok: gwOutN },
      },
      budgetUsd: budgetN,
    };
  }

  async function priceHarness(limit: number | null) {
    setRunning(limit);
    setErr(null);
    setRestored(null);
    try {
      let cfg: ReturnType<typeof rateOverrides>;
      try {
        cfg = rateOverrides();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "rates refused");
        return;
      }
      const hr = await fetch("/api/harness", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ datasets: ["emails", "youtube"], limit }),
      });
      const report = await hr.json();
      if (!hr.ok) {
        setErr(report?.error ?? `harness failed with HTTP ${hr.status}`);
        return;
      }
      const cr = await fetch("/api/cost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "harness", report, ...cfg }),
      });
      const d: WireResponse = await cr.json();
      if (!cr.ok) {
        setErr(d?.error ?? `cost pricing failed with HTTP ${cr.status}`);
        return;
      }
      setSnap(d);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "cost run failed");
    } finally {
      setRunning(null);
    }
  }

  async function priceStore() {
    setRunning("store");
    setErr(null);
    setRestored(null);
    try {
      let cfg: ReturnType<typeof rateOverrides>;
      try {
        cfg = rateOverrides();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "rates refused");
        return;
      }
      const cr = await fetch("/api/cost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "store", ...cfg }),
      });
      const d: WireResponse = await cr.json();
      if (!cr.ok) {
        setErr(d?.error ?? `store pricing failed with HTTP ${cr.status}`);
        return;
      }
      setSnap(d);
      // the ledger we just wrote is now the store's newest cost run
      fetch("/api/cost")
        .then((r) => r.json())
        .then((g) => {
          if (g?.store) setStore(g.store);
          if (g?.counts) setStoreCounts(g.counts);
        })
        .catch(() => {});
    } catch (e) {
      setErr(e instanceof Error ? e.message : "store pricing failed");
    } finally {
      setRunning(null);
    }
  }

  async function priceManual() {
    setRunning("manual");
    setErr(null);
    setRestored(null);
    try {
      let rows: unknown;
      try {
        rows = JSON.parse(manualJson);
      } catch {
        setErr("manual lane wants a JSON array of {lane, provider, items, usage}");
        return;
      }
      let cfg: ReturnType<typeof rateOverrides>;
      try {
        cfg = rateOverrides();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "rates refused");
        return;
      }
      const cr = await fetch("/api/cost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "manual", rows, ...cfg }),
      });
      const d: WireResponse = await cr.json();
      if (!cr.ok) {
        setErr(d?.error ?? `manual pricing failed with HTTP ${cr.status}`);
        return;
      }
      setSnap(d);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "manual pricing failed");
    } finally {
      setRunning(null);
    }
  }

  const led = snap?.ledger ?? null;

  return (
    <div>
      <h1>Cost / token dashboard — Jev $/Mtok tracking</h1>
      <p className="subtitle">
        11-27 · every lane burns tokens; this page prices the receipts <strong>IN CODE</strong>.
        The D14 harness books <strong>two receipts per run</strong> (Jev vs emulated, same states),
        the SQLite store books <strong>yesterday&apos;s batch runs</strong> off disk — a dead side is{" "}
        <strong>skipped and counted</strong>, never a $0 spend story. Effective $/Mtok is{" "}
        <strong>weighted</strong> (Σcost ÷ Σtokens), rates travel with every snapshot, and a ledger
        that disagrees with its own receipts <strong>never reloads</strong>.
      </p>

      {restored && (
        <div className="card" style={{ marginBottom: 16, borderLeft: "3px solid rgba(94,234,212,.45)" }}>
          <span style={{ fontSize: 13 }}>
            <strong>Restored from SQLite</strong> — cost snapshot <span className="mono">{restored.runId}</span>{" "}
            ({restored.summary.compared} rows seen · {restored.summary.errors} skipped/refused) persisted at{" "}
            <span className="mono">{restored.savedAt}</span> and <strong>survived the restart</strong>
            {storeCounts && storeCounts.total > 0 && (
              <>
                {" "}· store: {storeCounts.readable}/{storeCounts.total} readable
              </>
            )}
            .
          </span>
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <strong>Rate sheet ($/Mtok)</strong>
        <div className="row" style={{ gap: 12, flexWrap: "wrap", marginTop: 8 }}>
          {(
            [
              ["Jev in", jevIn, setJevIn],
              ["Jev out", jevOut, setJevOut],
              ["Gateway in", gwIn, setGwIn],
              ["Gateway out", gwOut, setGwOut],
              ["Budget $ (empty = unset)", budget, setBudget],
            ] as const
          ).map(([label, value, set]) => (
            <label key={label} style={{ fontSize: 12 }}>
              {label}
              <input
                type="number"
                min={0}
                step="0.001"
                value={value}
                onChange={(e) => set(e.target.value)}
                style={{ marginLeft: 6, width: 110, fontFamily: "monospace" }}
              />
            </label>
          ))}
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          defaults = the live-VPS gateway billing rate ($0.042/Mtok in; out priced equal until a real
          bill says otherwise) — edits price the NEXT snapshot; every stored snapshot keeps the rates
          it was priced at. Warn threshold: {Math.round(BUDGET_WARN_SHARE * 100)}% of budget.
        </div>
      </div>

      {store.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <strong>What is on disk</strong>
          <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 8 }}>
            {store.map((s) => (
              <span key={s.lane} className="badge neutral">
                {s.lane}: {s.runs} run{s.runs === 1 ? "" : "s"} · latest {s.newest.slice(0, 16)}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}>
          <strong>Price the live hub (D14 harness ladder)</strong>
          <span className="row" style={{ gap: 8 }}>
            {RUNGS.map((r) => (
              <button key={String(r)} onClick={() => priceHarness(r)} disabled={running !== null}>
                {running === r ? "Running…" : r === null ? "Price All" : `Price ${r}`}
              </button>
            ))}
          </span>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          each run sends the bundled corpus through BOTH backends once, then books the harness&apos;s
          own usage columns — jev vs gateway, priced side by side. No new model calls are invented here.
        </div>
        <div className="row between" style={{ flexWrap: "wrap", gap: 8, marginTop: 12 }}>
          <strong>Price the SQLite store (all lanes, off disk)</strong>
          <button onClick={priceStore} disabled={running !== null}>
            {running === "store" ? "Scanning…" : "Read the store"}
          </button>
        </div>
        {err && <div className="error-banner" style={{ marginTop: 10 }}>{err}</div>}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <strong>Manual receipts</strong>
        <div className="muted" style={{ fontSize: 12, margin: "4px 0 8px" }}>
          bring your own usage receipts — <span className="mono">[{`{"lane":"my-lane","provider":"jev","items":10,"usage":{"input_tokens":12000,"output_tokens":800}}`}]</span>{" "}
          — refused rows ride the receipt with row numbers.
        </div>
        <textarea
          value={manualJson}
          onChange={(e) => setManualJson(e.target.value)}
          placeholder='[{"lane":"ops","provider":"jev","items":12,"usage":{"input_tokens":48000,"output_tokens":3600}}]'
          style={{ width: "100%", minHeight: 90, fontFamily: "monospace", fontSize: 12 }}
        />
        <div className="row" style={{ gap: 12, marginTop: 8, alignItems: "center" }}>
          <button onClick={priceManual} disabled={running !== null || !manualJson.trim()} className="primary">
            {running === "manual" ? "Guarding…" : "Price manual receipts"}
          </button>
          <span className="muted" style={{ fontSize: 12 }}>THE LEDGER NEVER TRUSTS A PAYLOAD</span>
        </div>
        {snap?.rejected && snap.rejected.length > 0 && (
          <div className="error-banner" style={{ marginTop: 10 }}>
            {snap.rejected.map((r) => (
              <div key={`${r.row}-${r.reason}`}>
                row {r.row}: {r.reason} — <span className="mono">{r.preview}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {led && (
        <>
          <div className="row" style={{ gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
            <div className="card" style={{ flex: 1, minWidth: 240 }}>
              <div className="num">TOTAL SPEND</div>
              <h3 style={{ margin: "4px 0" }}>{money(led.total.costUsd)}</h3>
              <div className="muted" style={{ fontSize: 12 }}>
                {led.lines.length} receipts · {led.total.items} items · {tok(led.total.tokens)} tokens
              </div>
              <div style={{ marginTop: 8 }}>
                <span className={`badge ${budgetBadge(led.budget)}`}>
                  {led.budget.status === "unset"
                    ? "budget unset"
                    : led.budget.status === "over"
                      ? `over budget by ${money(Math.abs(led.budget.marginUsd ?? 0))}`
                      : `${Math.round((led.budget.share ?? 0) * 100)}% of ${money(led.budget.budgetUsd)} · margin ${money(led.budget.marginUsd)}`}
                </span>
              </div>
              {led.budget.share !== null && (
                <div style={{ position: "relative", height: 8, background: "rgba(255,255,255,.06)", borderRadius: 4, marginTop: 8 }}>
                  <div
                    style={{
                      position: "absolute",
                      left: 0,
                      top: 0,
                      height: 8,
                      width: `${Math.min(100, led.budget.share * 100)}%`,
                      background: led.budget.status === "over" ? "#f87171" : led.budget.status === "warn" ? "#fbbf24" : "#5eead4",
                      borderRadius: 4,
                    }}
                  />
                </div>
              )}
            </div>
            <ProviderCard label="JEV $/Mtok" rollup={led.byProvider.jev} />
            <ProviderCard label="GATEWAY (emulated)" rollup={led.byProvider.gateway} />
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="row between" style={{ flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
              <strong>Receipt ledger · {snap?.sourceKind}</strong>
              <span className="row" style={{ gap: 8, alignItems: "center" }}>
                {snap?.persisted ? (
                  <span className="badge good">persisted · SQLite {snap.persisted.runId}</span>
                ) : snap?.persistError ? (
                  <span className="badge bad">persist failed: {snap.persistError}</span>
                ) : null}
                <ExportButtons filename={`cost-ledger-${led.lines.length}`} rows={costExportRows(led)} />
              </span>
            </div>
            <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
              <span className="badge neutral">{snap?.counts.seen} rows seen</span>
              <span className="badge good">{snap?.counts.kept} priced</span>
              {(snap?.counts.skipped ?? 0) > 0 && <span className="badge warn">{snap?.counts.skipped} skipped-and-counted</span>}
              {(snap?.counts.rejected ?? 0) > 0 && <span className="badge bad">{snap?.counts.rejected} refused</span>}
              <span className="badge neutral">
                rates: jev ${led.rates.jev.inputUsdPerMtok}/${led.rates.jev.outputUsdPerMtok} · gateway $
                {led.rates.gateway.inputUsdPerMtok}/{led.rates.gateway.outputUsdPerMtok} per Mtok
              </span>
            </div>
            {snap?.note && <div className="error-banner" style={{ marginBottom: 10 }}>{snap.note}</div>}
            <table>
              <thead>
                <tr>
                  <th>lane</th>
                  <th>provider</th>
                  <th>source</th>
                  <th>items</th>
                  <th>in tok</th>
                  <th>out tok</th>
                  <th>cost</th>
                  <th>$/item</th>
                  <th>$/Mtok eff.</th>
                </tr>
              </thead>
              <tbody>
                {led.lines.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="muted">
                      nothing priced yet — receipts appear here. An empty ledger says a loud nothing, never a fake zero.
                    </td>
                  </tr>
                ) : (
                  led.lines.map((l) => <LineRow key={l.id} l={l} total={led.total.costUsd} />)
                )}
              </tbody>
            </table>
            <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              lane bar = share of total spend · $/Mtok eff. is weighted per receipt (Σcost ÷ Σtokens × 1e6),
              null when nothing moved — never an average of averages.
            </div>
            <div style={{ marginTop: 10, fontSize: 13 }}>
              <strong>Verdict:</strong> {led.verdict}
            </div>
          </div>

          {history.length > 0 && (
            <div className="card">
              <strong>Store history · lane &quot;cost&quot;</strong>
              <table style={{ marginTop: 8 }}>
                <thead>
                  <tr>
                    <th>run</th>
                    <th>saved</th>
                    <th>rows</th>
                    <th>skipped/refused</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.runId}>
                      <td className="mono">{h.runId}</td>
                      <td className="mono">{h.savedAt}</td>
                      <td className="mono">{h.summary.compared}</td>
                      <td className="mono">{h.summary.errors}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
