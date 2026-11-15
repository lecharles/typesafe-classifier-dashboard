"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_GATES,
  MEMBERSHIP,
  REUSE_LEVELS,
  type MemoryBatchItem,
  type MemoryGates,
  type MemorySignals,
  type Membership,
  type MembershipDecision,
  membershipBadgeClass,
} from "@/lib/memory";
import { memoryCandidates } from "@/data/memory-candidates";
import { ConfidenceBadge } from "@/components/charts/ConfidenceBadge";

type CurateResponse = {
  signals?: MemorySignals;
  decision?: MembershipDecision;
  gates?: MemoryGates;
  model?: string;
  provider?: string;
  usage?: { input_tokens: number; output_tokens: number };
  trace?: unknown;
  error?: string;
};

type BatchResponse = {
  items: MemoryBatchItem[];
  totals: {
    candidates: number;
    errors: number;
    verdicts: Record<Membership, number>;
    usage: { input_tokens: number; output_tokens: number };
  };
  gates: MemoryGates;
  model: string;
  provider: string;
  error?: string;
};

function MembershipBadge({ membership }: { membership: Membership }) {
  return (
    <span className={`badge ${membershipBadgeClass(membership)}`}>
      {membership.toUpperCase()}
    </span>
  );
}

function reuseName(r: number): string {
  return REUSE_LEVELS[Math.min(REUSE_LEVELS.length - 1, Math.floor(r))] ?? "?";
}

function CandidateRow({ item }: { item: MemoryBatchItem }) {
  return (
    <div style={{ marginBottom: 10, paddingBottom: 8, borderBottom: "1px solid rgba(154,164,184,.12)" }}>
      <div className="row between">
        <span className="mono" style={{ fontSize: 12 }}>
          <strong>{item.id}</strong> {item.request.slice(0, 64)}
          {item.request.length > 64 ? "…" : ""}
        </span>
        {item.error ? (
          <span className="badge bad">error</span>
        ) : item.membership ? (
          <MembershipBadge membership={item.membership} />
        ) : null}
      </div>
      {item.signals && (
        <div className="row" style={{ gap: 6, marginTop: 4, flexWrap: "wrap" }}>
          <span className="badge neutral">
            reuse: {item.signals.reuse.toFixed(1)} ({reuseName(item.signals.reuse)})
          </span>
          <span className="badge neutral">durable: {item.signals.durable.toFixed(2)}</span>
          <span className="badge neutral">pii: {item.signals.pii.toFixed(2)}</span>
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

export default function MemoryPage() {
  const [request, setRequest] = useState(
    "My name is Priya and I always prefer aisle seats. What's the weather in Lisbon tomorrow?",
  );
  const [answer, setAnswer] = useState(
    "Noted — aisle seats for you, Priya. Lisbon tomorrow: 17°C and drizzly.",
  );
  const [result, setResult] = useState<CurateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dev, setDev] = useState(false);

  const [gates, setGates] = useState<MemoryGates>(DEFAULT_GATES);
  const [batch, setBatch] = useState<BatchResponse | null>(null);
  const [batchLimit, setBatchLimit] = useState<number | null>(null);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [raw, setRaw] = useState("");

  useEffect(() => {
    setDev(new URLSearchParams(window.location.search).get("dev") === "1");
  }, []);

  async function runCurate() {
    setLoading(true);
    setError(null);
    const req: Record<string, unknown> = {
      request,
      ...(answer.trim() ? { answer } : {}),
      gates,
      ...(dev ? { dev: true } : {}),
    };
    try {
      const res = await fetch("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      const data: CurateResponse = await res.json();
      if (!res.ok) throw new Error(data.error || "memory curation failed");
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

  function setGate(key: keyof MemoryGates, v: number) {
    setGates((g) => ({ ...g, [key]: v }));
  }

  async function runBatch(limit: number | null) {
    setBatchLoading(true);
    setBatchError(null);
    setBatchLimit(limit);
    const req: Record<string, unknown> = {
      candidates: memoryCandidates.map((c) => ({
        id: c.id,
        request: c.request,
        ...(c.answer ? { answer: c.answer } : {}),
      })),
      gates,
      ...(limit === null ? { limit: null } : { limit }),
    };
    try {
      const res = await fetch("/api/memory-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      const data: BatchResponse = await res.json();
      if (!res.ok) throw new Error(data.error || "memory batch failed");
      setBatch(data);
      setBatchLimit(data.totals.candidates);
      setRaw((prev) =>
        JSON.stringify(
          {
            ...(prev ? JSON.parse(prev) : {}),
            batch: {
              request: { ...req, candidates: `${memoryCandidates.length} candidates` },
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
      <h1>Memory curator</h1>
      <p className="subtitle">
        UC#6 live · which requests/answers are worth remembering — reuse
        (Score) + durability &amp; PII (Noul) decide keep / review / forget in
        CODE · batch discipline 5 → 10 → All over the candidate corpus
      </p>

      {error && <div className="error-banner">{error}</div>}

      <div className="grid cols-2" style={{ gap: 16, alignItems: "start" }}>
        <div>
          <div className="card">
            <label className="muted" style={{ fontSize: 12 }}>
              user request (the memory candidate&apos;s question side)
            </label>
            <textarea
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              rows={4}
              style={{ width: "100%", resize: "vertical" }}
            />
            <label className="muted" style={{ fontSize: 12, marginTop: 8, display: "block" }}>
              assistant answer (optional — the reply side of the pair)
            </label>
            <textarea
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              rows={4}
              style={{ width: "100%", resize: "vertical" }}
            />
            <div className="row" style={{ gap: 12, marginTop: 10, alignItems: "center" }}>
              <button onClick={runCurate} disabled={loading} className="primary">
                {loading ? "Curating…" : "Curate exchange"}
              </button>
              <span className="muted" style={{ fontSize: 12 }}>
                the classifier answers typed questions; keep / review / forget is picked in code
              </span>
            </div>

            <div className="grid cols-2" style={{ marginTop: 14, gap: 10 }}>
              {(
                [
                  ["keepAt", `keep at (reuse ≥)`, 0, 4, 0.5],
                  ["forgetAt", `forget at (reuse ≤)`, 0, 4, 0.5],
                  ["piiBlockAt", "PII floor", 0, 1, 0.05],
                  ["durableFloor", "durability floor", 0, 1, 0.05],
                  ["lowConfBump", "confidence demotion", 0, 1, 0.05],
                ] as [keyof MemoryGates, string, number, number, number][]
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
                <strong>Memory verdict</strong>
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
                <MembershipBadge membership={result.decision.membership} />
                {s && (
                  <>
                    <span className="badge neutral">
                      reuse: {s.reuse.toFixed(1)} (
                      {REUSE_LEVELS[Math.min(Math.floor(s.reuse), REUSE_LEVELS.length - 1)]})
                    </span>
                    <span className="badge neutral">durable: {s.durable.toFixed(2)}</span>
                    <span className="badge neutral">pii: {s.pii.toFixed(2)}</span>
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
              <strong>Batch discipline · candidate ladder</strong>
              <span className="muted" style={{ fontSize: 12 }}>
                {memoryCandidates.length} memory candidates · 5 → 10 → All
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
                  {MEMBERSHIP.map((m) => (
                    <div key={m} className="stat-tile">
                      <div className="label">membership: {m}</div>
                      <div className="value">
                        <span className={`badge ${membershipBadgeClass(m)}`}>
                          {batch.totals.verdicts[m]}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="row between" style={{ margin: "12px 0", fontSize: 13 }}>
                  <span>
                    <span className="badge good">{batch.totals.candidates} candidates</span>{" "}
                    <span className="muted mono" style={{ fontSize: 12 }}>
                      {batch.totals.usage.input_tokens}↑ {batch.totals.usage.output_tokens}↓ tok
                    </span>{" "}
                    {batch.totals.errors > 0 && (
                      <span className="badge bad">{batch.totals.errors} errors</span>
                    )}
                  </span>
                  <span className="muted mono" style={{ fontSize: 12 }}>
                    gates keep≥{batch.gates.keepAt} forget≤{batch.gates.forgetAt} · pii{" "}
                    {batch.gates.piiBlockAt.toFixed(2)}
                  </span>
                </div>
                {batch.items.map((it) => (
                  <CandidateRow key={it.id} item={it} />
                ))}
              </>
            )}
          </div>
        </div>

        <div className="card">
          <strong>Raw JSON</strong>
          <pre className="mono" style={{ marginTop: 10, maxHeight: 480, overflow: "auto" }}>
            {raw || "curate an exchange to see the wire"}
          </pre>
        </div>
      </div>
    </div>
  );
}
