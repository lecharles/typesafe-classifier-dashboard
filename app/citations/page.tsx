"use client";

import { useEffect, useState } from "react";
import {
  CITATION_VERDICTS,
  DEFAULT_CITATION_GATES,
  SPECIFICITY_LEVELS,
  type CitationDecision,
  type CitationGates,
  type CitationSignals,
  type CitationVerdict,
  citationBadgeClass,
} from "@/lib/citations";
import { ConfidenceBadge } from "@/components/charts/ConfidenceBadge";
import { claimCases } from "@/data/claims";

type CheckResponse = {
  signals?: CitationSignals;
  decision?: CitationDecision;
  gates?: CitationGates;
  model?: string;
  provider?: string;
  usage?: { input_tokens: number; output_tokens: number };
  error?: string;
};

type ItemReport = {
  id: string;
  claim: string;
  quote: string;
  verdict?: CitationVerdict;
  error?: string;
};

type BatchResponse = {
  items: ItemReport[];
  totals: {
    items: number;
    errors: number;
    checksRun: number;
    verdicts: Record<CitationVerdict, number>;
    usage: { input_tokens: number; output_tokens: number };
  };
  gates: CitationGates;
  model: string;
  provider: string;
  error?: string;
};

function VerdictBadge({ verdict }: { verdict: CitationVerdict }) {
  return (
    <span className={`badge ${citationBadgeClass(verdict)}`}>
      {verdict.toUpperCase()}
    </span>
  );
}

export default function CitationsPage() {
  const [claim, setClaim] = useState(
    "The Enterprise plan includes SSO with Okta.",
  );
  const [quote, setQuote] = useState(
    "Exports are available in CSV and JSON formats.",
  );
  const [result, setResult] = useState<CheckResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dev, setDev] = useState(false);

  const [gates, setGates] = useState<CitationGates>(DEFAULT_CITATION_GATES);
  const [batch, setBatch] = useState<BatchResponse | null>(null);
  const [batchLimit, setBatchLimit] = useState<number | null>(null);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [raw, setRaw] = useState("");

  useEffect(() => {
    setDev(new URLSearchParams(window.location.search).get("dev") === "1");
  }, []);

  async function runCheck() {
    setLoading(true);
    setError(null);
    const req: Record<string, unknown> = {
      claim,
      quote,
      gates,
      ...(dev ? { dev: true } : {}),
    };
    try {
      const res = await fetch("/api/citations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      const data: CheckResponse = await res.json();
      if (!res.ok) throw new Error(data.error || "citation check failed");
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

  async function runBatch(limit: number | null) {
    setBatchLoading(true);
    setBatchError(null);
    setBatchLimit(limit);
    const req: Record<string, unknown> = {
      items: claimCases.map((k) => ({ id: k.id, claim: k.claim, quote: k.quote })),
      gates,
      ...(limit === null ? { limit: null } : { limit }),
    };
    try {
      const res = await fetch("/api/citations-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      const data: BatchResponse = await res.json();
      if (!res.ok) throw new Error(data.error || "citation batch failed");
      setBatch(data);
      setBatchLimit(data.totals.items);
      setRaw((prev) =>
        JSON.stringify(
          {
            ...(prev ? JSON.parse(prev) : {}),
            batch: { request: { ...req, items: `${claimCases.length} claims` }, response: data },
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

  function setGate(key: keyof CitationGates, v: number) {
    setGates((g) => ({ ...g, [key]: v }));
  }

  const si = result?.signals;
  const levelName =
    si !== undefined
      ? SPECIFICITY_LEVELS[Math.min(SPECIFICITY_LEVELS.length - 1, Math.floor(si.specificity))] ??
        "?"
      : undefined;

  return (
    <div>
      <h1>Citation checker</h1>
      <p className="subtitle">
        UC#4 · does the quote support the claim? — support (Choice) +
        specificity (Score) + fabrication Noul decide pass / review / flag in
        CODE · batch discipline 5 → 10 → All
      </p>

      {error && <div className="error-banner">{error}</div>}

      <div className="grid cols-2" style={{ gap: 16, alignItems: "start" }}>
        <div>
          <div className="card">
            <label className="muted" style={{ fontSize: 12 }}>
              claim being made
            </label>
            <textarea
              value={claim}
              onChange={(e) => setClaim(e.target.value)}
              rows={2}
              style={{ width: "100%", resize: "vertical" }}
            />
            <label className="muted" style={{ fontSize: 12, marginTop: 8, display: "block" }}>
              quoted passage offered as support
            </label>
            <textarea
              value={quote}
              onChange={(e) => setQuote(e.target.value)}
              rows={3}
              style={{ width: "100%", resize: "vertical" }}
            />
            <div className="row" style={{ gap: 12, marginTop: 10, alignItems: "center" }}>
              <button onClick={runCheck} disabled={loading} className="primary">
                {loading ? "Checking…" : "Check citation"}
              </button>
              <span className="muted" style={{ fontSize: 12 }}>
                the classifier answers typed questions; the verdict is picked in code
              </span>
            </div>

            <div className="grid cols-2" style={{ marginTop: 14, gap: 10 }}>
              {(
                [
                  ["specificAt", "specific at (level ≥)", 0, 3, 1],
                  ["lowConfBump", "confidence bump", 0, 1, 0.05],
                  ["fabricationReviewAt", "fabrication review at", 0, 1, 0.05],
                  ["fabricationFlagAt", "fabrication flag at", 0, 1, 0.05],
                ] as [keyof CitationGates, string, number, number, number][]
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
                  <strong className="mono">{gates[key].toFixed(2)}</strong>
                </label>
              ))}
            </div>
          </div>

          {result?.decision && (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="row between" style={{ marginBottom: 10 }}>
                <strong>Citation verdict</strong>
                <span className="muted" style={{ fontSize: 12 }}>
                  classifier: {result.provider} · {result.model}
                </span>
              </div>
              <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <VerdictBadge verdict={result.decision.verdict} />
                {si && (
                  <>
                    <span className="badge neutral">support: {si.support}</span>
                    <span className="badge neutral">specificity: {levelName}</span>
                    <span className="badge neutral">fabrication: {si.fabrication.toFixed(2)}</span>
                    <ConfidenceBadge value={si.confidence} />
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
              <strong>Batch discipline · claim corpus</strong>
              <span className="muted" style={{ fontSize: 12 }}>
                {claimCases.length} claim/quote pairs · 5 → 10 → All
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
                  {CITATION_VERDICTS.map((v) => (
                    <div key={v} className="stat-tile">
                      <div className="label">verdict: {v}</div>
                      <div className="value">
                        <span className={`badge ${citationBadgeClass(v)}`}>{batch.totals.verdicts[v]}</span>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="row between" style={{ margin: "12px 0", fontSize: 13 }}>
                  <span>
                    <span className="badge good">{batch.totals.items} claims</span>{" "}
                    <span className="badge neutral">{batch.totals.checksRun} checks</span>{" "}
                    {batch.totals.errors > 0 && (
                      <span className="badge bad">{batch.totals.errors} errors</span>
                    )}
                  </span>
                  <span className="muted mono" style={{ fontSize: 12 }}>
                    gates spec{batch.gates.specificAt} · fab {batch.gates.fabricationReviewAt.toFixed(2)}
                    /{batch.gates.fabricationFlagAt.toFixed(2)}
                  </span>
                </div>
                {batch.items.map((it) => (
                  <div key={it.id} style={{ marginBottom: 10, paddingBottom: 8, borderBottom: "1px solid rgba(154,164,184,.12)" }}>
                    <div className="row between">
                      <span className="mono" style={{ fontSize: 12 }}>
                        <strong>{it.id}</strong> {it.claim.slice(0, 52)}
                        {it.claim.length > 52 ? "…" : ""}
                      </span>
                      {it.error ? (
                        <span className="badge bad">error</span>
                      ) : it.verdict ? (
                        <VerdictBadge verdict={it.verdict} />
                      ) : null}
                    </div>
                    {it.error && <div className="muted" style={{ fontSize: 12 }}>{it.error}</div>}
                  </div>
                ))}
              </>
            )}
          </div>
        </div>

        <div className="card">
          <strong>Raw JSON</strong>
          <pre className="mono" style={{ marginTop: 10, maxHeight: 480, overflow: "auto" }}>
            {raw || "check a citation to see the wire"}
          </pre>
        </div>
      </div>
    </div>
  );
}
