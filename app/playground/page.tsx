"use client";

import { useState } from "react";
import { PLAYGROUND_QUESTIONS } from "@/data/questions";
import { AnswerView } from "@/components/AnswerView";
import { RawIO } from "@/components/RawIO";
import type { ClassifyResult } from "@/lib/schema";

const SAMPLES = [
  "Hi, my payment failed three times and I have a launch tomorrow. Can someone please help me right now??",
  "Just wanted to say your product is genuinely delightful to use. Made my week.",
  "The new update completely changed the layout and I can't find anything anymore. Not happy.",
];

export default function PlaygroundPage() {
  const [text, setText] = useState(SAMPLES[0]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ClassifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const request = { state: text, questions: PLAYGROUND_QUESTIONS };

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/classify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "request failed");
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <h1>Playground</h1>
      <p className="subtitle">Run Choice / Score / Noul classification on any text, live through the gateway.</p>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste text to classify…" />
        <div className="row between" style={{ marginTop: 12 }}>
          <div className="row" style={{ gap: 8 }}>
            {SAMPLES.map((s, i) => (
              <button key={i} className="ghost" onClick={() => setText(s)}>
                Sample {i + 1}
              </button>
            ))}
          </div>
          <button onClick={run} disabled={loading || !text.trim()}>
            {loading ? "Classifying…" : "Classify"}
          </button>
        </div>
      </div>

      {result && (
        <>
          <div className="row" style={{ gap: 12, margin: "16px 0" }}>
            <span className="pill">model: {result.model}</span>
            <span className="pill">
              tokens: {result.usage.input_tokens} in / {result.usage.output_tokens} out
            </span>
          </div>
          <div className="grid cols-3">
            {Object.entries(result.answers).map(([id, answer]) => (
              <AnswerView key={id} id={id} question={PLAYGROUND_QUESTIONS[id]} answer={answer} />
            ))}
          </div>
        </>
      )}

      <h2>Under the hood</h2>
      <RawIO request={request} response={result} />
    </div>
  );
}
