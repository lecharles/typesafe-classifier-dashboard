"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_GATES,
  BS_VERDICTS,
  bsBadgeClass,
  type BsGates,
  type BsVerdict,
} from "@/lib/bs";
import {
  UPLOAD_FORMATS,
  uploadExportRows,
  type CorpusIntake,
  type UploadFormat,
  type UploadItem,
  type UploadOrigin,
} from "@/lib/upload";
import { ExportButtons } from "@/components/ExportButtons";
import { ConfidenceBadge } from "@/components/charts/ConfidenceBadge";

type ScreenItem = {
  id: string;
  label: string;
  origin: UploadOrigin;
  verdict?: BsVerdict;
  reasons?: string[];
  signals?: { bs: number; malice: number; payoff: number; confidence: number };
  usage?: { input_tokens: number; output_tokens: number };
  error?: string;
  trace?: unknown;
};

type ScreenResponse = {
  items: ScreenItem[];
  totals: {
    screened: number;
    errors: number;
    verdicts: Record<BsVerdict, number>;
    usage: { input_tokens: number; output_tokens: number };
  };
  gates: BsGates;
  model: string;
  provider: string;
  error?: string;
  persisted?: { runId: string; savedAt: string; limit: number | null } | null;
  persistError?: string | null;
};

type StoredRunWire = {
  runId: string;
  lane: string;
  savedAt: string;
  limit: number | null;
  summary: { compared: number; errors: number };
  payload: ScreenResponse;
};

type RunsResponse = {
  run: StoredRunWire | null;
  recent: { runId: string; savedAt: string; limit: number | null; summary: { compared: number; errors: number } }[];
  counts: { total: number; readable: number };
  error?: string;
};

type IntakeResponse = CorpusIntake & { cap: number; textCap: number; error?: string };
type OfficialResponse = { ok?: boolean; api?: string; items?: UploadItem[]; error?: string };

function VerdictBadge({ verdict }: { verdict: BsVerdict }) {
  return <span className={`badge ${bsBadgeClass(verdict)}`}>{verdict.toUpperCase()}</span>;
}

const GATE_SPECS: [keyof BsGates, string, number, number, number][] = [
  ["bsAt", "BS at (intensity ≥)", 0, 10, 0.5],
  ["cleanAt", "clean at (intensity ≤)", 0, 10, 0.5],
  ["maliceBlockAt", "malice floor", 0, 1, 0.05],
  ["payoffFloor", "payoff floor", 0, 1, 0.05],
  ["lowConfBump", "confidence demotion", 0, 1, 0.05],
];

export default function UploadPage() {
  const [raw, setRaw] = useState("");
  const [format, setFormat] = useState<UploadFormat>("text");
  const [origin, setOrigin] = useState<"paste" | "file">("paste");
  const [intake, setIntake] = useState<IntakeResponse | null>(null);
  const [corpus, setCorpus] = useState<UploadItem[]>([]);
  const [intakeLoading, setIntakeLoading] = useState(false);
  const [intakeError, setIntakeError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [channelId, setChannelId] = useState("");
  const [apiUrl, setApiUrl] = useState("");
  const [officialLoading, setOfficialLoading] = useState(false);
  const [officialNote, setOfficialNote] = useState<string | null>(null);
  const [officialError, setOfficialError] = useState<string | null>(null);

  const [gates, setGates] = useState<BsGates>(DEFAULT_GATES);
  const [batch, setBatch] = useState<ScreenResponse | null>(null);
  const [batchLimit, setBatchLimit] = useState<number | null>(null);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [dev, setDev] = useState(false);
  const [wire, setWire] = useState("");

  // UC#10-persist ride: the last upload screen comes back off disk.
  const [restored, setRestored] = useState<StoredRunWire | null>(null);
  const [storeCounts, setStoreCounts] = useState<{ total: number; readable: number } | null>(null);

  useEffect(() => {
    setDev(new URLSearchParams(window.location.search).get("dev") === "1");
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/upload-batch")
      .then((res) => (res.ok ? (res.json() as Promise<RunsResponse>) : null))
      .then((data) => {
        if (cancelled || !data || data.error) return;
        setStoreCounts(data.counts ?? null);
        const run = data.run;
        if (run && Array.isArray(run.payload?.items) && run.payload.items.length > 0) {
          setBatch(run.payload);
          setBatchLimit(run.limit ?? run.payload.totals.screened);
          setRestored(run);
        }
      })
      .catch(() => {
        // cold/broken store: nothing to restore — the page still boots clean
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function pushWire(key: string, request: unknown, response: unknown) {
    setWire((prev) => {
      let base: Record<string, unknown> = {};
      try {
        base = prev ? JSON.parse(prev) : {};
      } catch {
        base = {};
      }
      return JSON.stringify({ ...base, [key]: { request, response } }, null, 2);
    });
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setRaw(String(reader.result ?? ""));
      setOrigin("file");
      const name = file.name.toLowerCase();
      if (name.endsWith(".json")) setFormat("json");
      else if (name.endsWith(".csv")) setFormat("csv");
      else setFormat("text");
    };
    reader.readAsText(file);
  }

  async function parseIntake() {
    setIntakeLoading(true);
    setIntakeError(null);
    const req = { kind: "intake", format, raw, origin };
    try {
      const res = await fetch("/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      const data: IntakeResponse = await res.json();
      if (!res.ok) throw new Error(data.error || "intake failed");
      setIntake(data);
      setCorpus(data.items);
      setRestored(null);
      setBatch(null);
      pushWire("intake", { ...req, raw: `${raw.length} chars` }, data);
    } catch (e) {
      setIntakeError(e instanceof Error ? e.message : "failed");
      setIntake(null);
      setCorpus([]);
    } finally {
      setIntakeLoading(false);
    }
  }

  async function pullOfficial() {
    setOfficialLoading(true);
    setOfficialError(null);
    setOfficialNote(null);
    const req: Record<string, unknown> = { kind: "official" };
    if (query.trim()) req.query = query.trim();
    if (channelId.trim()) req.channelId = channelId.trim();
    if (apiUrl.trim()) req.apiUrl = apiUrl.trim();
    try {
      const res = await fetch("/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      const data: OfficialResponse = await res.json();
      if (!res.ok) throw new Error(data.error || "official pull refused");
      const items = data.items ?? [];
      const synthetic: IntakeResponse = {
        format: "json",
        origin: "official-api",
        items,
        rejected: [],
        headerError: null,
        counts: {
          rows: items.length,
          kept: items.length,
          rejected: 0,
          duplicates: 0,
          blankSkipped: 0,
          capDropped: 0,
        },
        cap: 200,
        textCap: 20_000,
      };
      setIntake(synthetic);
      setCorpus(items);
      setRestored(null);
      setBatch(null);
      setOfficialNote(
        items.length > 0
          ? `pulled ${items.length} real records through ${data.api} — provenance stamped official-api`
          : "the official API answered with zero videos for that query",
      );
      pushWire("official", req, data);
    } catch (e) {
      setOfficialError(e instanceof Error ? e.message : "official pull failed");
    } finally {
      setOfficialLoading(false);
    }
  }

  function setGate(key: keyof BsGates, v: number) {
    setGates((g) => ({ ...g, [key]: v }));
  }

  async function runBatch(limit: number | null) {
    if (corpus.length === 0) {
      setBatchError("nothing to screen — paste/upload a corpus or pull from the official API first");
      return;
    }
    setBatchLoading(true);
    setBatchError(null);
    setBatchLimit(limit);
    const req: Record<string, unknown> = {
      items: corpus.map((c) => ({ id: c.id, text: c.text, label: c.label, origin: c.origin })),
      gates,
      ...(limit === null ? { limit: null } : { limit }),
      ...(dev ? { dev: true } : {}),
    };
    try {
      const res = await fetch("/api/upload-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      const data: ScreenResponse = await res.json();
      if (!res.ok) throw new Error(data.error || "upload screen failed");
      setBatch(data);
      setBatchLimit(data.totals.screened);
      setRestored(null);
      pushWire("batch", { ...req, items: `${corpus.length} rows` }, data);
    } catch (e) {
      setBatchError(e instanceof Error ? e.message : "failed");
      setBatch(null);
    } finally {
      setBatchLoading(false);
    }
  }

  return (
    <div>
      <h1>Real-corpora upload</h1>
      <p className="subtitle">
        11-25 · bring your OWN data to the hub: paste-in or CSV/JSON files parsed IN CODE —
        refused rows ride the receipt with row numbers, duplicates are dropped{" "}
        <strong>and counted</strong>, caps are visible — then screened through the UC#7 BS ladder,
        batch 5 → 10 → All, verdicts decided in code. Live pulls ride{" "}
        <strong>official APIs only</strong>: https + exact-host allowlist + pinned API path, and
        when the key is missing the lane <strong>refuses</strong> instead of smuggling the bundled
        synthetic sample in — provenance never lies
      </p>

      {restored && (
        <div className="card" style={{ marginBottom: 16, borderLeft: "3px solid rgba(94,234,212,.45)" }}>
          <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}>
            <span style={{ fontSize: 13 }}>
              <strong>Restored from SQLite</strong> — upload screen <span className="mono">{restored.runId}</span>{" "}
              (rung {restored.limit === null ? "All" : restored.limit} · {restored.summary.compared} screened ·{" "}
              {restored.summary.errors} errors) persisted server-side at <span className="mono">{restored.savedAt}</span> and{" "}
              <strong>survived the restart</strong>.
            </span>
            {storeCounts && storeCounts.total > 0 && (
              <span className="muted mono" style={{ fontSize: 12 }}>
                store: {storeCounts.readable}/{storeCounts.total} runs readable
              </span>
            )}
          </div>
        </div>
      )}

      <div className="grid cols-2" style={{ gap: 16, alignItems: "start" }}>
        <div>
          <div className="card">
            <div className="row between" style={{ marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
              <strong>Bring your corpus</strong>
              <span className="row" style={{ gap: 8, alignItems: "center" }}>
                <select value={format} onChange={(e) => setFormat(e.target.value as UploadFormat)}>
                  {UPLOAD_FORMATS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
                <label className="muted" style={{ fontSize: 12 }}>
                  file:
                  <input type="file" accept=".txt,.csv,.json,text/plain,application/json,text/csv" onChange={onFile} style={{ marginLeft: 6, maxWidth: 180 }} />
                </label>
              </span>
            </div>
            <textarea
              value={raw}
              onChange={(e) => {
                setRaw(e.target.value);
                setOrigin("paste");
              }}
              placeholder={
                format === "csv"
                  ? "id,label,text\na1,subject,Body of the email…"
                  : format === "json"
                    ? '[{ "id": "a1", "text": "…" }, "…"]'
                    : "One item per line — emails, titles, chat logs, anything you actually own"
              }
              style={{ width: "100%", minHeight: 140, fontFamily: "monospace", fontSize: 12 }}
            />
            <div className="row" style={{ gap: 12, marginTop: 10, alignItems: "center" }}>
              <button onClick={parseIntake} disabled={intakeLoading || !raw.trim()} className="primary">
                {intakeLoading ? "Parsing…" : "Parse intake"}
              </button>
              <span className="muted" style={{ fontSize: 12 }}>
                the PARSE decides what enters the corpus — nothing is silently dropped
              </span>
            </div>
            {intakeError && <div className="error-banner" style={{ marginTop: 10 }}>{intakeError}</div>}
          </div>

          {intake && (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="row between" style={{ marginBottom: 8 }}>
                <strong>Intake receipt · {intake.origin}</strong>
                <span className="muted mono" style={{ fontSize: 12 }}>
                  format: {intake.format}
                </span>
              </div>
              <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                <span className="badge neutral">{intake.counts.rows} rows</span>
                <span className="badge good">{intake.counts.kept} kept</span>
                {intake.counts.rejected > 0 && <span className="badge bad">{intake.counts.rejected} rejected</span>}
                {intake.counts.duplicates > 0 && <span className="badge warn">{intake.counts.duplicates} dupes dropped</span>}
                {intake.counts.blankSkipped > 0 && <span className="badge neutral">{intake.counts.blankSkipped} blank skipped</span>}
                {intake.counts.capDropped > 0 && (
                  <span className="badge bad">{intake.counts.capDropped} over cap {intake.cap}</span>
                )}
              </div>
              {intake.rejected.length > 0 && (
                <table style={{ marginTop: 10 }}>
                  <thead>
                    <tr>
                      <th>row</th>
                      <th>reason</th>
                      <th>preview</th>
                    </tr>
                  </thead>
                  <tbody>
                    {intake.rejected.map((r, i) => (
                      <tr key={`${r.row}-${i}`}>
                        <td className="mono">{r.row}</td>
                        <td>{r.reason}</td>
                        <td className="mono" style={{ fontSize: 11 }}>{r.preview}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          <div className="card" style={{ marginTop: 16, borderLeft: "3px solid rgba(148,239,158,.35)" }}>
            <strong>Official APIs only</strong>
            <p className="muted" style={{ fontSize: 12, margin: "6px 0 10px" }}>
              live pulls go through the YouTube Data API v3 <em>only</em> — https, exact-host
              allowlist, pinned <span className="mono">/youtube/v3/</span> path. A watch-page or
              scrapish url is REFUSED by the wall, and with no key set this lane errors instead of
              pretending the synthetic sample is real
            </p>
            <div className="grid cols-2" style={{ gap: 8 }}>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="search query" maxLength={400} />
              <input value={channelId} onChange={(e) => setChannelId(e.target.value)} placeholder="channelId (optional)" maxLength={80} />
            </div>
            <input
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
              placeholder="…or paste an official API v3 url"
              maxLength={2000}
              className="mono"
              style={{ width: "100%", marginTop: 8, fontSize: 12 }}
            />
            <div className="row" style={{ gap: 12, marginTop: 10, alignItems: "center" }}>
              <button onClick={pullOfficial} disabled={officialLoading} className="primary">
                {officialLoading ? "Pulling…" : "Pull real corpus"}
              </button>
              <span className="muted" style={{ fontSize: 12 }}>your key stays server-side; a pasted key param is stripped</span>
            </div>
            {officialNote && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>{officialNote}</div>}
            {officialError && <div className="error-banner" style={{ marginTop: 10 }}>{officialError}</div>}
          </div>
        </div>

        <div>
          <div className="card">
            <div className="row between" style={{ marginBottom: 8 }}>
              <strong>Screen the upload · UC#7 ladder</strong>
              <span className="muted" style={{ fontSize: 12 }}>
                {corpus.length} rows in corpus · 5 → 10 → All
              </span>
            </div>
            <div className="grid cols-2" style={{ gap: 10, marginBottom: 10 }}>
              {GATE_SPECS.map(([key, label, min, max, step]) => (
                <label key={key} className="muted" style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 8 }}>
                  {label}
                  <input type="range" min={min} max={max} step={step} value={gates[key]} onChange={(e) => setGate(key, Number(e.target.value))} />
                  <strong className="mono">{gates[key].toFixed(2)}</strong>
                </label>
              ))}
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button onClick={() => runBatch(5)} disabled={batchLoading || corpus.length === 0}>
                {batchLoading && batchLimit === 5 ? "Running 5…" : "Run batch 5"}
              </button>
              <button onClick={() => runBatch(10)} disabled={batchLoading || corpus.length === 0}>
                {batchLoading && batchLimit === 10 ? "Running 10…" : "Expand to 10"}
              </button>
              <button onClick={() => runBatch(null)} disabled={batchLoading || corpus.length === 0}>
                {batchLoading && batchLimit === null ? "Running all…" : "Run All"}
              </button>
            </div>
            {batchError && <div className="error-banner" style={{ marginTop: 10 }}>{batchError}</div>}
            {batch && (
              <>
                <div className="grid cols-3" style={{ marginTop: 12, gap: 10 }}>
                  {BS_VERDICTS.map((v) => (
                    <div key={v} className="stat-tile">
                      <div className="label">verdict: {v}</div>
                      <div className="value">
                        <span className={`badge ${bsBadgeClass(v)}`}>{batch.totals.verdicts[v]}</span>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="row between" style={{ margin: "12px 0", fontSize: 13, flexWrap: "wrap", gap: 6 }}>
                  <span>
                    <span className="badge good">{batch.totals.screened} screened</span>{" "}
                    <span className="muted mono" style={{ fontSize: 12 }}>
                      {batch.totals.usage.input_tokens}↑ {batch.totals.usage.output_tokens}↓ tok
                    </span>{" "}
                    {batch.totals.errors > 0 && <span className="badge bad">{batch.totals.errors} errors</span>}{" "}
                    {batch.persisted ? (
                      <span className="badge good" title={batch.persisted.runId}>persisted · SQLite</span>
                    ) : batch.persistError ? (
                      <span className="badge bad">persist failed: {batch.persistError}</span>
                    ) : null}
                  </span>
                  <span className="muted mono" style={{ fontSize: 12 }}>
                    gates bs≥{batch.gates.bsAt} clean≤{batch.gates.cleanAt} · malice {batch.gates.maliceBlockAt.toFixed(2)}
                  </span>
                </div>
                <div className="row between" style={{ alignItems: "center", marginBottom: 4 }}>
                  <strong style={{ fontSize: 13 }}>Row verdicts</strong>
                  <ExportButtons filename={`upload-screen-${batch.items.length}`} rows={uploadExportRows(batch.items)} />
                </div>
                {batch.items.map((it) => (
                  <div key={it.id} style={{ marginBottom: 10, paddingBottom: 8, borderBottom: "1px solid rgba(154,164,184,.12)" }}>
                    <div className="row between">
                      <span className="mono" style={{ fontSize: 12 }}>
                        <strong>{it.id}</strong>{" "}
                        <span className="muted">·{it.origin}·</span>{" "}
                        {it.label.slice(0, 64)}
                        {it.label.length > 64 ? "…" : ""}
                      </span>
                      {it.error ? <span className="badge bad">error</span> : it.verdict ? <VerdictBadge verdict={it.verdict} /> : null}
                    </div>
                    {it.signals && (
                      <div className="row" style={{ gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                        <span className="badge neutral">intensity: {it.signals.bs.toFixed(2)}</span>
                        <span className="badge neutral">malice: {it.signals.malice.toFixed(2)}</span>
                        <span className="badge neutral">payoff: {it.signals.payoff.toFixed(2)}</span>
                        <ConfidenceBadge value={it.signals.confidence} />
                      </div>
                    )}
                    {it.error && <div className="muted" style={{ fontSize: 12 }}>{it.error}</div>}
                    {it.reasons && it.reasons.length > 0 && (
                      <ul className="muted" style={{ fontSize: 11.5, margin: "6px 0 0", paddingLeft: 16 }}>
                        {it.reasons.map((r, i) => (
                          <li key={i}>{r}</li>
                        ))}
                      </ul>
                    )}
                    {dev && it.trace !== undefined && (
                      <pre className="mono" style={{ fontSize: 10.5, marginTop: 6, maxHeight: 160, overflow: "auto" }}>
                        {JSON.stringify(it.trace, null, 1)}
                      </pre>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <strong>Raw JSON</strong>
            <pre className="mono" style={{ marginTop: 10, maxHeight: 480, overflow: "auto" }}>
              {wire || "parse an intake or pull a corpus to see the wire"}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
