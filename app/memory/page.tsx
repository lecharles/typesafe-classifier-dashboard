"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_GATES,
  MEMBERSHIP,
  REUSE_LEVELS,
  type MemoryGates,
  type MemorySignals,
  type Membership,
  type MembershipDecision,
  membershipBadgeClass,
} from "@/lib/memory";
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

function MembershipBadge({ membership }: { membership: Membership }) {
  return (
    <span className={`badge ${membershipBadgeClass(membership)}`}>
      {membership.toUpperCase()}
    </span>
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

  const s = result?.signals;

  return (
    <div>
      <h1>Memory curator</h1>
      <p className="subtitle">
        UC#6 scaffold · which requests/answers are worth remembering — reuse
        (Score) + durability &amp; PII (Noul) decide keep / review / forget in
        CODE · batch discipline 5 → 10 → All lands with the live row
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
              <strong>Scaffold note</strong>
              <span className="muted" style={{ fontSize: 12 }}>UC#6 live · 11-16 row</span>
            </div>
            <p className="muted" style={{ fontSize: 13, margin: 0 }}>
              The ladder is shipped and live on a single exchange. The 11-16 row adds
              the lane&apos;s batch discipline — 5 → 10 → All over a memory-candidate
              corpus with verdict tallies ({MEMBERSHIP.join(" / ")}) and the dev view
              wired in, same as router / guardrails / citations / re-ranker.
            </p>
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
