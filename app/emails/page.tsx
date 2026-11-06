"use client";

import { useMemo, useState } from "react";
import { emails } from "@/data/emails";
import { EMAIL_QUESTIONS } from "@/data/questions";
import { useBatch } from "@/components/useBatch";
import { Donut } from "@/components/charts/Donut";
import { Histogram } from "@/components/charts/Histogram";
import { StatTile } from "@/components/charts/StatTile";
import { ConfidenceBadge } from "@/components/charts/ConfidenceBadge";
import {
  choiceCounts,
  scoreHistogram,
  noulHistogram,
  noulRate,
  avgConfidence,
  sumUsage,
  successes,
} from "@/lib/aggregate";
import {
  DEFAULT_THRESHOLDS,
  normalizeThresholds,
  routeDecision,
  summarizeRouting,
  type RouteBucket,
} from "@/lib/routing";

const PRIORITY_LEVELS = ["trivial", "low", "medium", "high", "critical"];

type SortKey = "subject" | "category" | "priority" | "urgent" | "confidence";

const ROUTE_BADGE: Record<RouteBucket, string> = { auto: "good", assist: "warn", human: "bad" };
const ROUTE_LABEL: Record<RouteBucket, string> = { auto: "Auto", assist: "Assist", human: "Human" };

export default function EmailsPage() {
  const { results, loading, error, run } = useBatch();
  const [sortKey, setSortKey] = useState<SortKey>("priority");
  const [asc, setAsc] = useState(false);
  const [limit, setLimit] = useState(10);

  const ok = successes(results);
  const usage = sumUsage(results);

  const [high, setHigh] = useState(DEFAULT_THRESHOLDS.high);
  const [low, setLow] = useState(DEFAULT_THRESHOLDS.low);
  const thresholds = normalizeThresholds(high, low);

  const rows = useMemo(() => {
    const map = new Map(emails.map((e) => [e.id, e]));
    const data = results
      .filter((r) => r.result)
      .map((r) => {
        const a = r.result!.answers;
        const cat = a.category?.type === "choice" ? a.category.choice : "—";
        const pri = a.priority?.type === "score" ? a.priority.score : -1;
        const urg = a.is_urgent?.type === "noul" ? a.is_urgent.noul : 0;
        const conf = a.category?.type === "choice" ? a.category.confidence : 0;
        return { email: map.get(r.id)!, cat, pri, urg, conf };
      });
    data.sort((x, y) => {
      let cmp = 0;
      if (sortKey === "subject") cmp = x.email.subject.localeCompare(y.email.subject);
      else if (sortKey === "category") cmp = x.cat.localeCompare(y.cat);
      else if (sortKey === "priority") cmp = x.pri - y.pri;
      else if (sortKey === "urgent") cmp = x.urg - y.urg;
      else cmp = x.conf - y.conf;
      return asc ? cmp : -cmp;
    });
    return data;
  }, [results, sortKey, asc]);

  function sortBy(k: SortKey) {
    if (k === sortKey) setAsc(!asc);
    else {
      setSortKey(k);
      setAsc(false);
    }
  }

  const routing = summarizeRouting(rows.map((r) => r.conf), thresholds);

  function classifyAll() {
    const subset = emails.slice(0, limit);
    run(subset.map((e) => ({ id: e.id, state: `Subject: ${e.subject}\n\n${e.body}` })), EMAIL_QUESTIONS);
  }

  return (
    <div>
      <h1>Email triage</h1>
      <p className="subtitle">Batch-classify {emails.length} support emails into category, urgency, and priority.</p>

      {error && <div className="error-banner">{error}</div>}

      <div className="row between" style={{ marginBottom: 16 }}>
        <span className="muted">{ok.length ? `${ok.length} classified` : "Not classified yet"}</span>
        <div className="row" style={{ gap: 10 }}>
          <label className="row" style={{ gap: 6 }}>
            <span className="muted" style={{ fontSize: 13 }}>How many:</span>
            <select
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              disabled={loading}
              style={{ width: "auto" }}
            >
              <option value={5}>5</option>
              <option value={10}>10</option>
              <option value={20}>20</option>
              <option value={emails.length}>All {emails.length}</option>
            </select>
          </label>
          <button onClick={classifyAll} disabled={loading}>
            {loading ? "Classifying…" : `Classify ${limit}`}
          </button>
        </div>
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: -8, marginBottom: 16 }}>
        Free-tier gateway allows ~5 requests/minute, so larger runs take a few minutes.
      </p>

      {loading && (
        <div className="progress" style={{ marginBottom: 16 }}>
          <div style={{ width: "100%", animation: "none" }} />
        </div>
      )}

      {ok.length > 0 && (
        <>
          <div className="grid cols-4">
            <StatTile label="Emails classified" value={ok.length} />
            <StatTile label="Urgent" value={`${Math.round(noulRate(results, "is_urgent") * 100)}%`} />
            <StatTile label="Avg confidence" value={`${Math.round(avgConfidence(results) * 100)}%`} />
            <StatTile label="Tokens used" value={usage.input_tokens + usage.output_tokens} />
          </div>

          <div className="grid cols-2" style={{ marginTop: 16 }}>
            <div className="card">
              <h2 style={{ marginTop: 0 }}>Category mix</h2>
              <Donut data={choiceCounts(results, "category")} />
            </div>
            <div className="card">
              <h2 style={{ marginTop: 0 }}>Priority distribution</h2>
              <Histogram data={scoreHistogram(results, "priority", PRIORITY_LEVELS)} colorByIndex />
            </div>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <h2 style={{ marginTop: 0 }}>Urgency probability</h2>
            <Histogram data={noulHistogram(results, "is_urgent")} color="#ffb454" />
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <h2 style={{ marginTop: 0 }}>Confidence-gated routing</h2>
            <p className="muted" style={{ fontSize: 13 }}>
              Slide the thresholds: items at or above the auto threshold ship without a human,
              items below the review threshold go to a person, and the band between is
              assist-mode (Jev drafts, human confirms).
            </p>
            <div className="grid cols-2" style={{ gap: 16 }}>
              <label className="row" style={{ gap: 10 }}>
                <span className="muted" style={{ fontSize: 13, whiteSpace: "nowrap" }}>
                  Auto ≥ {Math.round(thresholds.high * 100)}%
                </span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={Math.round(high * 100)}
                  onChange={(e) => setHigh(Number(e.target.value) / 100)}
                  style={{ flex: 1 }}
                />
              </label>
              <label className="row" style={{ gap: 10 }}>
                <span className="muted" style={{ fontSize: 13, whiteSpace: "nowrap" }}>
                  Human {"<"} {Math.round(thresholds.low * 100)}%
                </span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={Math.round(low * 100)}
                  onChange={(e) => setLow(Number(e.target.value) / 100)}
                  style={{ flex: 1 }}
                />
              </label>
            </div>
            <div className="grid cols-4" style={{ marginTop: 12 }}>
              <StatTile label="Auto" value={routing.auto} />
              <StatTile label="Assist" value={routing.assist} />
              <StatTile label="Human review" value={routing.human} />
              <StatTile label="Auto rate" value={`${Math.round(routing.autoRate * 100)}%`} />
            </div>
          </div>

          <h2>Every email</h2>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th onClick={() => sortBy("subject")}>Subject</th>
                  <th onClick={() => sortBy("category")}>Category</th>
                  <th onClick={() => sortBy("priority")}>Priority</th>
                  <th onClick={() => sortBy("urgent")}>Urgent</th>
                  <th onClick={() => sortBy("confidence")}>Conf.</th>
                  <th>Routing</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ email, cat, pri, urg, conf }) => {
                  const bucket = routeDecision(conf, thresholds);
                  return (
                  <tr key={email.id}>
                    <td>{email.subject}</td>
                    <td><span className="badge neutral">{cat}</span></td>
                    <td>{PRIORITY_LEVELS[pri] ?? "—"}</td>
                    <td>
                      <span className={`badge ${urg >= 0.66 ? "bad" : urg >= 0.33 ? "warn" : "good"}`}>
                        {Math.round(urg * 100)}%
                      </span>
                    </td>
                    <td><ConfidenceBadge value={conf} /></td>
                    <td><span className={`badge ${ROUTE_BADGE[bucket]}`}>{ROUTE_LABEL[bucket]}</span></td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
