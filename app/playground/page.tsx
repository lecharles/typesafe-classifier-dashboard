"use client";

import { useState } from "react";
import { PLAYGROUND_QUESTIONS } from "@/data/questions";
import { AnswerView } from "@/components/AnswerView";
import { RawIO } from "@/components/RawIO";
import type { ClassifyResult, Provider } from "@/lib/schema";
import {
  PROVIDER_CHOICES,
  compareResults,
  latencyLabel,
  type Agreement,
  type ProviderChoice,
} from "@/lib/compare";

const SAMPLES = [
  "Hi, my payment failed three times and I have a launch tomorrow. Can someone please help me right now??",
  "Just wanted to say your product is genuinely delightful to use. Made my week.",
  "The new update completely changed the layout and I can't find anything anymore. Not happy.",
];

type SideState = { result: ClassifyResult | null; error: string | null; ms: number | null };

const AGREEMENT_BADGE: Record<Agreement, string> = { match: "good", diff: "bad", "n/a": "neutral" };
const AGREEMENT_LABEL: Record<Agreement, string> = { match: "agree", diff: "differ", "n/a": "n/a" };

async function attempt(
  text: string,
  provider: ProviderChoice,
): Promise<SideState> {
  const body: Record<string, unknown> = { state: text, questions: PLAYGROUND_QUESTIONS };
  if (provider !== "auto") body.provider = provider;
  const t0 = performance.now();
  try {
    const res = await fetch("/api/classify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "request failed");
    return { result: data as ClassifyResult, error: null, ms: performance.now() - t0 };
  } catch (e) {
    return { result: null, error: e instanceof Error ? e.message : "failed", ms: performance.now() - t0 };
  }
}

export default function PlaygroundPage() {
  const [text, setText] = useState(SAMPLES[0]);
  const [providerSel, setProviderSel] = useState<ProviderChoice>("auto");
  const [loading, setLoading] = useState<"single" | "both" | null>(null);
  const [single, setSingle] = useState<SideState | null>(null);
  const [both, setBoth] = useState<{ jev: SideState; gateway: SideState } | null>(null);

  const busy = loading !== null;

  async function run() {
    setLoading("single");
    setBoth(null);
    setSingle(await attempt(text, providerSel));
    setLoading(null);
  }

  async function askBoth() {
    setLoading("both");
    setSingle(null);
    const [jev, gateway] = await Promise.all([attempt(text, "jev"), attempt(text, "gateway")]);
    setBoth({ jev, gateway });
    setLoading(null);
  }

  const request = { state: text, questions: PLAYGROUND_QUESTIONS };
  const agreement = both ? compareResults(both.jev.result, both.gateway.result) : {};
  const agreementCount = (want: Agreement) =>
    Object.values(agreement).filter((a) => a === want).length;

  return (
    <div>
      <h1>Playground</h1>
      <p className="subtitle">Run Choice / Score / Noul classification on any text, live through the gateway.</p>

      {single?.error && <div className="error-banner">{single.error}</div>}

      <div className="card">
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste text to classify…" />
        <div className="row between" style={{ marginTop: 12, flexWrap: "wrap", gap: 10 }}>
          <div className="row" style={{ gap: 8 }}>
            {SAMPLES.map((s, i) => (
              <button key={i} className="ghost" onClick={() => setText(s)}>
                Sample {i + 1}
              </button>
            ))}
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button onClick={run} disabled={busy || !text.trim()}>
              {loading === "single" ? "Classifying…" : "Classify"}
            </button>
            <button className="ghost" onClick={askBoth} disabled={busy || !text.trim()}>
              {loading === "both" ? "Asking both…" : "Ask both — side by side"}
            </button>
          </div>
        </div>
        <div className="row" style={{ gap: 8, marginTop: 12, alignItems: "center" }}>
          <span className="muted" style={{ fontSize: 13 }}>Provider:</span>
          {PROVIDER_CHOICES.map((p) => (
            <button key={p.id} className={providerSel === p.id ? "" : "ghost"} title={p.hint}
              disabled={busy} onClick={() => setProviderSel(p.id)}>
              {p.label}
            </button>
          ))}
          <span className="muted" style={{ fontSize: 12 }}>
            {PROVIDER_CHOICES.find((p) => p.id === providerSel)?.hint}
          </span>
        </div>
      </div>

      {/* D5: single run with latency pill — model/provider reported by the API. */}
      {single?.result && !both && (
        <>
          <div className="row" style={{ gap: 12, margin: "16px 0", flexWrap: "wrap" }}>
            <span className="pill">backend: {single.result.provider}</span>
            <span className="pill">model: {single.result.model}</span>
            <span className="pill">
              tokens: {single.result.usage.input_tokens} in / {single.result.usage.output_tokens} out
            </span>
            <span className="pill">latency: {latencyLabel(single.ms)}</span>
          </div>
          <div className="grid cols-3">
            {Object.entries(single.result.answers).map(([id, answer]) => (
              <AnswerView key={id} id={id} question={PLAYGROUND_QUESTIONS[id]} answer={answer} />
            ))}
          </div>
        </>
      )}

      {/* D5: ask-both side-by-side with per-column latency pills + agreement strip. */}
      {both && (
        <>
          <div className="row" style={{ gap: 12, margin: "16px 0", flexWrap: "wrap" }}>
            <span className="pill">
              Jev latency: {latencyLabel(both.jev.ms)}
            </span>
            <span className="pill">
              Gateway latency: {latencyLabel(both.gateway.ms)}
            </span>
            <span className="pill">
              agreement: {agreementCount("match")}/{Object.keys(agreement).length} agree
              {agreementCount("diff") > 0 ? ` · ${agreementCount("diff")} differ` : ""}
            </span>
          </div>

          <div className="grid cols-2" style={{ gap: 16 }}>
            {(["jev", "gateway"] as const).map((side) => {
              const s = both[side];
              return (
                <div className="card" key={side}>
                  <div className="row between" style={{ marginBottom: 10 }}>
                    <h2 style={{ margin: 0 }}>{side === "jev" ? "Jev (System One)" : "Gateway (emulated)"}</h2>
                    <span className="pill">{latencyLabel(s.ms)}</span>
                  </div>
                  {s.result ? (
                    <>
                      <div className="row" style={{ gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
                        <span className="pill">{s.result.model}</span>
                        <span className="pill">
                          {s.result.usage.input_tokens}↑ / {s.result.usage.output_tokens}↓
                        </span>
                      </div>
                      <div className="grid" style={{ gap: 12 }}>
                        {Object.entries(PLAYGROUND_QUESTIONS).map(([id, q]) => (
                          <div key={id}>
                            <AnswerView id={id} question={q} answer={s.result!.answers[id]} />
                            {agreement[id] && (
                              <span className={`badge ${AGREEMENT_BADGE[agreement[id]]}`} style={{ marginTop: 6 }}>
                                {AGREEMENT_LABEL[agreement[id]]}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </>
                  ) : (
                    <div className="error-banner" style={{ marginBottom: 0 }}>
                      {s.error || "no result"}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      <h2>Under the hood</h2>
      <RawIO request={request} response={both ? null : single?.result ?? null} />
    </div>
  );
}
