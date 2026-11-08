"use client";

import { useEffect, useMemo, useState } from "react";
import type { Video } from "@/data/youtube";
import { YOUTUBE_QUESTIONS } from "@/data/questions";
import { useBatch } from "@/components/useBatch";
import { DevPanel } from "@/components/DevPanel";
import { ExportButtons } from "@/components/ExportButtons";
import { Donut } from "@/components/charts/Donut";
import { Histogram } from "@/components/charts/Histogram";
import { Gauge } from "@/components/charts/Gauge";
import { StatTile } from "@/components/charts/StatTile";
import {
  choiceCounts,
  scoreHistogram,
  noulRate,
  avgConfidence,
  sumUsage,
  successes,
  countByMonth,
  bucketLevel,
} from "@/lib/aggregate";

const SENTIMENT_LEVELS = ["very neg", "neg", "neutral", "pos", "very pos"];
const CLICKBAIT_LEVELS = ["none", "slight", "moderate", "very", "extreme"];

type FilterKind = "category" | "clickbait" | "sentiment" | "clickbaity_plus";
type Filter = { kind: FilterKind; value?: string } | null;
type SortKey = "title" | "channel" | "topic" | "clickbait" | "sentiment";

/** Jev returns fractional scores (e.g. 2.99); always bucket via round. */
const levelIndex = (score: number, levels: string[]) => bucketLevel(score, levels.length);

type Row = {
  id: string;
  title: string;
  channel: string;
  topic: string;
  cbIndex: number;
  cbLabel: string;
  sentIndex: number;
  sentLabel: string;
};

export default function YouTubePage() {
  const { results, loading, error, run, savedAt, clearRun } = useBatch("youtube");
  const [videos, setVideos] = useState<Video[]>([]);
  const [source, setSource] = useState<string>("");
  const [liveEnabled, setLiveEnabled] = useState(false);
  const [limit, setLimit] = useState(10);
  const [filter, setFilter] = useState<Filter>(null);
  const [sortKey, setSortKey] = useState<SortKey>("clickbait");
  const [asc, setAsc] = useState(false);
  // D7 shared dev view: ?dev=1 reveals per-item raw Jev payloads.
  const [dev, setDev] = useState(false);
  useEffect(() => {
    setDev(new URLSearchParams(window.location.search).get("dev") === "1");
  }, []);

  useEffect(() => {
    fetch("/api/youtube")
      .then((r) => r.json())
      .then((d) => {
        setVideos(d.videos);
        setSource(d.source);
        setLiveEnabled(d.liveEnabled);
      })
      .catch(() => {});
  }, []);

  const ok = successes(results);
  const usage = sumUsage(results);
  const byId = useMemo(() => new Map(videos.map((v) => [v.id, v])), [videos]);
  const backend = ok[0]?.result ? `${ok[0].result.provider} · ${ok[0].result.model}` : "";

  function analyze() {
    const subset = videos.slice(0, limit);
    setFilter(null);
    run(
      subset.map((v) => ({ id: v.id, state: `Title: ${v.title}\nChannel: ${v.channel}\nDescription: ${v.description}` })),
      YOUTUBE_QUESTIONS,
    );
  }

  // Build rows once; filters and sorts derive from them.
  const allRows: Row[] = useMemo(() => {
    return ok
      .map((r) => {
        const a = r.result!.answers;
        const v = byId.get(r.id);
        if (!v) return null;
        const cbScore = a.clickbait?.type === "score" ? a.clickbait.score : null;
        const sentScore = a.title_sentiment?.type === "score" ? a.title_sentiment.score : null;
        const cbIndex = cbScore === null ? -1 : levelIndex(cbScore, CLICKBAIT_LEVELS);
        const sentIndex = sentScore === null ? -1 : levelIndex(sentScore, SENTIMENT_LEVELS);
        return {
          id: r.id,
          title: v.title,
          channel: v.channel,
          topic: a.category?.type === "choice" ? a.category.choice : "—",
          cbIndex,
          cbLabel: cbIndex >= 0 ? CLICKBAIT_LEVELS[cbIndex] : "—",
          sentIndex,
          sentLabel: sentIndex >= 0 ? SENTIMENT_LEVELS[sentIndex] : "—",
        };
      })
      .filter((r): r is Row => r !== null);
  }, [results, byId]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => {
    let out = allRows;
    if (filter) {
      out = out.filter((r) => {
        if (filter.kind === "category") return r.topic === filter.value;
        if (filter.kind === "clickbait") return r.cbLabel === filter.value;
        if (filter.kind === "sentiment") return r.sentLabel === filter.value;
        if (filter.kind === "clickbaity_plus") return r.cbIndex >= 3;
        return true;
      });
    }
    const dir = asc ? 1 : -1;
    return [...out].sort((x, y) => {
      if (sortKey === "title") return x.title.localeCompare(y.title) * dir;
      if (sortKey === "channel") return x.channel.localeCompare(y.channel) * dir;
      if (sortKey === "topic") return x.topic.localeCompare(y.topic) * dir;
      if (sortKey === "clickbait") return (x.cbIndex - y.cbIndex) * dir;
      return (x.sentIndex - y.sentIndex) * dir;
    });
  }, [allRows, filter, sortKey, asc]);

  function toggle(f: Filter) {
    setFilter((cur) => (cur && cur.kind === f?.kind && cur.value === f?.value ? null : f));
  }

  const clickbaitCount = allRows.filter((r) => r.cbIndex >= 3).length;
  const FILTER_LABEL: Record<FilterKind, string> = {
    category: "Topic",
    clickbait: "Clickbait",
    sentiment: "Sentiment",
    clickbaity_plus: "Clickbait very+ (≥3)",
  };

  return (
    <div>
      <h1>YouTube analyzer</h1>
      <p className="subtitle">Classify {videos.length} videos by topic, clickbait, sentiment, and more.</p>

      {error && <div className="error-banner">{error}</div>}

      <div className="row between" style={{ marginBottom: 16 }}>
        <div className="row" style={{ gap: 10 }}>
          <span className="pill">
            source: {source || "…"}{liveEnabled ? " (live API available)" : " (set YOUTUBE_API_KEY for live)"}
          </span>
          {backend && <span className="pill">backend: {backend}</span>}
        </div>
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
              <option value={25}>25</option>
              <option value={videos.length || 50}>All {videos.length || 50}</option>
            </select>
          </label>
          <button onClick={analyze} disabled={loading || !videos.length}>
            {loading ? "Analyzing…" : `Analyze ${Math.min(limit, videos.length)}`}
          </button>
        </div>
      </div>

      {ok.length > 0 && (
        <>
          <div className="grid cols-4">
            <StatTile label="Videos analyzed" value={ok.length} onClick={() => setFilter(null)}
              active={filter === null} hint="Show all (clear filter)" />
            <StatTile label="Avg confidence" value={`${Math.round(avgConfidence(results) * 100)}%`} />
            <StatTile label="Tokens used" value={usage.input_tokens + usage.output_tokens} />
            <StatTile label="Clickbait (very+)" value={clickbaitCount}
              onClick={() => toggle({ kind: "clickbaity_plus" })}
              active={filter?.kind === "clickbaity_plus"}
              hint="Click to list the very/extreme clickbait videos" />
          </div>

          {filter && (
            <div style={{ margin: "12px 0" }}>
              <span className="filter-chip">
                filter: {FILTER_LABEL[filter.kind]}{filter.value ? ` = ${filter.value}` : ""}
                <button onClick={() => setFilter(null)} aria-label="Clear filter">×</button>
              </span>
              <span className="muted" style={{ fontSize: 12, marginLeft: 10 }}>
                {rows.length} of {allRows.length} videos shown — click any chart element or stat to filter
              </span>
            </div>
          )}

          <div className="grid cols-3" style={{ marginTop: 16 }}>
            <Gauge label="Promotional" value={noulRate(results, "is_promotional")} />
            <Gauge label="News" value={noulRate(results, "is_news")} />
            <Gauge label="Clickbaity (very+)" value={clickbaitCount / (allRows.length || 1)} />
          </div>

          <div className="grid cols-2" style={{ marginTop: 16 }}>
            <div className="card">
              <h2 style={{ marginTop: 0 }}>Topic mix</h2>
              <Donut data={choiceCounts(results, "category")}
                onSelect={(name) => toggle({ kind: "category", value: name })} />
            </div>
            <div className="card">
              <h2 style={{ marginTop: 0 }}>Title sentiment</h2>
              <Histogram data={scoreHistogram(results, "title_sentiment", SENTIMENT_LEVELS)} colorByIndex
                onSelect={(bin) => toggle({ kind: "sentiment", value: bin })} />
            </div>
          </div>

          <div className="grid cols-2" style={{ marginTop: 16 }}>
            <div className="card">
              <h2 style={{ marginTop: 0 }}>Clickbait levels</h2>
              <Histogram data={scoreHistogram(results, "clickbait", CLICKBAIT_LEVELS)} color="#ff6b6b"
                onSelect={(bin) => toggle({ kind: "clickbait", value: bin })} />
            </div>
            <div className="card">
              <h2 style={{ marginTop: 0 }}>Videos by month</h2>
              <Histogram data={countByMonth(videos)} color="#4dd0e1" />
            </div>
          </div>

          <div className="row between" style={{ marginTop: 24, marginBottom: 8 }}>
            <h2 style={{ margin: 0 }}>
              {filter ? `Matching videos (${rows.length})` : "Every video"}
              {savedAt && results.length > 0 ? (
                <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>
                  {" "}· restored {new Date(savedAt).toLocaleTimeString()}
                </span>
              ) : null}
            </h2>
            <div className="row" style={{ gap: 8 }}>
              {savedAt && results.length > 0 && (
                <button className="ghost" onClick={clearRun} disabled={loading}>
                  Clear run
                </button>
              )}
              <ExportButtons
                filename="youtube-classified"
                rows={rows.map(({ title, channel, topic, cbLabel, sentLabel }) => ({
                  title,
                  channel,
                  topic,
                  clickbait: cbLabel,
                  sentiment: sentLabel,
                }))}
              />
            </div>
          </div>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th onClick={() => { if (sortKey === "title") setAsc(!asc); else { setSortKey("title"); setAsc(true); } }}>
                    Title{sortKey === "title" ? (asc ? " ▲" : " ▼") : ""}
                  </th>
                  <th onClick={() => { if (sortKey === "channel") setAsc(!asc); else { setSortKey("channel"); setAsc(true); } }}>
                    Channel{sortKey === "channel" ? (asc ? " ▲" : " ▼") : ""}
                  </th>
                  <th onClick={() => { if (sortKey === "topic") setAsc(!asc); else { setSortKey("topic"); setAsc(true); } }}>
                    Topic{sortKey === "topic" ? (asc ? " ▲" : " ▼") : ""}
                  </th>
                  <th onClick={() => { if (sortKey === "clickbait") setAsc(!asc); else { setSortKey("clickbait"); setAsc(false); } }}>
                    Clickbait{sortKey === "clickbait" ? (asc ? " ▲" : " ▼") : ""}
                  </th>
                  <th onClick={() => { if (sortKey === "sentiment") setAsc(!asc); else { setSortKey("sentiment"); setAsc(false); } }}>
                    Sentiment{sortKey === "sentiment" ? (asc ? " ▲" : " ▼") : ""}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.title}</td>
                    <td className="muted">{r.channel}</td>
                    <td><span className="badge neutral">{r.topic}</span></td>
                    <td style={r.cbIndex >= 3 ? { color: "#ff6b6b", fontWeight: 700 } : undefined}>{r.cbLabel}</td>
                    <td>{r.sentLabel}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan={5} className="muted">No videos match this filter.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {dev && <DevPanel results={results} />}
        </>
      )}
    </div>
  );
}
