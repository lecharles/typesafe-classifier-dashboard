"use client";

import { useEffect, useState } from "react";
import { REGISTRY, type DispatchCall } from "@/lib/dispatch";
import { ConfidenceBadge } from "@/components/charts/ConfidenceBadge";

type PlanResponse = {
  calls: DispatchCall[];
  model: string;
  provider: string;
  usage: { input_tokens: number; output_tokens: number };
  error?: string;
};

export default function DispatchPage() {
  const [state, setState] = useState(
    "Subject: Checkout keeps failing\n\nThe checkout page errors every time I try to pay. I want a refund today or I escalate.",
  );
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [raw, setRaw] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dev, setDev] = useState(false);

  useEffect(() => {
    setDev(new URLSearchParams(window.location.search).get("dev") === "1");
  }, []);

  async function run() {
    setLoading(true);
    setError(null);
    const req = { state, ...(dev ? { dev: true } : {}) };
    try {
      const res = await fetch("/api/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      const data: PlanResponse = await res.json();
      if (!res.ok) throw new Error(data.error || "dispatch failed");
      setPlan(data);
      setRaw(JSON.stringify({ request: req, response: data }, null, 2));
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
      setPlan(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <h1>Tool dispatcher</h1>
      <p className="subtitle">
        UC#1 scaffold · {REGISTRY.length} functions · Choice-per-arg · gate 0.5 (live execution
        ships 11-10)
      </p>

      {error && <div className="error-banner">{error}</div>}

      <div className="grid cols-2" style={{ gap: 16, alignItems: "start" }}>
        <div>
          <div className="card">
            <textarea
              value={state}
              onChange={(e) => setState(e.target.value)}
              rows={7}
              style={{ width: "100%", resize: "vertical" }}
            />
            <button onClick={run} disabled={loading} style={{ marginTop: 10 }}>
              {loading ? "Planning…" : "Plan calls"}
            </button>
          </div>

          {plan && (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="row between" style={{ marginBottom: 10 }}>
                <strong>{plan.calls.length} call{plan.calls.length === 1 ? "" : "s"} cleared the gate</strong>
                <span className="muted" style={{ fontSize: 12 }}>
                  {plan.provider} · {plan.model}
                </span>
              </div>
              {plan.calls.length === 0 && (
                <p className="muted" style={{ fontSize: 14 }}>No function applies to this state.</p>
              )}
              {plan.calls.map((c) => (
                <div key={c.fn} style={{ marginBottom: 10 }}>
                  <div className="row between">
                    <span className="mono"><strong>{c.fn}</strong></span>
                    <ConfidenceBadge value={c.confidence} />
                  </div>
                  <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                    {Object.entries(c.args).map(([arg, val]) => (
                      <span key={arg} className="badge neutral">
                        {arg}: {val}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <strong>Raw JSON</strong>
          <pre className="mono" style={{ marginTop: 10, maxHeight: 480, overflow: "auto" }}>
            {raw || "run a dispatch to see the wire"}
          </pre>
        </div>
      </div>
    </div>
  );
}
