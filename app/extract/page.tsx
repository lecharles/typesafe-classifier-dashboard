"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_GATES,
  EXTRACT_STATUS,
  PRECISION_LEVELS,
  statusBadgeClass,
  type CandidateResult,
  type ExtractGates,
  type ExtractStatus,
} from "@/lib/extract";
import { extractionCorpus } from "@/data/extraction-corpus";
import { ConfidenceBadge } from "@/components/charts/ConfidenceBadge";

type ExtractResponse = {
  anchor?: string;
  results?: CandidateResult[];
  gates?: ExtractGates;
  model?: string;
  provider?: string;
  usage?: { input_tokens: number; output_tokens: number };
  trace?: unknown;
  error?: string;
};

type BatchResponse = {
  items: Array<{
    id: string;
    text: string;
    results?: CandidateResult[];
    usage?: { input_tokens: number; output_tokens: number };
    error?: string;
  }>;
  totals: {
    snippets: number;
    candidates: number;
    errors: number;
    statuses: Record<ExtractStatus, number>;
    usage: { input_tokens: number; output_tokens: number };
  };
  anchor: string;
  gates: ExtractGates;
  model: string;
  provider: string;
  error?: string;
};

function StatusBadge({ status }: { status: ExtractStatus }) {
  return (
    <span className={`badge ${statusBadgeClass(status)}`}>
      {status.toUpperCase()}
    </span>
  );
}

function precisionName(p: number): string {
  return PRECISION_LEVELS[
    Math.min(PRECISION_LEVELS.length - 1, Math.floor(p))
  ] ?? "?";
}

function CandidateRow({ c }: { c: CandidateResult }) {
  return (
    <div
      style={{
        marginBottom: 10,
        paddingBottom: 8,
        borderBottom: "1px solid rgba(154,164,184,.12)",
      }}
    >
      <div className="row between">
        <span className="mono" style={{ fontSize: 12 }}>
          <strong>{c.token}</strong>{" "}
          <span className="muted">({c.kindDetected})</span>
          {c.value !== null && (
            <>
              {" → "}
              <strong>{c.value}</strong>
            </>
          )}
        </span>
        <StatusBadge status={c.status} />
      </div>
      {c.signals && (
        <div
          className="row"
          style={{ gap: 6, marginTop: 4, flexWrap: "wrap" }}
        >
          <span className="badge neutral">kind: {c.signals.kind}</span>
          <span className="badge neutral">
            precision: {c.signals.precision.toFixed(1)} ({precisionName(c.signals.precision)})
          </span>
          <span className="badge neutral">
            ambiguous: {c.signals.ambiguous.toFixed(2)}
          </span>
        </div>
      )}
      {c.reasons.length > 0 && (
        <ul
          className="muted"
          style={{ fontSize: 11.5, margin: "6px 0 0", paddingLeft: 16 }}
        >
          {c.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function ExtractPage() {
  const [text, setText] = useState(
    "We sign the renewal 03/04/2026 at 09:00; deposit $5k, kickoff tomorrow. (Payroll deadline 2026-02-30 — the form let me type it.)",
  );
  const [anchor, setAnchor] = useState("2026-11-18");
  const [result, setResult] = useState<ExtractResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dev, setDev] = useState(false);

  const [gates, setGates] = useState<ExtractGates>(DEFAULT_GATES);
  const [batch, setBatch] = useState<BatchResponse | null>(null);
  const [batchLimit, setBatchLimit] = useState<number | null>(null);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [raw, setRaw] = useState("");

  useEffect(() => {
    setDev(new URLSearchParams(window.location.search).get("dev") === "1");
  }, []);

  async function runExtract() {
    setLoading(true);
    setError(null);
    const req: Record<string, unknown> = {
      text,
      ...(anchor.trim() ? { anchor: anchor.trim() } : {}),
      gates,
      ...(dev ? { dev: true } : {}),
    };
    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      const data: ExtractResponse = await res.json();
      if (!res.ok) throw new Error(data.error || "extraction failed");
      setResult(data);
      setRaw((prev) =>
        JSON.stringify(
          {
            ...(prev ? JSON.parse(prev) : {}),
            last: { request: { ...req, text: text.slice(0, 80) }, response: data },
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

  function setGate(key: keyof ExtractGates, v: number) {
    setGates((g) => ({ ...g, [key]: v }));
  }

  async function runBatch(limit: number | null) {
    setBatchLoading(true);
    setBatchError(null);
    setBatchLimit(limit);
    const req: Record<string, unknown> = {
      ...(limit === null ? { limit: null } : { limit }),
      ...(anchor.trim() ? { anchor: anchor.trim() } : {}),
      gates,
    };
    try {
      const res = await fetch("/api/extract-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      const data: BatchResponse = await res.json();
      if (!res.ok) throw new Error(data.error || "extraction batch failed");
      setBatch(data);
      setBatchLimit(data.totals.snippets);
      setRaw((prev) =>
        JSON.stringify(
          {
            ...(prev ? JSON.parse(prev) : {}),
            batch: {
              request: { ...req, corpus: `${extractionCorpus.length} snippets` },
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

  const s = result?.results?.[0]?.signals;

  return (
    <div>
      <h1>Date/value extractor</h1>
      <p className="subtitle">
        UC#8 live · normalize messy dates or amounts — CODE detects, validates,
        and normalizes every token; kind (Choice) + precision (Score) +
        ambiguity (Noul) decide resolved / guessed / vague / rejected IN CODE ·
        batch discipline 5 → 10 → All over the messy-snippet corpus · invalid
        dates are never normalized, conventions are never shipped clean
      </p>

      {error && <div className="error-banner">{error}</div>}

      <div className="grid cols-2" style={{ gap: 16, alignItems: "start" }}>
        <div>
          <div className="card">
            <label className="muted" style={{ fontSize: 12 }}>
              messy text (tickets, notes, chats — dates and amounts in human forms)
            </label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={5}
              style={{ width: "100%", resize: "vertical" }}
            />
            <label
              className="muted"
              style={{ fontSize: 12, marginTop: 8, display: "block" }}
            >
              anchor date (YYYY-MM-DD — pins “tomorrow”, “next Friday”; empty = server today)
            </label>
            <input
              value={anchor}
              onChange={(e) => setAnchor(e.target.value)}
              className="mono"
              style={{ width: 200 }}
              placeholder="2026-11-18"
            />
            <div
              className="row"
              style={{ gap: 12, marginTop: 10, alignItems: "center" }}
            >
              <button onClick={runExtract} disabled={loading} className="primary">
                {loading ? "Extracting…" : "Extract values"}
              </button>
              <span className="muted" style={{ fontSize: 12 }}>
                detection, validation, and normalization are pure code; the reader only flags
              </span>
            </div>

            <div className="grid cols-2" style={{ marginTop: 14, gap: 10 }}>
              {(
                [
                  ["resolveAt", "resolve at (precision ≥)", 0, 4, 0.5],
                  ["ambiguousFloor", "ambiguity floor", 0, 1, 0.05],
                  ["lowConfBump", "confidence demotion", 0, 1, 0.05],
                ] as [keyof ExtractGates, string, number, number, number][]
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

          {result?.results && (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="row between" style={{ marginBottom: 10 }}>
                <strong>Extraction results</strong>
                <span className="muted" style={{ fontSize: 12 }}>
                  anchor {result.anchor} · classifier: {result.provider} ·{" "}
                  {result.model} ·{" "}
                  {result.usage && (
                    <span className="mono">
                      {result.usage.input_tokens}↑ {result.usage.output_tokens}↓ tok
                    </span>
                  )}
                </span>
              </div>
              {result.results.length === 0 && (
                <div className="muted" style={{ fontSize: 13 }}>
                  no date or money candidates detected — nothing extracted, never fabricated.
                </div>
              )}
              {result.results.map((c, i) => (
                <CandidateRow key={`${c.token}-${i}`} c={c} />
              ))}
              {s && (
                <div className="row" style={{ gap: 8, marginTop: 6 }}>
                  <ConfidenceBadge value={s.confidence} />
                </div>
              )}
            </div>
          )}

          <div className="card" style={{ marginTop: 16 }}>
            <div className="row between" style={{ marginBottom: 8 }}>
              <strong>Batch discipline · snippet ladder</strong>
              <span className="muted" style={{ fontSize: 12 }}>
                {extractionCorpus.length} messy snippets · 5 → 10 → All
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
            {batchError && (
              <div className="error-banner" style={{ marginTop: 10 }}>
                {batchError}
              </div>
            )}
            {batch && (
              <>
                <div className="grid cols-2" style={{ marginTop: 12, gap: 10 }}>
                  {EXTRACT_STATUS.map((st) => (
                    <div key={st} className="stat-tile">
                      <div className="label">status: {st}</div>
                      <div className="value">
                        <span className={`badge ${statusBadgeClass(st)}`}>
                          {batch.totals.statuses[st]}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="row between" style={{ margin: "12px 0", fontSize: 13 }}>
                  <span>
                    <span className="badge good">
                      {batch.totals.snippets} snippets
                    </span>{" "}
                    <span className="badge neutral">
                      {batch.totals.candidates} candidates
                    </span>{" "}
                    <span className="muted mono" style={{ fontSize: 12 }}>
                      {batch.totals.usage.input_tokens}↑{" "}
                      {batch.totals.usage.output_tokens}↓ tok
                    </span>{" "}
                    {batch.totals.errors > 0 && (
                      <span className="badge bad">{batch.totals.errors} errors</span>
                    )}
                  </span>
                  <span className="muted mono" style={{ fontSize: 12 }}>
                    anchor {batch.anchor} · resolve≥{batch.gates.resolveAt} ·
                    amb {batch.gates.ambiguousFloor.toFixed(2)}
                  </span>
                </div>
                {batch.items.map((it) => (
                  <div
                    key={it.id}
                    style={{
                      marginBottom: 12,
                      paddingBottom: 8,
                      borderBottom: "1px solid rgba(154,164,184,.12)",
                    }}
                  >
                    <div className="row between">
                      <span className="mono" style={{ fontSize: 12 }}>
                        <strong>{it.id}</strong>{" "}
                        {it.text.slice(0, 72)}
                        {it.text.length > 72 ? "…" : ""}
                      </span>
                      {it.error && <span className="badge bad">error</span>}
                    </div>
                    {it.error && (
                      <div className="muted" style={{ fontSize: 12 }}>
                        {it.error}
                      </div>
                    )}
                    {it.results?.map((c, i) => (
                      <CandidateRow key={`${it.id}-${c.token}-${i}`} c={c} />
                    ))}
                    {it.results?.length === 0 && (
                      <div className="muted" style={{ fontSize: 12 }}>
                        no candidates — nothing extracted, never fabricated.
                      </div>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        </div>

        <div className="card">
          <strong>Raw JSON</strong>
          <pre className="mono" style={{ marginTop: 10, maxHeight: 480, overflow: "auto" }}>
            {raw || "extract a text to see the wire"}
          </pre>
        </div>
      </div>
    </div>
  );
}
