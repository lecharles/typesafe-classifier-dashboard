"use client";

import { useEffect, useMemo, useState } from "react";
import {
  HARNESS_DATASETS,
  agreementBadgeClass,
  agreementRateLabel,
  buildHarnessItems,
  computeHarnessTotals,
  harnessStatusBadgeClass,
  type HarnessDatasetId,
  type HarnessItemReport,
  type HarnessReport,
  type HarnessTotals,
  type ItemStatus,
} from "@/lib/harness";
import { latencyLabel } from "@/lib/compare";
import { ExportButtons } from "@/components/ExportButtons";
import { saveRun, loadRun, clearStoredRun } from "@/lib/persist";
import type { ExportRow } from "@/lib/export";

const STORAGE_KEY = "harness";

function StatusBadge({ status }: { status: ItemStatus }) {
  const label = status === "na" ? "N/A" : status.toUpperCase();
  return <span className={`badge ${harnessStatusBadgeClass(status)}`}>{label}</span>;
}

export default function HarnessPage() {
  const [datasets, setDatasets] = useState<HarnessDatasetId[]>(["emails", "youtube"]);
  const [items, setItems] = useState<HarnessItemReport[]>([]);
  const [totals, setTotals] = useState<HarnessTotals | null>(null);
  const [limit, setLimit] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [raw, setRaw] = useState("");
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // D8 pattern: restore the last harness run after a refresh.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = loadRun(window.localStorage, STORAGE_KEY);
    if (stored) {
      const restored = stored.results as HarnessItemReport[];
      setItems(restored);
      setTotals(computeHarnessTotals(restored));
      setSavedAt(stored.savedAt);
    }
  }, []);

  const corpus = useMemo(() => buildHarnessItems(["emails", "youtube"]), []);
  const selectedCount = corpus.filter((i) => datasets.includes(i.dataset)).length;

  function toggleDataset(id: HarnessDatasetId) {
    setDatasets((d) => (d.includes(id) ? d.filter((x) => x !== id) : [...d, id]));
  }

  async function runHarnessrung(rung: number | null) {
    setLoading(true);
    setError(null);
    setLimit(rung);
    const items = corpus.filter((i) => datasets.includes(i.dataset));
    const req = { items, limit: rung };
    try {
      const res = await fetch("/api/harness", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      const data: HarnessReport & { error?: string } = await res.json();
      if (!res.ok) throw new Error(data.error || "comparison harness failed");
      setItems(data.items);
      setTotals(data.totals);
      setLimit(data.totals.items);
      if (typeof window !== "undefined") {
        setSavedAt(saveRun(window.localStorage, STORAGE_KEY, data.items));
      }
      setRaw(
        JSON.stringify(
          { request: { ...req, items: `${items.length} items (${rung ?? "All"})` }, response: data },
          null,
          2,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setLoading(false);
    }
  }

  function clearRun() {
    setItems([]);
    setTotals(null);
    setRaw("");
    setSavedAt(null);
    if (typeof window !== "undefined") clearStoredRun(window.localStorage, STORAGE_KEY);
  }

  const exportRows: ExportRow[] = items.map((it) => {
    const row: ExportRow = {
      id: it.id,
      dataset: it.dataset,
      status: it.status,
      jev_error: it.jev.error ?? "",
      emulated_error: it.emulated.error ?? "",
    };
    for (const [qid, a] of Object.entries(it.agreement)) {
      row[`agreement_${qid}`] = a;
      row[`jev_${qid}`] = it.jevDecisions[qid] ?? "";
      row[`emulated_${qid}`] = it.emulatedDecisions[qid] ?? "";
    }
    return row;
  });

  const qRows = totals
    ? Object.entries(totals.perQuestion).map(([qid, r]) => ({ qid, ...r }))
    : [];

  return (
    <div>
      <h1>Emulated vs Jev</h1>
      <p className="subtitle">
        D14 · the comparison harness — every item runs through the real TypeSafe/Jev API
        AND the emulated gateway; agreement is decided IN CODE · batch discipline
        5 → 10 → All
      </p>

      {error && <div className="error-banner">{error}</div>}

      <div className="grid cols-2" style={{ gap: 16, alignItems: "start" }}>
        <div>
          <div className="card">
            <div className="row between" style={{ marginBottom: 8 }}>
              <strong>Comparison corpus</strong>
              <span className="muted" style={{ fontSize: 12 }}>
                {selectedCount} states selected · synthetic data
              </span>
            </div>
            <div className="row" style={{ gap: 14, flexWrap: "wrap" }}>
              {HARNESS_DATASETS.map((d) => (
                <label
                  key={d.id}
                  className="muted"
                  style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}
                >
                  <input
                    type="checkbox"
                    checked={datasets.includes(d.id)}
                    onChange={() => toggleDataset(d.id)}
                  />
                  {d.label}
                </label>
              ))}
            </div>
            <div className="row" style={{ gap: 8, marginTop: 12 }}>
              <button onClick={() => runHarnessrung(5)} disabled={loading || datasets.length === 0}>
                {loading && limit === 5 ? "Running 5…" : "Run batch 5"}
              </button>
              <button onClick={() => runHarnessrung(10)} disabled={loading || datasets.length === 0}>
                {loading && limit === 10 ? "Running 10…" : "Expand to 10"}
              </button>
              <button
                onClick={() => runHarnessrung(null)}
                disabled={loading || datasets.length === 0}
                className="primary"
              >
                {loading && limit === null ? "Running all…" : "Run All (both backends)"}
              </button>
              <button className="ghost" onClick={clearRun} disabled={loading}>
                Clear
              </button>
            </div>
            {savedAt && (
              <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                last run restored · saved {savedAt}
              </div>
            )}
          </div>

          {totals && (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="row between" style={{ marginBottom: 10 }}>
                <strong>Agreement</strong>
                <span className="muted" style={{ fontSize: 12 }}>
                  jev: {totals.jevModel || "—"} · emulated: {totals.emulatedModel || "—"}
                </span>
              </div>
              <div className="grid cols-3" style={{ gap: 10 }}>
                <div className="stat-tile">
                  <div className="label">agreement rate</div>
                  <div className="value">{agreementRateLabel(totals.agreementRate)}</div>
                </div>
                <div className="stat-tile">
                  <div className="label">compared items</div>
                  <div className="value">{totals.compared}</div>
                </div>
                <div className="stat-tile">
                  <div className="label">n/a (one side failed)</div>
                  <div className="value">{totals.na}</div>
                </div>
              </div>
              <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                <span className="badge good">{totals.matches} match</span>
                <span className="badge warn">{totals.diffs} diff</span>
                <span className="badge neutral">{totals.na} n/a</span>
                {totals.jevErrors > 0 && <span className="badge bad">{totals.jevErrors} jev errors</span>}
                {totals.emulatedErrors > 0 && (
                  <span className="badge bad">{totals.emulatedErrors} emulated errors</span>
                )}
              </div>
              <div className="grid cols-2" style={{ gap: 10, marginTop: 12 }}>
                <div className="stat-tile">
                  <div className="label">Jev latency avg / p95</div>
                  <div className="value" style={{ fontSize: 15 }}>
                    {latencyLabel(totals.jevAvgLatency)} / {latencyLabel(totals.jevP95Latency)}
                  </div>
                </div>
                <div className="stat-tile">
                  <div className="label">Emulated latency avg / p95</div>
                  <div className="value" style={{ fontSize: 15 }}>
                    {latencyLabel(totals.emulatedAvgLatency)} / {latencyLabel(totals.emulatedP95Latency)}
                  </div>
                </div>
              </div>
              <div className="muted mono" style={{ fontSize: 12, marginTop: 8 }}>
                jev tokens {totals.jevUsage.input_tokens}↑ {totals.jevUsage.output_tokens}↓ · emulated{" "}
                {totals.emulatedUsage.input_tokens}↑ {totals.emulatedUsage.output_tokens}↓
              </div>
            </div>
          )}

          {qRows.length > 0 && (
            <div className="card" style={{ marginTop: 16 }}>
              <strong style={{ display: "block", marginBottom: 8 }}>Per-question agreement</strong>
              <table>
                <thead>
                  <tr>
                    <th>question</th>
                    <th>match</th>
                    <th>diff</th>
                    <th>n/a</th>
                    <th>rate</th>
                  </tr>
                </thead>
                <tbody>
                  {qRows.map((r) => (
                    <tr key={r.qid}>
                      <td className="mono">{r.qid}</td>
                      <td>{r.match}</td>
                      <td>{r.diff}</td>
                      <td>{r.na}</td>
                      <td>{agreementRateLabel(r.rate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div>
          <div className="card">
            <div className="row between" style={{ marginBottom: 8 }}>
              <strong>Item-by-item verdicts</strong>
              <ExportButtons filename="jev-vs-emulated" rows={exportRows} />
            </div>
            {items.length === 0 && (
              <p className="muted" style={{ fontSize: 13 }}>
                run a batch to compare the two backends side by side.
              </p>
            )}
            {items.map((it) => (
              <div
                key={it.id}
                style={{ marginBottom: 10, paddingBottom: 8, borderBottom: "1px solid rgba(154,164,184,.12)" }}
              >
                <div className="row between">
                  <span className="mono" style={{ fontSize: 12 }}>
                    <strong>{it.id}</strong>
                    <span className="muted"> · {it.dataset}</span>
                  </span>
                  <StatusBadge status={it.status} />
                </div>
                {(!it.jev.ok || !it.emulated.ok) && (
                  <div className="muted" style={{ fontSize: 12 }}>
                    {it.jev.error && <span>jev: {it.jev.error} </span>}
                    {it.emulated.error && <span>emulated: {it.emulated.error}</span>}
                  </div>
                )}
                {it.status !== "na" && (
                  <table style={{ marginTop: 6 }}>
                    <thead>
                      <tr>
                        <th>question</th>
                        <th>Jev ({latencyLabel(it.jev.latency_ms)})</th>
                        <th>Emulated ({latencyLabel(it.emulated.latency_ms)})</th>
                        <th>agree</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(it.agreement).map(([qid, a]) => (
                        <tr key={qid}>
                          <td className="mono">{qid}</td>
                          <td>{fmtLabel(it.jevDecisions[qid])}</td>
                          <td>{fmtLabel(it.emulatedDecisions[qid])}</td>
                          <td>
                            <span className={`badge ${agreementBadgeClass(a)}`}>{a}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <strong>Raw JSON</strong>
            <pre className="mono" style={{ marginTop: 10, maxHeight: 420, overflow: "auto" }}>
              {raw || "run a batch to see the wire"}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}

function fmtLabel(v: string | null): string {
  return v === null || v === undefined ? "—" : v;
}
