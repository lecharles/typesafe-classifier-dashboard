"use client";

import { useEffect, useMemo, useState } from "react";
import { emails, type Email } from "@/data/emails";
import { EMAIL_QUESTIONS } from "@/data/questions";
import { useBatch } from "@/components/useBatch";
import { DevPanel } from "@/components/DevPanel";
import { ExportButtons } from "@/components/ExportButtons";
import { SlideOver } from "@/components/SlideOver";
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
import {
  applyEmailFilter,
  urgencyBin,
  toggleEmailFilter,
  FILTER_LABELS,
  type EmailFilter,
} from "@/lib/tablefilter";

const PRIORITY_LEVELS = ["trivial", "low", "medium", "high", "critical"];

type SortKey = "subject" | "category" | "priority" | "urgent" | "confidence";

const ROUTE_BADGE: Record<RouteBucket, string> = { auto: "good", assist: "warn", human: "bad" };
const ROUTE_LABEL: Record<RouteBucket, string> = { auto: "Auto", assist: "Assist", human: "Human" };

type Row = {
  email: Email;
  cat: string;
  pri: number;
  urg: number;
  conf: number;
  priLabel: string;
  urgBin: string;
  routing: RouteBucket;
};

export default function EmailsPage() {
  const { results, loading, error, run, savedAt, clearRun } = useBatch("emails");
  const [sortKey, setSortKey] = useState<SortKey>("priority");
  const [asc, setAsc] = useState(false);
  const [limit, setLimit] = useState(10);
  // D4: click-to-filter (one active filter, toggled by charts/tiles) + row drill-over.
  const [filter, setFilter] = useState<EmailFilter | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  // D7 shared dev view: ?dev=1 reveals per-item raw Jev payloads.
  const [dev, setDev] = useState(false);
  useEffect(() => {
    setDev(new URLSearchParams(window.location.search).get("dev") === "1");
  }, []);

  const ok = successes(results);
  const usage = sumUsage(results);

  const [high, setHigh] = useState(DEFAULT_THRESHOLDS.high);
  const [low, setLow] = useState(DEFAULT_THRESHOLDS.low);
  const thresholds = normalizeThresholds(high, low);

  const rows: Row[] = useMemo(() => {
    const map = new Map(emails.map((e) => [e.id, e]));
    const data = results
      .filter((r) => r.result)
      .map((r) => {
        const a = r.result!.answers;
        const cat = a.category?.type === "choice" ? a.category.choice : "—";
        const pri = a.priority?.type === "score" ? a.priority.score : -1;
        const urg = a.is_urgent?.type === "noul" ? a.is_urgent.noul : 0;
        const conf = a.category?.type === "choice" ? a.category.confidence : 0;
        return {
          email: map.get(r.id)!,
          cat,
          pri,
          urg,
          conf,
          priLabel: PRIORITY_LEVELS[pri] ?? "—",
          urgBin: urgencyBin(urg),
          routing: routeDecision(conf, thresholds) as RouteBucket,
        };
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
  }, [results, sortKey, asc, thresholds]);

  const visible = useMemo(() => applyEmailFilter(rows, filter), [rows, filter]);

  function sortBy(k: SortKey) {
    if (k === sortKey) setAsc(!asc);
    else {
      setSortKey(k);
      setAsc(false);
    }
  }

  function toggle(f: EmailFilter) {
    setFilter((cur) => toggleEmailFilter(cur, f));
  }

  // D8: the table as data — CSV/JSON export of the current filter/sort view.
  const exportRows = useMemo(
    () =>
      visible.map(({ email, cat, pri, urg, conf, routing }) => ({
        subject: email.subject,
        category: cat,
        priority: PRIORITY_LEVELS[pri] ?? "—",
        urgent_pct: Math.round(urg * 100),
        confidence_pct: Math.round(conf * 100),
        routing: ROUTE_LABEL[routing],
      })),
    [visible],
  );

  const routing = summarizeRouting(rows.map((r) => r.conf), thresholds);
  const detail = detailId ? rows.find((r) => r.email.id === detailId) ?? null : null;
  const detailResult = detail ? results.find((r) => r.id === detail.email.id)?.result : undefined;

  return (
    <div>
      <h1>Email triage</h1>
      <p className="subtitle">Batch-classify {emails.length} support emails into category, urgency, and priority.</p>

      {error && <div className="error-banner">{error}</div>}

      <div className="row between" style={{ marginBottom: 16 }}>
        <span className="muted">
          {ok.length ? `${ok.length} classified` : "Not classified yet"}
          {savedAt && ok.length ? ` · restored ${new Date(savedAt).toLocaleTimeString()}` : ""}
        </span>
        <div className="row" style={{ gap: 10 }}>
          {savedAt && results.length > 0 && (
            <button className="ghost" onClick={clearRun} disabled={loading}>
              Clear run
            </button>
          )}
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
            <StatTile label="Emails classified" value={ok.length} onClick={() => setFilter(null)}
              active={filter === null} hint="Show all (clear filter)" />
            <StatTile label="Urgent" value={`${Math.round(noulRate(results, "is_urgent") * 100)}%`} />
            <StatTile label="Avg confidence" value={`${Math.round(avgConfidence(results) * 100)}%`} />
            <StatTile label="Tokens used" value={usage.input_tokens + usage.output_tokens} />
          </div>

          <div className="grid cols-2" style={{ marginTop: 16 }}>
            <div className="card">
              <h2 style={{ marginTop: 0 }}>Category mix</h2>
              <Donut data={choiceCounts(results, "category")}
                onSelect={(name) => toggle({ kind: "category", value: name })} />
            </div>
            <div className="card">
              <h2 style={{ marginTop: 0 }}>Priority distribution</h2>
              <Histogram data={scoreHistogram(results, "priority", PRIORITY_LEVELS)} colorByIndex
                onSelect={(bin) => toggle({ kind: "priority", value: bin })} />
            </div>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <h2 style={{ marginTop: 0 }}>Urgency probability</h2>
            <Histogram data={noulHistogram(results, "is_urgent")} color="#ffb454"
              onSelect={(bin) => toggle({ kind: "urgency", value: bin })} />
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <h2 style={{ marginTop: 0 }}>Confidence-gated routing</h2>
            <p className="muted" style={{ fontSize: 13 }}>
              Slide the thresholds: items at or above the auto threshold ship without a human,
              items below the review threshold go to a person, and the band between is
              assist-mode (Jev drafts, human confirms). Click a tile to filter the table.
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
              <StatTile label="Auto" value={routing.auto}
                onClick={() => toggle({ kind: "routing", value: "auto" })}
                active={filter?.kind === "routing" && filter.value === "auto"}
                hint="Click to list auto-handled emails" />
              <StatTile label="Assist" value={routing.assist}
                onClick={() => toggle({ kind: "routing", value: "assist" })}
                active={filter?.kind === "routing" && filter.value === "assist"}
                hint="Click to list assist-mode emails" />
              <StatTile label="Human review" value={routing.human}
                onClick={() => toggle({ kind: "routing", value: "human" })}
                active={filter?.kind === "routing" && filter.value === "human"}
                hint="Click to list emails needing a human" />
              <StatTile label="Auto rate" value={`${Math.round(routing.autoRate * 100)}%`} />
            </div>
          </div>

          {filter && (
            <div style={{ margin: "12px 0" }}>
              <span className="filter-chip">
                filter: {FILTER_LABELS[filter.kind]} = {filter.value}
                <button onClick={() => setFilter(null)} aria-label="Clear filter">×</button>
              </span>
              <span className="muted" style={{ fontSize: 12, marginLeft: 10 }}>
                {visible.length} of {rows.length} emails shown — click any chart element or routing tile to filter
              </span>
            </div>
          )}

          <div className="row between" style={{ marginTop: 24, marginBottom: 8 }}>
            <h2 style={{ margin: 0 }}>
              {filter ? `Matching emails (${visible.length})` : "Every email"}
              <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
                {" "}· click a row for the raw payload
              </span>
            </h2>
            <ExportButtons filename="email-triage" rows={exportRows} />
          </div>
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
                {visible.map(({ email, cat, pri, urg, conf, routing: bucket }) => (
                  <tr key={email.id} className="row-clickable" onClick={() => setDetailId(email.id)}
                    title="Open raw payload">
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
                ))}
                {visible.length === 0 && (
                  <tr><td colSpan={6} className="muted">No emails match this filter.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {dev && <DevPanel results={results} />}
        </>
      )}

      {/* D4: per-row drill-over with the raw classification payload. */}
      <SlideOver open={detail !== null} title={detail?.email.subject ?? ""} onClose={() => setDetailId(null)}>
        {detail && (
          <div>
            <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
              <span className="badge neutral">{detail.cat}</span>
              <span className="badge neutral">{`P: ${detail.priLabel}`}</span>
              <span className={`badge ${detail.urg >= 0.66 ? "bad" : detail.urg >= 0.33 ? "warn" : "good"}`}>
                {Math.round(detail.urg * 100)}% urgent
              </span>
              <span className={`badge ${ROUTE_BADGE[detail.routing]}`}>{ROUTE_LABEL[detail.routing]}</span>
            </div>
            <div className="card" style={{ marginBottom: 12 }}>
              <p className="muted" style={{ fontSize: 12, margin: 0 }}>Email body (classification state)</p>
              <p style={{ margin: "8px 0 0", whiteSpace: "pre-wrap" }}>{detail.email.body}</p>
            </div>
            {detailResult ? (
              <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
                <span className="pill">{detailResult.provider} · {detailResult.model}</span>
                <span className="pill">
                  tokens: {detailResult.usage.input_tokens} in / {detailResult.usage.output_tokens} out
                </span>
                <span className="pill">conf: {Math.round(detail.conf * 100)}%</span>
              </div>
            ) : (
              <p className="muted" style={{ fontSize: 13 }}>This row has no result.</p>
            )}
            <p className="muted" style={{ fontSize: 12 }}>Raw answers payload</p>
            <pre className="mono">{JSON.stringify(detailResult?.answers ?? {}, null, 2)}</pre>
            {detailResult?.trace ? (
              <>
                <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
                  Wire payload ({detailResult.trace.provider_used} → {detailResult.trace.endpoint})
                </p>
                <pre className="mono">
                  {typeof detailResult.trace.response === "string"
                    ? detailResult.trace.response
                    : JSON.stringify(detailResult.trace.response ?? {}, null, 2)}
                </pre>
                {detailResult.trace.retries > 0 && (
                  <pre className="mono">{JSON.stringify(detailResult.trace.attempts, null, 2)}</pre>
                )}
              </>
            ) : (
              <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
                Tip: run the batch with <span className="mono">?dev=1</span> to capture raw wire payloads here.
              </p>
            )}
          </div>
        )}
      </SlideOver>
    </div>
  );

  function classifyAll() {
    const subset = emails.slice(0, limit);
    setFilter(null);
    setDetailId(null);
    run(subset.map((e) => ({ id: e.id, state: `Subject: ${e.subject}\n\n${e.body}` })), EMAIL_QUESTIONS);
  }
}
