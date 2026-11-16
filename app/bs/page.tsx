"use client";

import { useEffect, useState } from "react";
import {
  BS_LEVELS,
  BS_SOURCES,
  BS_VERDICTS,
  buildBsCorpus,
  bsBadgeClass,
  type BsBatchItem,
  type BsDecision,
  type BsGates,
  type BsSignals,
  type BsSource,
  type BsVerdict,
  DEFAULT_GATES,
} from "@/lib/bs";
import { ConfidenceBadge } from "@/components/charts/ConfidenceBadge";

type ScreenResponse = {
  signals?: BsSignals;
  decision?: BsDecision;
  gates?: BsGates;
  model?: string;
  provider?: string;
  usage?: { input_tokens: number; output_tokens: number };
  trace?: unknown;
  error?: string;
};

type BatchResponse = {
  items: BsBatchItem[];
  totals: {
    screened: number;
    errors: number;
    verdicts: Record<BsVerdict, number>;
    bySource: Record<BsSource, Record<BsVerdict, number>>;
    usage: { input_tokens: number; output_tokens: number };
  };
  gates: BsGates;
  model: string;
  provider: string;
  error?: string;
};

function BsBadge({ verdict }: { verdict: BsVerdict }) {
  return <span className={`badge ${bsBadgeClass(verdict)}`}>{verdict.toUpperCase()}</span>;
}

function SourceBadge({ source }: { source: BsSource }) {
  return <span className="badge neutral">{source === "email" ? "✉ email" : "▶ video"}</span>;
}

function intensityName(v: number): string {
  return BS_LEVELS[Math.min(BS_LEVELS.length - 1, Math.floor(v))] ?? "?";
}

function ItemRow({ item }: { item: BsBatchItem }) {
  return (
    <div style={{ marginBottom: 10, paddingBottom: 8, borderBottom: "1px solid rgba(154,164,184,.12)" }}>
      <div className="row between">
        <span className="mono" style={{ fontSize: 12 }}>
          <strong>{item.id}</strong> {item.label.slice(0, 64)}
          {item.label.length > 64 ? "…" : ""} <SourceBadge source={item.source} />
        </span>
        {item.error ? (
          <span className="badge bad">error</span>
        ) : item.verdict ? (
          <BsBadge verdict={item.verdict} />
        ) : null}
      </div>
      {item.signals && (
        <div className="row" style={{ gap: 6, marginTop: 4, flexWrap: "wrap" }}>
          <span className="badge neutral">
            intensity: {item.signals.bs.toFixed(1)} ({intensityName(item.signals.bs)})
          </span>
          <span className="badge neutral">malice: {item.signals.malice.toFixed(2)}</span>
          <span className="badge neutral">payoff: {item.signals.payoff.toFixed(2)}</span>
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

export default function BsPage() {
  const [state, setState] = useState(
    "Subject: CONGRATULATIONS! You WON a FREE iPhone 17!\n\nDear lucky winner, claim your prize within 24 hours. " +
      "Enter your card number, CVV and home address at www.phoney-claims.example to receive your reward. " +
      "The CEO personally picked you. Do NOT tell anyone — limited stock!",
  );
  const [result, setResult] = useState<ScreenResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dev, setDev] = useState(false);

  const [gates, setGates] = useState<BsGates>(DEFAULT_GATES);
  const [batch, setBatch] = useState<BatchResponse | null>(null);
  const [batchLimit, setBatchLimit] = useState<number | null>(null);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<"all" | BsSource>("all");
  const [raw, setRaw] = useState("");

  const corpus = buildBsCorpus();
  const corpusCount =
    sourceFilter === "all"
      ? corpus.length
      : corpus.filter((c) => c.source === sourceFilter).length;

  useEffect(() => {
    setDev(new URLSearchParams(window.location.search).get("dev") === "1");
  }, []);

  async function runScreen() {
    setLoading(true);
    setError(null);
    const req: Record<string, unknown> = {
      state,
      gates,
      ...(dev ? { dev: true } : {}),
    };
    try {
      const res = await fetch("/api/bs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      const data: ScreenResponse = await res.json();
      if (!res.ok) throw new Error(data.error || "BS screen failed");
      setResult(data);
      setRaw((prev) =>
        JSON.stringify(
          {
            ...(prev ? JSON.parse(prev) : {}),
            last: { request: { ...req, state: `${state.slice(0, 160)}…` }, response: data },
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

  function setGate(key: keyof BsGates, v: number) {
    setGates((g) => ({ ...g, [key]: v }));
  }

  async function runBatch(limit: number | null) {
    setBatchLoading(true);
    setBatchError(null);
    setBatchLimit(limit);
    const req: Record<string, unknown> = {
      gates,
      ...(limit === null ? { limit: null } : { limit }),
      ...(sourceFilter !== "all" ? { sources: [sourceFilter] } : {}),
    };
    try {
      const res = await fetch("/api/bs-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      const data: BatchResponse = await res.json();
      if (!res.ok) throw new Error(data.error || "BS batch failed");
      setBatch(data);
      setBatchLimit(data.totals.screened);
      setRaw((prev) =>
        JSON.stringify(
          {
            ...(prev ? JSON.parse(prev) : {}),
            batch: {
              request: { ...req, corpus: `${corpusCount} items (merged stream)` },
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
      <h1>Internet BS detector — unified</h1>
      <p className="subtitle">
        UC#7 · email spam + YouTube clickbait in ONE pipeline — intensity (Score) +
        malice &amp; payoff (Noul) decide clean / suspicious / bs in CODE · merged
        90-item corpus, batch ladder 5 → 10 → All, tallies per source
      </p>

      {error && <div className="error-banner">{error}</div>}

      <div className="grid cols-2" style={{ gap: 16, alignItems: "start" }}>
        <div>
          <div className="card">
            <label className="muted" style={{ fontSize: 12 }}>
              paste any internet junk — subject/title + body/description
            </label>
            <textarea
              value={state}
              onChange={(e) => setState(e.target.value)}
              rows={8}
              style={{ width: "100%", resize: "vertical" }}
            />
            <div className="row" style={{ gap: 12, marginTop: 10, alignItems: "center" }}>
              <button onClick={runScreen} disabled={loading} className="primary">
                {loading ? "Screening…" : "Screen for BS"}
              </button>
              <span className="muted" style={{ fontSize: 12 }}>
                the classifier answers typed questions; the verdict is picked in code
              </span>
            </div>

            <div className="grid cols-2" style={{ marginTop: 14, gap: 10 }}>
              {(
                [
                  ["bsAt", `BS at (intensity ≥)`, 0, 4, 0.5],
                  ["cleanAt", `clean at (intensity ≤)`, 0, 4, 0.5],
                  ["maliceBlockAt", "malice floor", 0, 1, 0.05],
                  ["payoffFloor", "payoff floor", 0, 1, 0.05],
                  ["lowConfBump", "confidence demotion", 0, 1, 0.05],
                ] as [keyof BsGates, string, number, number, number][]
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
                <strong>BS verdict</strong>
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
                <BsBadge verdict={result.decision.verdict} />
                {s && (
                  <>
                    <span className="badge neutral">
                      intensity: {s.bs.toFixed(1)} (
                      {BS_LEVELS[Math.min(Math.floor(s.bs), BS_LEVELS.length - 1)]})
                    </span>
                    <span className="badge neutral">malice: {s.malice.toFixed(2)}</span>
                    <span className="badge neutral">payoff: {s.payoff.toFixed(2)}</span>
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
              <strong>Batch discipline · merged corpus</strong>
              <span className="muted" style={{ fontSize: 12 }}>
                {corpusCount} items (email + video) · 5 → 10 → All
              </span>
            </div>
            <div className="row" style={{ gap: 8, marginBottom: 10 }}>
              {(["all", "email", "video"] as const).map((src) => (
                <button
                  key={src}
                  className={sourceFilter === src ? "primary" : undefined}
                  onClick={() => setSourceFilter(src)}
                >
                  {src === "all" ? "Both sources" : src === "email" ? "Emails only" : "Videos only"}
                </button>
              ))}
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
                  {BS_VERDICTS.map((v) => (
                    <div key={v} className="stat-tile">
                      <div className="label">verdict: {v}</div>
                      <div className="value">
                        <span className={`badge ${bsBadgeClass(v)}`}>{batch.totals.verdicts[v]}</span>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="row" style={{ gap: 14, marginTop: 10, flexWrap: "wrap" }}>
                  {BS_SOURCES.map((src) => (
                    <span key={src} className="muted" style={{ fontSize: 12.5 }}>
                      <SourceBadge source={src} /> clean {batch.totals.bySource[src].clean} · susp{" "}
                      {batch.totals.bySource[src].suspicious} · bs {batch.totals.bySource[src].bs}
                    </span>
                  ))}
                </div>
                <div className="row between" style={{ margin: "12px 0", fontSize: 13 }}>
                  <span>
                    <span className="badge good">{batch.totals.screened} screened</span>{" "}
                    <span className="muted mono" style={{ fontSize: 12 }}>
                      {batch.totals.usage.input_tokens}↑ {batch.totals.usage.output_tokens}↓ tok
                    </span>{" "}
                    {batch.totals.errors > 0 && (
                      <span className="badge bad">{batch.totals.errors} errors</span>
                    )}
                  </span>
                  <span className="muted mono" style={{ fontSize: 12 }}>
                    gates bs≥{batch.gates.bsAt} clean≤{batch.gates.cleanAt} · malice{" "}
                    {batch.gates.maliceBlockAt.toFixed(2)}
                  </span>
                </div>
                {batch.items.map((it) => (
                  <ItemRow key={it.id} item={it} />
                ))}
              </>
            )}
          </div>
        </div>

        <div className="card">
          <strong>Raw JSON</strong>
          <pre className="mono" style={{ marginTop: 10, maxHeight: 480, overflow: "auto" }}>
            {raw || "screen an item to see the wire"}
          </pre>
        </div>
      </div>
    </div>
  );
}
