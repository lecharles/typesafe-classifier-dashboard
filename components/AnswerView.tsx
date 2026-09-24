"use client";

import type { Answer, Question } from "@/lib/schema";
import { Gauge } from "@/components/charts/Gauge";
import { ConfidenceBadge } from "@/components/charts/ConfidenceBadge";
import { colorAt } from "@/components/charts/palette";

function ProbBars({ probs }: { probs: Record<string, number> }) {
  const entries = Object.entries(probs).sort((a, b) => b[1] - a[1]);
  return (
    <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
      {entries.map(([k, v], i) => (
        <div key={k} className="row" style={{ gap: 10 }}>
          <span className="mono" style={{ width: 130, color: "var(--muted)" }}>{k}</span>
          <div className="progress" style={{ flex: 1 }}>
            <div style={{ width: `${Math.round(v * 100)}%`, background: colorAt(i) }} />
          </div>
          <span className="mono" style={{ width: 44, textAlign: "right" }}>{Math.round(v * 100)}%</span>
        </div>
      ))}
    </div>
  );
}

export function AnswerView({ id, question, answer }: { id: string; question: Question; answer: Answer }) {
  return (
    <div className="card">
      <div className="row between">
        <div>
          <strong style={{ textTransform: "capitalize" }}>{id.replace(/_/g, " ")}</strong>
          <span className="pill" style={{ marginLeft: 8 }}>{answer.type}</span>
        </div>
        {answer.type !== "noul" && <ConfidenceBadge value={answer.confidence} />}
      </div>

      {answer.type === "choice" && (
        <>
          <div style={{ fontSize: 22, fontWeight: 700, marginTop: 8 }}>{answer.choice}</div>
          <ProbBars probs={answer.probabilities} />
        </>
      )}

      {answer.type === "score" && question.type === "score" && (
        <>
          <div style={{ fontSize: 22, fontWeight: 700, marginTop: 8 }}>
            {question.criteria[Math.round(answer.score)] ?? answer.score}
            <span className="muted" style={{ fontSize: 14 }}> ({answer.score}/{question.criteria.length - 1})</span>
          </div>
          <ProbBars probs={answer.probabilities} />
        </>
      )}

      {answer.type === "noul" && (
        <div style={{ marginTop: 10 }}>
          <Gauge label="probability of yes" value={answer.noul} />
        </div>
      )}
    </div>
  );
}
