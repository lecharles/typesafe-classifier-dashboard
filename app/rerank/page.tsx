"use client";

import { useEffect, useState } from "react";
import {
  COVERAGE_NOTE,
  DEFAULT_RERANK_GATES,
  DISPOSITIONS,
  RELEVANCE_LEVELS,
  type Coverage,
  type PassageDisposition,
  type RerankGates,
  type RerankSignals,
  dispositionBadgeClass,
} from "@/lib/rerank";
import { RAG_QUERY, ragPassages } from "@/data/passages";

type RankedItem = {
  id: string;
  text: string;
  signals?: RerankSignals;
  finalDisposition?: PassageDisposition;
  finalReasons?: string[];
};

type RerankResponse = {
  ranked?: RankedItem[];
  coverage?: { coverage: Coverage; shipped: number; benched: number; dropped: number };
  gates?: RerankGates;
  model?: string;
  provider?: string;
  usage?: { input_tokens: number; output_tokens: number };
  error?: string;
};

type BatchItem = {
  id: string;
  text: string;
  signals?: RerankSignals;
  disposition?: PassageDisposition;
  reasons?: string[];
  error?: string;
};

type BatchResponse = {
  query: string;
  items: BatchItem[];
  totals: {
    passages: number;
    errors: number;
    shipped: number;
    benched: number;
    dropped: number;
    coverage: Coverage;
    usage: { input_tokens: number; output_tokens: number };
  };
  gates: RerankGates;
  model: string;
  provider: string;
  error?: string;
};

function DispositionBadge({ d }: { d: PassageDisposition }) {
  return <span className={`badge ${dispositionBadgeClass(d)}`}>{d.toUpperCase()}</span>;
}

function coverageBadgeClass(c: Coverage): "good" | "warn" | "bad" {
  return c === "grounded" ? "good" : c === "thin" ? "warn" : "bad";
}

function relevanceName(r: number): string {
  return RELEVANCE_LEVELS[Math.min(RELEVANCE_LEVELS.length - 1, Math.floor(r))] ?? "?";
}

function RankRow({
  item,
  disposition,
  reasons,
}: {
  item: { id: string; text: string; signals?: RerankSignals; error?: string };
  disposition?: PassageDisposition;
  reasons?: string[];
}) {
  return (
    <div style={{ marginBottom: 10, paddingBottom: 8, borderBottom: "1px solid rgba(154,164,184,.12)" }}>
      <div className="row between">
        <span className="mono" style={{ fontSize: 12 }}>
          <strong>{item.id}</strong> {item.text.slice(0, 56)}
          {item.text.length > 56 ? "…" : ""}
        </span>
        {item.error ? (
          <span className="badge bad">error</span>
        ) : disposition ? (
          <DispositionBadge d={disposition} />
        ) : null}
      </div>
      {item.signals && (
        <div className="row" style={{ gap: 6, marginTop: 4, flexWrap: "wrap" }}>
          <span className="badge neutral">relevance: {relevanceName(item.signals.relevance)}</span>
          <span className="badge neutral">grounding: {item.signals.grounding}</span>
          <span className="badge neutral">conflict: {item.signals.conflict.toFixed(2)}</span>
        </div>
      )}
      {item.error && <div className="muted" style={{ fontSize: 12 }}>{item.error}</div>}
      {reasons && reasons.length > 0 && (
        <ul className="muted" style={{ fontSize: 11.5, margin: "6px 0 0", paddingLeft: 16 }}>
          {reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function RerankPage() {
  const [query, setQuery] = useState(RAG_QUERY);
  const [result, setResult] = useState<RerankResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dev, setDev] = useState(false);

  const [gates, setGates] = useState<RerankGates>(DEFAULT_RERANK_GATES);
  const [batch, setBatch] = useState<BatchResponse | null>(null);
  const [batchLimit, setBatchLimit] = useState<number | null>(null);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [raw, setRaw] = useState("");

  useEffect(() => {
    setDev(new URLSearchParams(window.location.search).get("dev") === "1");
  }, []);

  async function runRerank() {
    setLoading(true);
    setError(null);
    const req: Record<string, unknown> = {
      query,
      passages: ragPassages.map((p) => ({ id: p.id, text: p.text })),
      gates,
      ...(dev ? { dev: true } : {}),
    };
    try {
      const res = await fetch("/api/rerank", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      const data: RerankResponse = await res.json();
      if (!res.ok) throw new Error(data.error || "rerank failed");
      setResult(data);
      setRaw((prev) =>
        JSON.stringify(
          {
            ...(prev ? JSON.parse(prev) : {}),
            last: { request: { ...req, passages: `${ragPassages.length} passages` }, response: data },
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

  async function runBatch(limit: number | null) {
    setBatchLoading(true);
    setBatchError(null);
    setBatchLimit(limit);
    const req: Record<string, unknown> = {
      query,
      passages: ragPassages.map((p) => ({ id: p.id, text: p.text })),
      gates,
      ...(limit === null ? { limit: null } : { limit }),
    };
    try {
      const res = await fetch("/api/rerank-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      const data: BatchResponse = await res.json();
      if (!res.ok) throw new Error(data.error || "rerank batch failed");
      setBatch(data);
      setBatchLimit(data.totals.passages);
      setRaw((prev) =>
        JSON.stringify(
          {
            ...(prev ? JSON.parse(prev) : {}),
            batch: { request: { ...req, passages: `${ragPassages.length} passages` }, response: data },
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

  function setGate(key: keyof RerankGates, v: number) {
    setGates((g) => ({ ...g, [key]: v }));
  }

  return (
    <div>
      <h1>RAG passage re-ranker</h1>
      <p className="subtitle">
        UC#5 · score retrieved passages and pick what reaches the answering
        model — relevance (Score) + grounding (Choice) + conflict Noul decide
        ship / bench / drop in CODE, with a top-k cut · batch discipline 5 → 10 → All
      </p>

      {error && <div className="error-banner">{error}</div>}

      <div className="grid cols-2" style={{ gap: 16, alignItems: "start" }}>
        <div>
          <div className="card">
            <label className="muted" style={{ fontSize: 12 }}>query</label>
            <textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              rows={2}
              style={{ width: "100%", resize: "vertical" }}
            />
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              {ragPassages.length} candidate passages in the demo corpus
            </div>
            <div className="row" style={{ gap: 12, marginTop: 10, alignItems: "center" }}>
              <button onClick={runRerank} disabled={loading} className="primary">
                {loading ? "Reranking…" : "Rerank corpus"}
              </button>
              <span className="muted" style={{ fontSize: 12 }}>
                each passage is a typed classification; the ranking is computed in code
              </span>
            </div>

            <div className="grid cols-2" style={{ marginTop: 14, gap: 10 }}>
              {(
                [
                  ["shipAt", "ship at (relevance ≥)", 0, 4, 1],
                  ["benchAt", "bench at (relevance ≥)", 0, 4, 1],
                  ["topK", "top-k ships", 0, 8, 1],
                  ["lowConfBump", "confidence bump", 0, 1, 0.05],
                  ["conflictBenchAt", "conflict bench at", 0, 1, 0.05],
                  ["conflictDropAt", "conflict drop at", 0, 1, 0.05],
                ] as [keyof RerankGates, string, number, number, number][]
              ).map(([key, label, min, max, step]) => (
                <label key={key} className="muted" style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 8 }}>
                  {label}
                  <input
                    type="range"
                    min={min}
                    max={max}
                    step={step}
                    value={gates[key]}
                    onChange={(e) => setGate(key, Number(e.target.value))}
                  />
                  <strong className="mono">{key === "topK" ? gates[key] : gates[key].toFixed(2)}</strong>
                </label>
              ))}
            </div>
          </div>

          {result?.ranked && (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="row between" style={{ marginBottom: 10 }}>
                <strong>Retrieval verdict</strong>
                <span className="muted" style={{ fontSize: 12 }}>
                  classifier: {result.provider} · {result.model}
                </span>
              </div>
              {result.coverage && (
                <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span className={`badge ${coverageBadgeClass(result.coverage.coverage)}`}>
                    {result.coverage.coverage.toUpperCase()}
                  </span>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {COVERAGE_NOTE[result.coverage.coverage]} · ship {result.coverage.shipped} ·
                    bench {result.coverage.benched} · drop {result.coverage.dropped}
                  </span>
                </div>
              )}
              <div style={{ marginTop: 10 }}>
                {result.ranked.map((it) => (
                  <RankRow
                    key={it.id}
                    item={it}
                    disposition={it.finalDisposition}
                    reasons={it.finalReasons}
                  />
                ))}
              </div>
            </div>
          )}

          <div className="card" style={{ marginTop: 16 }}>
            <div className="row between" style={{ marginBottom: 8 }}>
              <strong>Batch discipline · passage ladder</strong>
              <span className="muted" style={{ fontSize: 12 }}>
                {ragPassages.length} passages · 5 → 10 → All
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
                  {DISPOSITIONS.map((d) => (
                    <div key={d} className="stat-tile">
                      <div className="label">disposition: {d}</div>
                      <div className="value">
                        <span className={`badge ${dispositionBadgeClass(d)}`}>
                          {d === "ship" ? batch.totals.shipped : d === "bench" ? batch.totals.benched : batch.totals.dropped}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="row between" style={{ margin: "12px 0", fontSize: 13 }}>
                  <span>
                    <span className="badge good">{batch.totals.passages} passages</span>{" "}
                    <span className={`badge ${coverageBadgeClass(batch.totals.coverage)}`}>
                      {batch.totals.coverage}
                    </span>{" "}
                    {batch.totals.errors > 0 && (
                      <span className="badge bad">{batch.totals.errors} errors</span>
                    )}
                  </span>
                  <span className="muted mono" style={{ fontSize: 12 }}>
                    gates ship≥{batch.gates.shipAt} bench≥{batch.gates.benchAt} · k
                    {batch.gates.topK} · cf {batch.gates.conflictBenchAt.toFixed(2)}/
                    {batch.gates.conflictDropAt.toFixed(2)}
                  </span>
                </div>
                {batch.items.map((it) => (
                  <RankRow key={it.id} item={it} disposition={it.disposition} reasons={it.reasons} />
                ))}
              </>
            )}
          </div>
        </div>

        <div className="card">
          <strong>Raw JSON</strong>
          <pre className="mono" style={{ marginTop: 10, maxHeight: 480, overflow: "auto" }}>
            {raw || "rerank the corpus to see the wire"}
          </pre>
        </div>
      </div>
    </div>
  );
}
