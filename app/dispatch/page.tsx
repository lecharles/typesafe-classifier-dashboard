"use client";

import { useEffect, useState } from "react";
import { REGISTRY, type DispatchCall, type ExecRecord } from "@/lib/dispatch";
import { ConfidenceBadge } from "@/components/charts/ConfidenceBadge";
import { emails } from "@/data/emails";

type PlanResponse = {
  calls: DispatchCall[];
  model: string;
  provider: string;
  usage: { input_tokens: number; output_tokens: number };
  records?: ExecRecord[];
  error?: string;
};

type ItemReport = {
  id: string;
  state: string;
  records: ExecRecord[];
  executed: number;
  held: number;
  error?: string;
};

type BatchResponse = {
  items: ItemReport[];
  totals: {
    items: number;
    planned: number;
    executed: number;
    held: number;
    errors: number;
    usage: { input_tokens: number; output_tokens: number };
  };
  execGate: number;
  model: string;
  provider: string;
  error?: string;
};

const BATCH_ITEMS = emails.map((e) => ({
  id: e.id,
  state: `Subject: ${e.subject}\n\n${e.body}`,
}));

export default function DispatchPage() {
  const [state, setState] = useState(
    "Subject: Checkout keeps failing\n\nThe checkout page errors every time I try to pay. I want a refund today or I escalate.",
  );
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [execGate, setExecGate] = useState(0.85);
  const [raw, setRaw] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dev, setDev] = useState(false);

  const [batch, setBatch] = useState<BatchResponse | null>(null);
  const [batchLimit, setBatchLimit] = useState<number | null>(null);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);

  useEffect(() => {
    setDev(new URLSearchParams(window.location.search).get("dev") === "1");
  }, []);

  async function run(execute: boolean) {
    setLoading(true);
    setError(null);
    const req: Record<string, unknown> = { state, execute, ...(dev ? { dev: true } : {}) };
    if (execute) req.execGate = execGate;
    try {
      const res = await fetch("/api/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      const data: PlanResponse = await res.json();
      if (!res.ok) throw new Error(data.error || "dispatch failed");
      setPlan(data);
      setRaw((prev) =>
        JSON.stringify(prev === "" ? { last: { request: req, response: data } } : { ...JSON.parse(prev), last: { request: req, response: data } }, null, 2),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
      setPlan(null);
    } finally {
      setLoading(false);
    }
  }

  async function runBatch(limit: number | null) {
    setBatchLoading(true);
    setBatchError(null);
    setBatchLimit(limit);
    const req: Record<string, unknown> = { items: BATCH_ITEMS, execGate, ...(limit === null ? { limit: null } : { limit }) };
    try {
      const res = await fetch("/api/dispatch-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      const data: BatchResponse = await res.json();
      if (!res.ok) throw new Error(data.error || "batch dispatch failed");
      setBatch(data);
      setBatchLimit(data.totals.items);
      setRaw((prev) =>
        JSON.stringify(
          {
            ...(prev ? JSON.parse(prev) : {}),
            batch: { request: { ...req, items: `${BATCH_ITEMS.length} emails` }, response: data },
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

  const records = plan?.records ?? [];

  return (
    <div>
      <h1>Tool dispatcher</h1>
      <p className="subtitle">
        UC#1 live · {REGISTRY.length} functions · Choice-per-arg · plan gate 0.5 · execution gated in
        code · batch discipline 5 → 10 → All
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
            <div className="row" style={{ gap: 12, marginTop: 10, alignItems: "center" }}>
              <button onClick={() => run(false)} disabled={loading}>
                {loading ? "Planning…" : "Plan calls"}
              </button>
              <button onClick={() => run(true)} disabled={loading} className="primary">
                Plan + execute in code
              </button>
              <label className="muted" style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
                exec gate
                <input
                  type="range"
                  min={0.5}
                  max={0.99}
                  step={0.01}
                  value={execGate}
                  onChange={(e) => setExecGate(Number(e.target.value))}
                />
                <strong className="mono">{execGate.toFixed(2)}</strong>
              </label>
            </div>
          </div>

          {plan && (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="row between" style={{ marginBottom: 10 }}>
                <strong>
                  {plan.calls.length} call{plan.calls.length === 1 ? "" : "s"} cleared the gate
                  {plan.records ? ` · ${plan.records.filter((r) => r.status === "executed").length} executed in code` : ""}
                </strong>
                <span className="muted" style={{ fontSize: 12 }}>
                  {plan.provider} · {plan.model}
                </span>
              </div>
              {plan.calls.length === 0 && (
                <p className="muted" style={{ fontSize: 14 }}>No function applies to this state.</p>
              )}
              {plan.calls.map((c) => {
                const rec = records.find((r) => r.fn === c.fn);
                return (
                  <div key={c.fn} style={{ marginBottom: 10 }}>
                    <div className="row between">
                      <span className="mono">
                        <strong>{c.fn}</strong>
                      </span>
                      <span className="row" style={{ gap: 6 }}>
                        {rec && (
                          <span className={`badge ${rec.status === "executed" ? "good" : "warn"}`}>
                            {rec.status === "executed" ? "executed" : "held for human"}
                          </span>
                        )}
                        <ConfidenceBadge value={c.confidence} />
                      </span>
                    </div>
                    <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                      {Object.entries(c.args).map(([arg, val]) => (
                        <span key={arg} className="badge neutral">
                          {arg}: {val}
                        </span>
                      ))}
                    </div>
                    {rec && (
                      <div className="muted mono" style={{ fontSize: 12, marginTop: 4 }}>
                        {rec.note}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div className="card" style={{ marginTop: 16 }}>
            <div className="row between" style={{ marginBottom: 8 }}>
              <strong>Batch discipline · email corpus</strong>
              <span className="muted" style={{ fontSize: 12 }}>
                {BATCH_ITEMS.length} emails · 5 → 10 → All
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
                <div className="row between" style={{ margin: "12px 0", fontSize: 13 }}>
                  <span>
                    <span className="badge good">{batch.totals.executed} executed</span>{" "}
                    <span className="badge warn">{batch.totals.held} held for human</span>{" "}
                    {batch.totals.errors > 0 && <span className="badge bad">{batch.totals.errors} errors</span>}
                  </span>
                  <span className="muted mono" style={{ fontSize: 12 }}>
                    exec gate {batch.execGate.toFixed(2)} · {batch.provider} · {batch.model}
                  </span>
                </div>
                {batch.items.map((it) => (
                  <div key={it.id} style={{ marginBottom: 10, paddingBottom: 8, borderBottom: "1px solid rgba(154,164,184,.12)" }}>
                    <div className="row between">
                      <span className="mono" style={{ fontSize: 12 }}>
                        <strong>{it.id}</strong> {it.state.split("\n")[0].replace("Subject: ", "").slice(0, 46)}
                      </span>
                      {it.error ? (
                        <span className="badge bad">error</span>
                      ) : (
                        <span className="muted" style={{ fontSize: 12 }}>
                          {it.executed} exec · {it.held} held
                        </span>
                      )}
                    </div>
                    {it.error && <div className="muted" style={{ fontSize: 12 }}>{it.error}</div>}
                    {it.records.map((r) => (
                      <div key={`${it.id}-${r.fn}`} className="row" style={{ gap: 6, marginTop: 4, alignItems: "center" }}>
                        <span className={`badge ${r.status === "executed" ? "good" : "warn"}`}>
                          {r.status === "executed" ? "executed" : "held"}
                        </span>
                        <span className="mono" style={{ fontSize: 12 }}>
                          {r.fn}({Object.entries(r.args).map(([k, v]) => `${k}=${v}`).join(", ")})
                        </span>
                        <span className="muted" style={{ fontSize: 11 }}>{r.confidence.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </>
            )}
          </div>
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
