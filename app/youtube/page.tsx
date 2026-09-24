"use client";

import { useEffect, useMemo, useState } from "react";
import type { Video } from "@/data/youtube";
import { YOUTUBE_QUESTIONS } from "@/data/questions";
import { useBatch } from "@/components/useBatch";
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
} from "@/lib/aggregate";

const SENTIMENT_LEVELS = ["very neg", "neg", "neutral", "pos", "very pos"];
const CLICKBAIT_LEVELS = ["none", "slight", "moderate", "very", "extreme"];

export default function YouTubePage() {
  const { results, loading, error, run } = useBatch();
  const [videos, setVideos] = useState<Video[]>([]);
  const [source, setSource] = useState<string>("");
  const [liveEnabled, setLiveEnabled] = useState(false);

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

  function analyze() {
    run(
      videos.map((v) => ({ id: v.id, state: `Title: ${v.title}\nChannel: ${v.channel}\nDescription: ${v.description}` })),
      YOUTUBE_QUESTIONS,
    );
  }

  return (
    <div>
      <h1>YouTube analyzer</h1>
      <p className="subtitle">Classify {videos.length} videos by topic, clickbait, sentiment, and more.</p>

      {error && <div className="error-banner">{error}</div>}

      <div className="row between" style={{ marginBottom: 16 }}>
        <span className="pill">
          source: {source || "…"}{liveEnabled ? " (live API available)" : " (set YOUTUBE_API_KEY for live)"}
        </span>
        <button onClick={analyze} disabled={loading || !videos.length}>
          {loading ? "Analyzing…" : `Analyze ${videos.length} videos`}
        </button>
      </div>

      {ok.length > 0 && (
        <>
          <div className="grid cols-4">
            <StatTile label="Videos analyzed" value={ok.length} />
            <StatTile label="Avg confidence" value={`${Math.round(avgConfidence(results) * 100)}%`} />
            <StatTile label="Tokens used" value={usage.input_tokens + usage.output_tokens} />
            <StatTile label="Categories" value={choiceCounts(results, "category").length} />
          </div>

          <div className="grid cols-3" style={{ marginTop: 16 }}>
            <Gauge label="Promotional" value={noulRate(results, "is_promotional")} />
            <Gauge label="News" value={noulRate(results, "is_news")} />
            <Gauge label="Clickbaity (very+)" value={ok.filter((r) => {
              const a = r.result!.answers.clickbait;
              return a?.type === "score" && a.score >= 3;
            }).length / ok.length} />
          </div>

          <div className="grid cols-2" style={{ marginTop: 16 }}>
            <div className="card">
              <h2 style={{ marginTop: 0 }}>Topic mix</h2>
              <Donut data={choiceCounts(results, "category")} />
            </div>
            <div className="card">
              <h2 style={{ marginTop: 0 }}>Title sentiment</h2>
              <Histogram data={scoreHistogram(results, "title_sentiment", SENTIMENT_LEVELS)} colorByIndex />
            </div>
          </div>

          <div className="grid cols-2" style={{ marginTop: 16 }}>
            <div className="card">
              <h2 style={{ marginTop: 0 }}>Clickbait levels</h2>
              <Histogram data={scoreHistogram(results, "clickbait", CLICKBAIT_LEVELS)} color="#ff6b6b" />
            </div>
            <div className="card">
              <h2 style={{ marginTop: 0 }}>Videos by month</h2>
              <Histogram data={countByMonth(videos)} color="#4dd0e1" />
            </div>
          </div>

          <h2>Every video</h2>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Channel</th>
                  <th>Topic</th>
                  <th>Clickbait</th>
                  <th>Sentiment</th>
                </tr>
              </thead>
              <tbody>
                {results.filter((r) => r.result).map((r) => {
                  const a = r.result!.answers;
                  const v = byId.get(r.id);
                  const cat = a.category?.type === "choice" ? a.category.choice : "—";
                  const cb = a.clickbait?.type === "score" ? CLICKBAIT_LEVELS[a.clickbait.score] : "—";
                  const sent = a.title_sentiment?.type === "score" ? SENTIMENT_LEVELS[a.title_sentiment.score] : "—";
                  return (
                    <tr key={r.id}>
                      <td>{v?.title}</td>
                      <td className="muted">{v?.channel}</td>
                      <td><span className="badge neutral">{cat}</span></td>
                      <td>{cb}</td>
                      <td>{sent}</td>
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
