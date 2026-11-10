"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_GATES,
  DIFFICULTY_LEVELS,
  TIERS,
  type RouteDecision,
  type RouteGates,
  type TierId,
} from "@/lib/router";
import { ConfidenceBadge } from "@/components/charts/ConfidenceBadge";
import { emails } from "@/data/emails";

type RouteResponse = {
  prompt: string;
  decision?: RouteDecision;
  model?: string;
  provider?: string;
  usage?: { input_tokens: number; output_tokens: number };
  error?: string;
};

type ItemReport = {
  id: string;
  prompt: string;
  decision?: RouteDecision;
  costRoutedUsd?: number;
  costAllFrontierUsd?: number;
  error?: string;
};

type BatchResponse = {
  items: ItemReport[];
  totals: {
    items: number;
    errors: number;
    routed: Record<TierId, number>;
    usage: { input_tokens: number; output_tokens: number };
    costRoutedUsd: number;
    costAllFrontierUsd: number;
    savingsUsd: number;
    savingsPct: number;
  };
  gates: RouteGates;
  model: string;
  provider: string;
  error?: string;
};

const TIER_BADGE: Record<TierId, string> = {
  cheap: "good",
  mid: "neutral",
  frontier: "warn",
};

const ROUTER_ITEMS = emails.map((e) => ({
  id: e.id,
  prompt: `Subject: ${e.subject}\n\n${e.body}`,
}));

function tierBadge(tier: TierId) {
  const t = TIERS.find((x) => x.id === tier)!;
  return (
    <span className={`badge ${TIER_BADGE[tier]}`}>
      {t.label} · {t.model}
    </span>
  );
}

function DecisionBlock({ decision }: { decision: RouteDecision }) {
  const s = decision.signals;
  return (
    <>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {tierBadge(decision.tier)}
        <span className="badge neutral">intent: {s.intent}</span>
        <span className="badge neutral">
          difficulty: {s.difficulty.toFixed(1)} ({DIFFICULTY_LEVELS[Math.min(Math.floor(s.difficulty), DIFFICULTY_LEVELS.length - 1)]})
        </span>
        <span className="badge neutral">risk: {s.risk.toFixed(2)}</span>
        <ConfidenceBadge value={s.confidence} />
      </div>
      <ul className="muted" style={{ fontSize: 12.5, margin: "8px 0 0", paddingLeft: 18 }}>
        {decision.reasons.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>
    </>
  );
}

export default function RouterPage() {
  const [prompt, setPrompt] = useState(
    "Explain what a pull request is, in two sentences, for a brand-new intern.",
  );
  const [result, setResult] = useState<RouteResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dev, setDev] = useState(false);

  const [gates, setGates] = useState<RouteGates>(DEFAULT_GATES);
  const [batch, setBatch] = useState<BatchResponse | null>(null);
  const [batchLimit, setBatchLimit] = useState<number | null>(null);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [raw, setRaw] = useState("");

  useEffect(() => {
    setDev(new URLSearchParams(window.location.search).get("dev") === "1");
  }, []);

  async function runRoute() {
    setLoading(true);
    setError(null);
    const req: Record<string, unknown> = { prompt, gates, ...(dev ? { dev: true } : {}) };
    try {
      const res = await fetch("/api/router", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      const data: RouteResponse = await res.json();
      if (!res.ok) throw new Error(data.error || "router failed");
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
      items: ROUTER_ITEMS,
      gates,
      ...(limit === null ? { limit: null } : { limit }),
    };
    try {
      const res = await fetch("/api/router-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      const data: BatchResponse = await res.json();
      if (!res.ok) throw new Error(data.error || "router batch failed");
      setBatch(data);
      setBatchLimit(data.totals.items);
      setRaw((prev) =>
        JSON.stringify(
          {
            ...(prev ? JSON.parse(prev) : {}),
            batch: { request: { ...req, items: `${ROUTER_ITEMS.length} emails` }, response: data },
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

  function setGate(key: keyof RouteGates, v: number) {
    setGates((g) => ({ ...g, [key]: v }));
  }

  return (
    <div>
      <h1>Model router</h1>
      <p className="subtitle">
        UC#2 · intent (Choice) + difficulty (Score) + risk (Noul) → cheap / mid /
        frontier, decided in code · batch discipline 5 → 10 → All
      </p>

      {error && <div className="error-banner">{error}</div>}

      <div className="grid cols-2" style={{ gap: 16, alignItems: "start" }}>
        <div>
          <div className="card">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={5}
              style={{ width: "100%", resize: "vertical" }}
            />
            <div className="row" style={{ gap: 12, marginTop: 10, alignItems: "center" }}>
              <button onClick={runRoute} disabled={loading} className="primary">
                {loading ? "Routing…" : "Route request"}
              </button>
              <span className="muted" style={{ fontSize: 12 }}>
                the classifier answers three typed questions; the tier is picked in code
              </span>
            </div>

            <div className="grid cols-2" style={{ marginTop: 14, gap: 10 }}>
              {(
                [
                  ["riskFloor", "risk floor", 0, 1, 0.05],
                  ["lowConfBump", "confidence bump", 0, 1, 0.05],
                  ["midAt", "mid gate (difficulty ≥)", 0, 4, 0.5],
                  ["frontierAt", "frontier gate (difficulty ≥)", 0, 4, 0.5],
                ] as [keyof RouteGates, string, number, number, number][]
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
                <strong>Route decision</strong>
                <span className="muted" style={{ fontSize: 12 }}>
                  classifier: {result.provider} · {result.model}
                </span>
              </div>
              <DecisionBlock decision={result.decision} />
            </div>
          )}

          <div className="card" style={{ marginTop: 16 }}>
            <div className="row between" style={{ marginBottom: 8 }}>
              <strong>Batch discipline · email corpus</strong>
              <span className="muted" style={{ fontSize: 12 }}>
                {ROUTER_ITEMS.length} emails · 5 → 10 → All
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
                <div className="grid cols-4" style={{ marginTop: 12, gap: 10 }}>
                  {TIERS.map((t) => (
                    <div key={t.id} className="stat-tile">
                      <div className="label">{t.label}</div>
                      <div className="value">{batch.totals.routed[t.id]}</div>
                    </div>
                  ))}
                  <div className="stat-tile">
                    <div className="label">Est. saved vs all-frontier</div>
                    <div className="value">${batch.totals.savingsUsd.toFixed(4)}</div>
                    <div className="muted" style={{ fontSize: 11 }}>
                      {(batch.totals.savingsPct * 100).toFixed(1)}% ·{" "}
                      ${batch.totals.costAllFrontierUsd.toFixed(4)} → ${batch.totals.costRoutedUsd.toFixed(4)}
                    </div>
                  </div>
                </div>
                <div className="row between" style={{ margin: "12px 0", fontSize: 13 }}>
                  <span>
                    <span className="badge good">{batch.totals.items} routed</span>{" "}
                    {batch.totals.errors > 0 && (
                      <span className="badge bad">{batch.totals.errors} errors</span>
                    )}
                  </span>
                  <span className="muted mono" style={{ fontSize: 12 }}>
                    gates r{batch.gates.riskFloor.toFixed(2)} · d{batch.gates.midAt}/{batch.gates.frontierAt} · c
                    {batch.gates.lowConfBump.toFixed(2)}
                  </span>
                </div>
                {batch.items.map((it) => (
                  <div key={it.id} style={{ marginBottom: 10, paddingBottom: 8, borderBottom: "1px solid rgba(154,164,184,.12)" }}>
                    <div className="row between">
                      <span className="mono" style={{ fontSize: 12 }}>
                        <strong>{it.id}</strong> {it.prompt.split("\n")[0].replace("Subject: ", "").slice(0, 44)}
                      </span>
                      {it.error ? (
                        <span className="badge bad">error</span>
                      ) : it.decision ? (
                        <span className="row" style={{ gap: 6 }}>
                          {tierBadge(it.decision.tier)}
                          <span className="muted mono" style={{ fontSize: 11 }}>
                            ${it.costRoutedUsd?.toFixed(5)} vs ${it.costAllFrontierUsd?.toFixed(5)}
                          </span>
                        </span>
                      ) : null}
                    </div>
                    {it.error && <div className="muted" style={{ fontSize: 12 }}>{it.error}</div>}
                    {it.decision && (
                      <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>
                        {it.decision.reasons.slice(0, -1).join(" · ")}
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
            {raw || "route a request to see the wire"}
          </pre>
        </div>
      </div>
    </div>
  );
}
