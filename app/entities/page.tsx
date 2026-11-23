"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_GATES,
  ENTITY_VERDICTS,
  SIMILARITY_LEVELS,
  buildEntityCorpus,
  entityBadgeClass,
  entityClusterExportRows,
  entityPairExportRows,
  type EntityBatchItem,
  type EntityCluster,
  type EntityDecision,
  type EntityGates,
  type EntitySignals,
  type EntityVerdict,
  type BlockedJoin,
} from "@/lib/entities";
import { ExportButtons } from "@/components/ExportButtons";
import { ConfidenceBadge } from "@/components/charts/ConfidenceBadge";

type AlignResponse = {
  signals?: EntitySignals;
  decision?: EntityDecision;
  gates?: EntityGates;
  model?: string;
  provider?: string;
  usage?: { input_tokens: number; output_tokens: number };
  trace?: unknown;
  error?: string;
};

type BatchResponse = {
  items: EntityBatchItem[];
  totals: {
    compared: number;
    errors: number;
    verdicts: Record<EntityVerdict, number>;
    usage: { input_tokens: number; output_tokens: number };
  };
  clusters: EntityCluster[];
  blocked: BlockedJoin[];
  gates: EntityGates;
  model: string;
  provider: string;
  error?: string;
  /** SQLite spike: the store's receipt for this run (null + persistError if it missed) */
  persisted?: { runId: string; savedAt: string; limit: number | null } | null;
  persistError?: string | null;
};

/** UC#10-persist: one server-persisted run, read back after a restart. */
type StoredRunWire = {
  runId: string;
  lane: string;
  savedAt: string;
  limit: number | null;
  summary: { compared: number; errors: number };
  payload: BatchResponse;
};

type RunsResponse = {
  run: StoredRunWire | null;
  recent: { runId: string; savedAt: string; limit: number | null; summary: { compared: number; errors: number } }[];
  counts: { total: number; readable: number };
  error?: string;
};

function VerdictBadge({ verdict }: { verdict: EntityVerdict }) {
  return <span className={`badge ${entityBadgeClass(verdict)}`}>{verdict.toUpperCase()}</span>;
}

function similarityName(v: number): string {
  return SIMILARITY_LEVELS[Math.min(SIMILARITY_LEVELS.length - 1, Math.floor(v))] ?? "?";
}

function PairRow({ item }: { item: EntityBatchItem }) {
  return (
    <div style={{ marginBottom: 10, paddingBottom: 8, borderBottom: "1px solid rgba(154,164,184,.12)" }}>
      <div className="row between">
        <span className="mono" style={{ fontSize: 12 }}>
          <strong>{item.aId}</strong> “{item.a.name.slice(0, 44)}{item.a.name.length > 44 ? "…" : ""}”
          {"  ↔  "}
          <strong>{item.bId}</strong> “{item.b.name.slice(0, 44)}{item.b.name.length > 44 ? "…" : ""}”
        </span>
        {item.error ? (
          <span className="badge bad">error</span>
        ) : item.verdict ? (
          <VerdictBadge verdict={item.verdict} />
        ) : null}
      </div>
      {item.signals && (
        <div className="row" style={{ gap: 6, marginTop: 4, flexWrap: "wrap" }}>
          <span className="badge neutral">
            similarity: {item.signals.similarity.toFixed(1)} ({similarityName(item.signals.similarity)})
          </span>
          <span className="badge neutral">conflict: {item.signals.conflict.toFixed(2)}</span>
          <span className="badge neutral">generic name: {item.signals.genericName.toFixed(2)}</span>
        </div>
      )}
      {item.error && <div className="muted" style={{ fontSize: 12 }}>{item.error}</div>}
      {item.reasons && item.reasons.length > 0 && (
        <ul className="muted" style={{ fontSize: 11.5, margin: "6px 0 0", paddingLeft: 16 }}>
          {item.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function EntitiesPage() {
  const [nameA, setNameA] = useState("Brevona Barista 200 espresso maker");
  const [modelA, setModelA] = useState("BR-200");
  const [detailA, setDetailA] = useState("used, box included");
  const [nameB, setNameB] = useState("Barista 200 espresso machine — Brevona BR200");
  const [modelB, setModelB] = useState("BR200");
  const [detailB, setDetailB] = useState("gently used");
  const [result, setResult] = useState<AlignResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dev, setDev] = useState(false);

  const [gates, setGates] = useState<EntityGates>(DEFAULT_GATES);
  const [batch, setBatch] = useState<BatchResponse | null>(null);
  const [batchLimit, setBatchLimit] = useState<number | null>(null);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [raw, setRaw] = useState("");

  // UC#10-persist (SQLite spike): the server-persisted run restored on
  // page load. The per-run store receipt rides the batch payload itself.
  const [restored, setRestored] = useState<StoredRunWire | null>(null);
  const [storeCounts, setStoreCounts] = useState<{ total: number; readable: number } | null>(null);

  const corpus = buildEntityCorpus();

  useEffect(() => {
    setDev(new URLSearchParams(window.location.search).get("dev") === "1");
  }, []);

  useEffect(() => {
    // restore the newest persisted run from the server store — this is
    // the spike's whole point: the report rides SQLite, not the browser.
    let cancelled = false;
    fetch("/api/entities-batch")
      .then((res) => (res.ok ? (res.json() as Promise<RunsResponse>) : null))
      .then((data) => {
        if (cancelled || !data || data.error) return;
        setStoreCounts(data.counts ?? null);
        const run = data.run;
        if (run && Array.isArray(run.payload?.items) && run.payload.items.length > 0) {
          setBatch(run.payload);
          setBatchLimit(run.limit ?? run.payload.totals.compared);
          setRestored(run);
        }
      })
      .catch(() => {
        // a cold or broken store simply means nothing to restore —
        // the page still boots clean (the GET endpoint owns the error).
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function runAlign() {
    setLoading(true);
    setError(null);
    const req = {
      a: { id: "uA", name: nameA, model: modelA || undefined, detail: detailA || undefined },
      b: { id: "uB", name: nameB, model: modelB || undefined, detail: detailB || undefined },
      gates,
      ...(dev ? { dev: true } : {}),
    };
    try {
      const res = await fetch("/api/entities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      const data: AlignResponse = await res.json();
      if (!res.ok) throw new Error(data.error || "entity alignment failed");
      setResult(data);
      setRaw((prev) =>
        JSON.stringify(
          {
            ...(prev ? JSON.parse(prev) : {}),
            last: { request: req, response: data },
          },
          null,
          2,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  function setGate(key: keyof EntityGates, v: number) {
    setGates((g) => ({ ...g, [key]: v }));
  }

  async function runBatch(limit: number | null) {
    setBatchLoading(true);
    setBatchError(null);
    setBatchLimit(limit);
    const req: Record<string, unknown> = {
      gates,
      ...(limit === null ? { limit: null } : { limit }),
    };
    try {
      const res = await fetch("/api/entities-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      const data: BatchResponse = await res.json();
      if (!res.ok) throw new Error(data.error || "entity batch failed");
      setBatch(data);
      setBatchLimit(data.totals.compared);
      // this session's run replaces the restored one; the store receipt
      // rides the batch payload visibly — a persistence miss is shown,
      // never swallowed.
      setRestored(null);
      setRaw((prev) =>
        JSON.stringify(
          {
            ...(prev ? JSON.parse(prev) : {}),
            batch: {
              request: { ...req, corpus: `${corpus.length} pairs (market audit)` },
              response: data,
            },
          },
          null,
          2,
        ),
      );
    } catch (e) {
      setBatchError(e instanceof Error ? e.message : "failed");
      setBatch(null);
    } finally {
      setBatchLoading(false);
    }
  }

  const s = result?.signals;

  return (
    <div>
      <h1>Entity alignment / dedup</h1>
      <p className="subtitle">
        UC#10 · two marketplace records in, distinct / review / merge out — similarity (Score) +
        conflict &amp; generic-name (Noul) decide the verdict IN CODE · 25-pair synthetic market
        audit, batch ladder 5 → 10 → All · merge is the <strong>destructive lane</strong>: a hard
        identifier contradiction forces a pair apart, a generic name can never merge on its own,
        and doubt never enters the join lane · merge edges then fold into contradiction-safe
        clusters (a chain never overrules a called separation) exported through the D8 pipeline ·{" "}
        <strong>SQLite spike</strong>: finished reports persist server-side, <strong>survive a
        restart</strong>, and reload themselves — the store refuses any payload its shape guard
        does not recognize
      </p>

      {error && <div className="error-banner">{error}</div>}

      {restored && (
        <div className="card" style={{ marginBottom: 16, borderLeft: "3px solid rgba(94,234,212,.45)" }}>
          <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}>
            <span style={{ fontSize: 13 }}>
              <strong>Restored from SQLite</strong> — run <span className="mono">{restored.runId}</span>{" "}
              (rung {restored.limit === null ? "All" : restored.limit} · {restored.summary.compared}{" "}
              compared · {restored.summary.errors} errors) was persisted server-side at{" "}
              <span className="mono">{restored.savedAt}</span> and <strong>survived the restart</strong>:
              this board is the store&apos;s memory, not the browser&apos;s.
            </span>
            {storeCounts && storeCounts.total > 0 && (
              <span className="muted mono" style={{ fontSize: 12 }}>
                store: {storeCounts.readable}/{storeCounts.total} runs readable
              </span>
            )}
          </div>
        </div>
      )}

      <div className="grid cols-2" style={{ gap: 16, alignItems: "start" }}>
        <div>
          <div className="card">
            <label className="muted" style={{ fontSize: 12 }}>
              record A — name / model / detail (identity is what aligns, not ad copy)
            </label>
            <input
              value={nameA}
              onChange={(e) => setNameA(e.target.value)}
              maxLength={160}
              style={{ width: "100%", marginTop: 4 }}
            />
            <div className="grid cols-2" style={{ gap: 8, marginTop: 6 }}>
              <input
                value={modelA}
                onChange={(e) => setModelA(e.target.value)}
                placeholder="model"
                maxLength={80}
                style={{ width: "100%" }}
              />
              <input
                value={detailA}
                onChange={(e) => setDetailA(e.target.value)}
                placeholder="detail"
                maxLength={160}
                style={{ width: "100%" }}
              />
            </div>
            <label className="muted" style={{ fontSize: 12, marginTop: 10, display: "block" }}>
              record B
            </label>
            <input
              value={nameB}
              onChange={(e) => setNameB(e.target.value)}
              maxLength={160}
              style={{ width: "100%", marginTop: 4 }}
            />
            <div className="grid cols-2" style={{ gap: 8, marginTop: 6 }}>
              <input
                value={modelB}
                onChange={(e) => setModelB(e.target.value)}
                placeholder="model"
                maxLength={80}
                style={{ width: "100%" }}
              />
              <input
                value={detailB}
                onChange={(e) => setDetailB(e.target.value)}
                placeholder="detail"
                maxLength={160}
                style={{ width: "100%" }}
              />
            </div>
            <div className="row" style={{ gap: 12, marginTop: 10, alignItems: "center" }}>
              <button onClick={runAlign} disabled={loading} className="primary">
                {loading ? "Aligning…" : "Align this pair"}
              </button>
              <span className="muted" style={{ fontSize: 12 }}>
                the classifier answers typed questions; the verdict is picked in code
              </span>
            </div>

            <div className="grid cols-2" style={{ marginTop: 14, gap: 10 }}>
              {(
                [
                  ["mergeAt", `merge at (similarity ≥)`, 0, 4, 0.5],
                  ["distinctAt", `distinct at (similarity ≤)`, 0, 4, 0.5],
                  ["conflictFloor", "conflict floor", 0, 1, 0.05],
                  ["collisionCap", "generic-name cap", 0, 1, 0.05],
                  ["lowConfBump", "confidence demotion", 0, 1, 0.05],
                ] as [keyof EntityGates, string, number, number, number][]
              ).map(([key, label, min, max, step]) => (
                <label
                  key={key}
                  className="muted"
                  style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 8 }}
                >
                  {label}
                  <input
                    type="range"
                    min={min}
                    max={max}
                    step={step}
                    value={gates[key]}
                    onChange={(e) => setGate(key, Number(e.target.value))}
                  />
                  <strong className="mono">{gates[key].toFixed(2)}</strong>
                </label>
              ))}
            </div>
          </div>

          {result?.decision && (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="row between" style={{ marginBottom: 10 }}>
                <strong>Alignment verdict</strong>
                <span className="muted" style={{ fontSize: 12 }}>
                  classifier: {result.provider} · {result.model} ·{" "}
                  {result.usage && (
                    <span className="mono">
                      {result.usage.input_tokens}↑ {result.usage.output_tokens}↓ tok
                    </span>
                  )}
                </span>
              </div>
              <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <VerdictBadge verdict={result.decision.verdict} />
                {s && (
                  <>
                    <span className="badge neutral">
                      similarity: {s.similarity.toFixed(1)} (
                      {SIMILARITY_LEVELS[Math.min(Math.floor(s.similarity), SIMILARITY_LEVELS.length - 1)]})
                    </span>
                    <span className="badge neutral">conflict: {s.conflict.toFixed(2)}</span>
                    <span className="badge neutral">generic name: {s.genericName.toFixed(2)}</span>
                    <ConfidenceBadge value={s.confidence} />
                  </>
                )}
              </div>
              <ul className="muted" style={{ fontSize: 12.5, margin: "8px 0 0", paddingLeft: 18 }}>
                {result.decision.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="card" style={{ marginTop: 16 }}>
            <div className="row between" style={{ marginBottom: 8 }}>
              <strong>Batch discipline · market audit</strong>
              <span className="muted" style={{ fontSize: 12 }}>
                {corpus.length} pairs · 5 → 10 → All
              </span>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button onClick={() => runBatch(5)} disabled={batchLoading}>
                {batchLoading && batchLimit === 5 ? "Running 5…" : "Run batch 5"}
              </button>
              <button onClick={() => runBatch(10)} disabled={batchLoading}>
                {batchLoading && batchLimit === 10 ? "Running 10…" : "Expand to 10"}
              </button>
              <button onClick={() => runBatch(null)} disabled={batchLoading}>
                {batchLoading && batchLimit === null ? "Running all…" : "Run All"}
              </button>
            </div>
            {batchError && <div className="error-banner" style={{ marginTop: 10 }}>{batchError}</div>}
            {batch && (
              <>
                <div className="grid cols-3" style={{ marginTop: 12, gap: 10 }}>
                  {ENTITY_VERDICTS.map((v) => (
                    <div key={v} className="stat-tile">
                      <div className="label">verdict: {v}</div>
                      <div className="value">
                        <span className={`badge ${entityBadgeClass(v)}`}>{batch.totals.verdicts[v]}</span>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="row between" style={{ margin: "12px 0", fontSize: 13 }}>
                  <span>
                    <span className="badge good">{batch.totals.compared} compared</span>{" "}
                    <span className="muted mono" style={{ fontSize: 12 }}>
                      {batch.totals.usage.input_tokens}↑ {batch.totals.usage.output_tokens}↓ tok
                    </span>{" "}
                    {batch.totals.errors > 0 && (
                      <span className="badge bad">{batch.totals.errors} errors</span>
                    )}{" "}
                    {batch.persisted ? (
                      <span className="badge good" title={batch.persisted.runId}>
                        persisted · SQLite
                      </span>
                    ) : batch.persistError ? (
                      <span className="badge bad">persist failed: {batch.persistError}</span>
                    ) : null}
                  </span>
                  <span className="muted mono" style={{ fontSize: 12 }}>
                    gates merge≥{batch.gates.mergeAt} distinct≤{batch.gates.distinctAt} · conflict{" "}
                    {batch.gates.conflictFloor.toFixed(2)}
                  </span>
                </div>
                {batch.clusters.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <div className="row between" style={{ alignItems: "center" }}>
                      <strong style={{ fontSize: 13 }}>Aligned clusters · merge edges folded in code</strong>
                      <ExportButtons
                        filename={`entity-clusters-${batch.clusters.length}`}
                        rows={entityClusterExportRows(batch.clusters)}
                      />
                    </div>
                    <p className="muted" style={{ fontSize: 12, margin: "4px 0 8px" }}>
                      transitive but never contradicting — strongest evidence first; a chain that
                      would park two records the code already separated in one cluster is{" "}
                      <strong>refused and logged</strong>, never silently folded
                    </p>
                    <table>
                      <thead>
                        <tr>
                          <th>canonical</th>
                          <th>size</th>
                          <th>members</th>
                          <th>edges</th>
                        </tr>
                      </thead>
                      <tbody>
                        {batch.clusters.map((c) => (
                          <tr key={c.canonical}>
                            <td className="mono">{c.canonical}</td>
                            <td className="mono">{c.members.length}</td>
                            <td className="mono">{c.members.join(", ")}</td>
                            <td className="mono">{c.edges.join(", ")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {batch.blocked.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <strong style={{ fontSize: 13 }}>Refused joins · contradiction-safe folding</strong>
                    <ul className="muted" style={{ fontSize: 12, margin: "4px 0 8px", paddingLeft: 16 }}>
                      {batch.blocked.map((bj) => (
                        <li key={bj.pairId} className="mono">
                          {bj.pairId} ({bj.a} ↔ {bj.b}): {bj.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="row between" style={{ alignItems: "center", marginBottom: 4 }}>
                  <strong style={{ fontSize: 13 }}>Pair verdicts</strong>
                  <ExportButtons
                    filename={`entity-pairs-${batch.items.length}`}
                    rows={entityPairExportRows(batch.items)}
                  />
                </div>
                {batch.items.map((it) => (
                  <PairRow key={it.id} item={it} />
                ))}
              </>
            )}
          </div>
        </div>

        <div className="card">
          <strong>Raw JSON</strong>
          <pre className="mono" style={{ marginTop: 10, maxHeight: 480, overflow: "auto" }}>
            {raw || "align a pair to see the wire"}
          </pre>
        </div>
      </div>
    </div>
  );
}
