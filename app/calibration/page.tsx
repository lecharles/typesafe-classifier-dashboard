"use client";

import { useEffect, useState } from "react";
import {
  CAL_GAP_WARN,
  calibrationExportRows,
  type CalBin,
  type CalibrationTable,
} from "@/lib/calibration";
import { ExportButtons } from "@/components/ExportButtons";
import { ConfidenceBadge } from "@/components/charts/ConfidenceBadge";

type CalPoint = { id: string; confidence: number; correct: boolean };

type Snapshot = {
  source: "harness" | "manual";
  table: CalibrationTable;
  points: CalPoint[];
  receipt: Record<string, number>;
  generatedAt: string;
};

type WireResponse = Snapshot & {
  excludedNote?: string | null;
  rejected?: { row: number; reason: string; preview: string }[];
  persisted?: { runId: string; savedAt: string; limit: number | null } | null;
  persistError?: string | null;
  error?: string;
};

type StoredRunWire = {
  runId: string;
  lane: string;
  savedAt: string;
  limit: number | null;
  summary: { compared: number; errors: number };
  payload: Snapshot;
};

const RUNGS = [5, 10, null] as const; // null = All

const binBadge = (b: CalBin) =>
  b.label === "honest" ? "good" : b.label === "no sample" ? "neutral" : "warn";

const barPct = (x: number | null) => (x === null ? 0 : Math.max(0, Math.min(100, x * 100)));

function BinRow({ b }: { b: CalBin }) {
  return (
    <tr>
      <td className="mono">{b.range}</td>
      <td className="mono">{b.n}</td>
      <td style={{ minWidth: 180 }}>
        {b.n === 0 ? (
          <span className="muted" style={{ fontSize: 12 }}>
            —
          </span>
        ) : (
          <div style={{ position: "relative", height: 16, background: "rgba(255,255,255,.05)", borderRadius: 4 }}>
            {/* stated confidence: the claim */}
            <div
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                height: 16,
                width: `${barPct(b.meanConf)}%`,
                background: "rgba(148,163,184,.35)",
                borderRadius: 4,
              }}
              title={`mean confidence ${b.meanConf}`}
            />
            {/* accuracy: the receipt — drawn on top, its own tick */}
            <div
              style={{
                position: "absolute",
                left: `${barPct(b.accuracy)}%`,
                top: -2,
                width: 2,
                height: 20,
                background: b.gap !== null && Math.abs(b.gap) > CAL_GAP_WARN ? "#f87171" : "#5eead4",
              }}
              title={`accuracy ${b.accuracy}`}
            />
          </div>
        )}
      </td>
      <td className="mono">{b.meanConf ?? "n/a"}</td>
      <td className="mono">{b.accuracy ?? "n/a"}</td>
      <td className="mono">{b.gap ?? "n/a"}</td>
      <td>
        <span className={`badge ${binBadge(b)}`}>{b.label}</span>
      </td>
    </tr>
  );
}

export default function CalibrationPage() {
  const [snap, setSnap] = useState<WireResponse | null>(null);
  const [restored, setRestored] = useState<StoredRunWire | null>(null);
  const [storeCounts, setStoreCounts] = useState<{ total: number; readable: number } | null>(null);
  const [history, setHistory] = useState<{ runId: string; savedAt: string; summary: { compared: number; errors: number } }[]>([]);
  const [running, setRunning] = useState<number | "manual" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [manualJson, setManualJson] = useState("");

  useEffect(() => {
    fetch("/api/calibration")
      .then((r) => r.json())
      .then((d) => {
        if (d?.run) {
          setRestored(d.run);
          setSnap(d.run.payload as WireResponse);
        }
        if (d?.recent) setHistory(d.recent);
        if (d?.counts) setStoreCounts(d.counts);
      })
      .catch(() => {});
  }, []);

  async function calibrateFromHarness(limit: number | null) {
    setRunning(limit);
    setErr(null);
    setRestored(null);
    try {
      const hr = await fetch("/api/harness", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ datasets: ["emails", "youtube"], limit }),
      });
      const report = await hr.json();
      if (!hr.ok) {
        setErr(report?.error ?? `harness failed with HTTP ${hr.status}`);
        return;
      }
      const cr = await fetch("/api/calibration", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "harness", report }),
      });
      const d: WireResponse = await cr.json();
      if (!cr.ok) {
        setErr(d?.error ?? `calibration failed with HTTP ${cr.status}`);
        return;
      }
      setSnap(d);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "calibration run failed");
    } finally {
      setRunning(null);
    }
  }

  async function calibrateManual() {
    setRunning("manual");
    setErr(null);
    setRestored(null);
    try {
      let points: unknown;
      try {
        points = JSON.parse(manualJson);
      } catch {
        setErr("manual lane wants a JSON array of {id, confidence, correct}");
        return;
      }
      const cr = await fetch("/api/calibration", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "manual", points }),
      });
      const d: WireResponse = await cr.json();
      if (!cr.ok) {
        setErr(d?.error ?? `calibration failed with HTTP ${cr.status}`);
        return;
      }
      setSnap(d);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "manual calibration failed");
    } finally {
      setRunning(null);
    }
  }

  const t = snap?.table ?? null;
  const receipt = snap?.receipt as Record<string, number> | undefined;

  return (
    <div>
      <h1>Calibration — confidence vs correctness</h1>
      <p className="subtitle">
        11-26 · the only question a confidence number is allowed to answer is{" "}
        <strong>how often is it right</strong>. Ten fixed 0.1-wide bins, accuracy vs stated
        confidence decided <strong>IN CODE</strong>; the D14 harness is the reference (
        <strong>agreement-as-correctness</strong>, labeled as such — a dead side is{" "}
        <strong>excluded and counted</strong>, never guessed at). Empty bins stay visible: you said
        that number zero times. ECE is <strong>weighted</strong> — one loud bin cannot drown forty
        quiet ones. Snapshots persist in SQLite and survive the restart.
      </p>

      {restored && (
        <div className="card" style={{ marginBottom: 16, borderLeft: "3px solid rgba(94,234,212,.45)" }}>
          <span style={{ fontSize: 13 }}>
            <strong>Restored from SQLite</strong> — calibration snapshot <span className="mono">{restored.runId}</span>{" "}
            ({restored.summary.compared} rows walked · {restored.summary.errors} excluded/refused)
            persisted at <span className="mono">{restored.savedAt}</span> and{" "}
            <strong>survived the restart</strong>
            {storeCounts && storeCounts.total > 0 && (
              <>
                {" "}· store: {storeCounts.readable}/{storeCounts.total} readable
              </>
            )}
            .
          </span>
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}>
          <strong>Run the ladder over the live hub</strong>
          <span className="row" style={{ gap: 8 }}>
            {RUNGS.map((r) => (
              <button key={String(r)} onClick={() => calibrateFromHarness(r)} disabled={running !== null}>
                {running === r ? "Running…" : r === null ? "Calibrate All" : `Calibrate ${r}`}
              </button>
            ))}
          </span>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          each run sends the bundled 90-item corpus through BOTH backends (the D14 harness), then
          grades Jev&apos;s stated confidence against the agreement column — no new model calls are
          invented here, the harness is the reference.
        </div>
        {err && <div className="error-banner" style={{ marginTop: 10 }}>{err}</div>}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <strong>Manual lane</strong>
        <div className="muted" style={{ fontSize: 12, margin: "4px 0 8px" }}>
          bring your own labeled pairs — <span className="mono">[{`{"id":"m1","confidence":0.9,"correct":false}`}]</span>{" "}
          — refused rows ride the receipt with row numbers.
        </div>
        <textarea
          value={manualJson}
          onChange={(e) => setManualJson(e.target.value)}
          placeholder='[{"id":"m1","confidence":0.92,"correct":true}, {"id":"m2","confidence":0.95,"correct":false}]'
          style={{ width: "100%", minHeight: 90, fontFamily: "monospace", fontSize: 12 }}
        />
        <div className="row" style={{ gap: 12, marginTop: 8, alignItems: "center" }}>
          <button onClick={calibrateManual} disabled={running !== null || !manualJson.trim()} className="primary">
            {running === "manual" ? "Guarding…" : "Calibrate manual pairs"}
          </button>
          <span className="muted" style={{ fontSize: 12 }}>THE TABLE NEVER TRUSTS A PAYLOAD</span>
        </div>
      </div>

      {snap && t && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="row between" style={{ flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
              <strong>Calibration table · {snap.source}</strong>
              <span className="row" style={{ gap: 8, alignItems: "center" }}>
                <span title="calibration quality (1 − ECE)">
                  <ConfidenceBadge value={t.ece === null ? 0 : Math.max(0, 1 - t.ece)} />
                </span>
                {snap.persisted ? (
                  <span className="badge good">persisted · SQLite {snap.persisted.runId}</span>
                ) : snap.persistError ? (
                  <span className="badge bad">persist failed: {snap.persistError}</span>
                ) : null}
                <ExportButtons filename={`calibration-${t.points}`} rows={calibrationExportRows(t)} />
              </span>
            </div>
            <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
              <span className="badge neutral">{t.points} graded points</span>
              <span className="badge neutral">ECE {t.ece ?? "n/a"}</span>
              <span className="badge neutral">accuracy {t.overallAccuracy ?? "n/a"}</span>
              {receipt && snap.source === "harness" && (
                <>
                  <span className="badge neutral">{receipt.answersSeen} answers seen</span>
                  {receipt.naExcluded > 0 && <span className="badge warn">{receipt.naExcluded} n/a excluded</span>}
                  {receipt.noConfidenceExcluded > 0 && (
                    <span className="badge neutral">{receipt.noConfidenceExcluded} confidence-less excluded</span>
                  )}
                  {receipt.erroredItems > 0 && <span className="badge bad">{receipt.erroredItems} errored items</span>}
                </>
              )}
              {receipt && snap.source === "manual" && (
                <>
                  <span className="badge neutral">{receipt.seen} rows seen</span>
                  {receipt.rejected > 0 && <span className="badge bad">{receipt.rejected} refused</span>}
                </>
              )}
            </div>
            {snap.excludedNote && (
              <div className="error-banner" style={{ marginBottom: 10 }}>{snap.excludedNote}</div>
            )}
            <table>
              <thead>
                <tr>
                  <th>bin</th>
                  <th>n</th>
                  <th>claim ▏receipt ▏</th>
                  <th>mean conf</th>
                  <th>accuracy</th>
                  <th>gap</th>
                  <th>label</th>
                </tr>
              </thead>
              <tbody>
                {t.bins.map((b) => (
                  <BinRow key={b.bin} b={b} />
                ))}
              </tbody>
            </table>
            <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              grey bar = mean stated confidence (the claim); tick = observed accuracy (the receipt).
              A tick LEFT of the bar edge is overconfidence — certainty you did not earn. Gap beyond ±
              {CAL_GAP_WARN} earns a loud label.
            </div>
            <div style={{ marginTop: 10, fontSize: 13 }}>
              <strong>Verdict:</strong> {t.verdict}
            </div>
          </div>

          {history.length > 0 && (
            <div className="card">
              <strong>Store history · lane &quot;calibration&quot;</strong>
              <table style={{ marginTop: 8 }}>
                <thead>
                  <tr>
                    <th>run</th>
                    <th>saved</th>
                    <th>rows</th>
                    <th>excluded</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.runId}>
                      <td className="mono">{h.runId}</td>
                      <td className="mono">{h.savedAt}</td>
                      <td className="mono">{h.summary.compared}</td>
                      <td className="mono">{h.summary.errors}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
