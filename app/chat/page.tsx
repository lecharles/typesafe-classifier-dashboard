"use client";

import { useEffect, useRef, useState } from "react";
import {
  CHAT_ACTIONS,
  CHAT_LEVELS,
  DEFAULT_GATES,
  applyChatStrikes,
  buildChatCorpus,
  chatBadgeClass,
  chatOffenderExportRows,
  chatStrikeBadgeClass,
  chatStrikeExportRows,
  type ChatAction,
  type ChatBatchItem,
  type ChatDecision,
  type ChatGates,
  type ChatOffenderRow,
  type ChatSignals,
  type ChatStrikeLedger,
  type ChatStrikeRow,
  type ChatStrikeState,
} from "@/lib/chat";
import { ExportButtons } from "@/components/ExportButtons";
import { ConfidenceBadge } from "@/components/charts/ConfidenceBadge";

type ModerateResponse = {
  signals?: ChatSignals;
  decision?: ChatDecision;
  gates?: ChatGates;
  model?: string;
  provider?: string;
  usage?: { input_tokens: number; output_tokens: number };
  trace?: unknown;
  error?: string;
};

type BatchResponse = {
  items: ChatBatchItem[];
  totals: {
    moderated: number;
    errors: number;
    actions: Record<ChatAction, number>;
    usage: { input_tokens: number; output_tokens: number };
  };
  offenders: ChatOffenderRow[];
  gates: ChatGates;
  model: string;
  provider: string;
  error?: string;
};

function ActionBadge({ action }: { action: ChatAction }) {
  return <span className={`badge ${chatBadgeClass(action)}`}>{action.toUpperCase()}</span>;
}

function StrikeBadge({ state }: { state: ChatStrikeState }) {
  return <span className={`badge ${chatStrikeBadgeClass(state)}`}>{state.toUpperCase()}</span>;
}

function toxicityName(v: number): string {
  return CHAT_LEVELS[Math.min(CHAT_LEVELS.length - 1, Math.floor(v))] ?? "?";
}

function MessageRow({ item }: { item: ChatBatchItem }) {
  return (
    <div style={{ marginBottom: 10, paddingBottom: 8, borderBottom: "1px solid rgba(154,164,184,.12)" }}>
      <div className="row between">
        <span className="mono" style={{ fontSize: 12 }}>
          <strong>{item.user}</strong>{" "}
          {item.message.slice(0, 80)}
          {item.message.length > 80 ? "…" : ""}
        </span>
        {item.error ? (
          <span className="badge bad">error</span>
        ) : item.action ? (
          <ActionBadge action={item.action} />
        ) : null}
      </div>
      {item.signals && (
        <div className="row" style={{ gap: 6, marginTop: 4, flexWrap: "wrap" }}>
          <span className="badge neutral">
            toxicity: {item.signals.toxicity.toFixed(1)} ({toxicityName(item.signals.toxicity)})
          </span>
          <span className="badge neutral">promo: {item.signals.promo.toFixed(2)}</span>
          <span className="badge neutral">spoiler: {item.signals.spoiler.toFixed(2)}</span>
        </div>
      )}
      {item.error && <div className="muted" style={{ fontSize: 12 }}>{item.error}</div>}
      {item.reasons && item.reasons.length > 0 && (
        <ul className="muted" style={{ fontSize: 11.5, margin: "6px 0 0", paddingLeft: 16 }}>
          {item.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function ChatPage() {
  const [user, setUser] = useState("hype_llama");
  const [message, setMessage] = useState(
    "BUY 1000 FOLLOWERS FREE at hype-haus.example — type your password to claim, everyone's doing it!",
  );
  const [result, setResult] = useState<ModerateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dev, setDev] = useState(false);

  const [gates, setGates] = useState<ChatGates>(DEFAULT_GATES);
  const [batch, setBatch] = useState<BatchResponse | null>(null);
  const [batchLimit, setBatchLimit] = useState<number | null>(null);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [raw, setRaw] = useState("");

  // The strike ledger RIDES FROM BATCH TO BATCH — mods act on users
  // across scrolls, not per message. Escalation is folded in code
  // (applyChatStrikes) from the accumulated holds/blocks/bursts.
  const [strikeLedger, setStrikeLedger] = useState<ChatStrikeLedger | null>(null);
  const strikePrev = useRef<ChatStrikeRow[]>([]);
  const strikeSeen = useRef<Set<string>>(new Set());

  const corpus = buildChatCorpus();

  useEffect(() => {
    setDev(new URLSearchParams(window.location.search).get("dev") === "1");
  }, []);

  async function runModerate() {
    setLoading(true);
    setError(null);
    const req: Record<string, unknown> = {
      message,
      user,
      gates,
      ...(dev ? { dev: true } : {}),
    };
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      const data: ModerateResponse = await res.json();
      if (!res.ok) throw new Error(data.error || "chat moderation failed");
      setResult(data);
      setRaw((prev) =>
        JSON.stringify(
          {
            ...(prev ? JSON.parse(prev) : {}),
            last: { request: { ...req, message: `${message.slice(0, 160)}…` }, response: data },
          },
          null,
          2,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  function setGate(key: keyof ChatGates, v: number) {
    setGates((g) => ({ ...g, [key]: v }));
  }

  async function runBatch(limit: number | null) {
    setBatchLoading(true);
    setBatchError(null);
    setBatchLimit(limit);
    const req: Record<string, unknown> = {
      gates,
      ...(limit === null ? { limit: null } : { limit }),
    };
    try {
      const res = await fetch("/api/chat-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      const data: BatchResponse = await res.json();
      if (!res.ok) throw new Error(data.error || "chat batch failed");
      setBatch(data);
      setBatchLimit(data.totals.moderated);
      // Fold this scroll into the strike ledger — deduped by message
      // id, so climbing 5 → 10 → All ADDS the new messages exactly
      // once and re-running a rung never double-counts.
      {
        const fresh = data.items.filter((it) => !strikeSeen.current.has(it.id));
        for (const it of data.items) strikeSeen.current.add(it.id);
        const next = applyChatStrikes(strikePrev.current, fresh);
        strikePrev.current = next.rows;
        setStrikeLedger(next);
      }
      setRaw((prev) =>
        JSON.stringify(
          {
            ...(prev ? JSON.parse(prev) : {}),
            batch: {
              request: { ...req, corpus: `${corpus.length} messages (live scroll)` },
              response: data,
            },
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

  const s = result?.signals;

  return (
    <div>
      <h1>Live chat filter — Twitch-style</h1>
      <p className="subtitle">
        UC#9 · insults, spam &amp; spoilers out of the stream chat — toxicity (Score) +
        promo &amp; spoiler (Noul) decide allow / hold / block in CODE · 28-message
        synthetic stream scroll, batch ladder 5 → 10 → All · per-user offender rollup
        exported through the D8 pipeline, folded batch-to-batch into a repeat-offender
        strike ledger (watch → timeout → ban, escalation decided in code — tempo alone
        never bans) because mods act on USERS not messages
      </p>

      {error && <div className="error-banner">{error}</div>}

      <div className="grid cols-2" style={{ gap: 16, alignItems: "start" }}>
        <div>
          <div className="card">
            <label className="muted" style={{ fontSize: 12 }}>
              handle (mods act on users — the handle rides the message)
            </label>
            <input
              value={user}
              onChange={(e) => setUser(e.target.value)}
              maxLength={64}
              style={{ width: "100%", marginTop: 4 }}
            />
            <label className="muted" style={{ fontSize: 12, marginTop: 10, display: "block" }}>
              paste one live-chat message
            </label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              style={{ width: "100%", marginTop: 4, resize: "vertical" }}
            />
            <div className="row" style={{ gap: 12, marginTop: 10, alignItems: "center" }}>
              <button onClick={runModerate} disabled={loading} className="primary">
                {loading ? "Moderating…" : "Moderate this message"}
              </button>
              <span className="muted" style={{ fontSize: 12 }}>
                the classifier answers typed questions; the action is picked in code
              </span>
            </div>

            <div className="grid cols-2" style={{ marginTop: 14, gap: 10 }}>
              {(
                [
                  ["blockAt", `block at (toxicity ≥)`, 0, 4, 0.5],
                  ["allowAt", `allow at (toxicity ≤)`, 0, 4, 0.5],
                  ["promoBlockAt", "promo floor", 0, 1, 0.05],
                  ["spoilerFloor", "spoiler floor", 0, 1, 0.05],
                  ["lowConfBump", "confidence demotion", 0, 1, 0.05],
                ] as [keyof ChatGates, string, number, number, number][]
              ).map(([key, label, min, max, step]) => (
                <label
                  key={key}
                  className="muted"
                  style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 8 }}
                >
                  {label}
                  <input
                    type="range"
                    min={min}
                    max={max}
                    step={step}
                    value={gates[key]}
                    onChange={(e) => setGate(key, Number(e.target.value))}
                  />
                  <strong className="mono">{gates[key].toFixed(2)}</strong>
                </label>
              ))}
            </div>
          </div>

          {result?.decision && (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="row between" style={{ marginBottom: 10 }}>
                <strong>Chat action</strong>
                <span className="muted" style={{ fontSize: 12 }}>
                  classifier: {result.provider} · {result.model} ·{" "}
                  {result.usage && (
                    <span className="mono">
                      {result.usage.input_tokens}↑ {result.usage.output_tokens}↓ tok
                    </span>
                  )}
                </span>
              </div>
              <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <ActionBadge action={result.decision.action} />
                {s && (
                  <>
                    <span className="badge neutral">
                      toxicity: {s.toxicity.toFixed(1)} (
                      {CHAT_LEVELS[Math.min(Math.floor(s.toxicity), CHAT_LEVELS.length - 1)]})
                    </span>
                    <span className="badge neutral">promo: {s.promo.toFixed(2)}</span>
                    <span className="badge neutral">spoiler: {s.spoiler.toFixed(2)}</span>
                    <ConfidenceBadge value={s.confidence} />
                  </>
                )}
              </div>
              <ul className="muted" style={{ fontSize: 12.5, margin: "8px 0 0", paddingLeft: 18 }}>
                {result.decision.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="card" style={{ marginTop: 16 }}>
            <div className="row between" style={{ marginBottom: 8 }}>
              <strong>Batch discipline · live stream scroll</strong>
              <span className="muted" style={{ fontSize: 12 }}>
                {corpus.length} messages · 5 → 10 → All
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
                <div className="grid cols-3" style={{ marginTop: 12, gap: 10 }}>
                  {CHAT_ACTIONS.map((a) => (
                    <div key={a} className="stat-tile">
                      <div className="label">action: {a}</div>
                      <div className="value">
                        <span className={`badge ${chatBadgeClass(a)}`}>{batch.totals.actions[a]}</span>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="row between" style={{ margin: "12px 0", fontSize: 13 }}>
                  <span>
                    <span className="badge good">{batch.totals.moderated} moderated</span>{" "}
                    <span className="muted mono" style={{ fontSize: 12 }}>
                      {batch.totals.usage.input_tokens}↑ {batch.totals.usage.output_tokens}↓ tok
                    </span>{" "}
                    {batch.totals.errors > 0 && (
                      <span className="badge bad">{batch.totals.errors} errors</span>
                    )}
                  </span>
                  <span className="muted mono" style={{ fontSize: 12 }}>
                    gates block≥{batch.gates.blockAt} allow≤{batch.gates.allowAt} · promo{" "}
                    {batch.gates.promoBlockAt.toFixed(2)}
                  </span>
                </div>
                {batch.offenders.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <div className="row between" style={{ alignItems: "center" }}>
                      <strong style={{ fontSize: 13 }}>Per-user offender rollup</strong>
                      <ExportButtons
                        filename={`chat-offenders-${batch.offenders.length}`}
                        rows={chatOffenderExportRows(batch.offenders)}
                      />
                    </div>
                    <p className="muted" style={{ fontSize: 12, margin: "4px 0 8px" }}>
                      timeout candidates decided in data — blocks dominate holds (score =
                      blocks ×10 + holds), user as the final tiebreaker; clean chatgoers never appear;
                      CSV/JSON export through the D8 pipeline
                    </p>
                    <table>
                      <thead>
                        <tr>
                          <th>user</th>
                          <th>holds</th>
                          <th>blocks</th>
                          <th>score</th>
                        </tr>
                      </thead>
                      <tbody>
                        {batch.offenders.map((o) => (
                          <tr key={o.user}>
                            <td className="mono">{o.user}</td>
                            <td className="mono">{o.holds}</td>
                            <td className="mono">{o.blocks}</td>
                            <td className="mono">{o.score}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {strikeLedger && (
                  <div style={{ marginBottom: 12 }}>
                    <div className="row between" style={{ alignItems: "center" }}>
                      <strong style={{ fontSize: 13 }}>Repeat-offender strike ledger · across batches</strong>
                      <ExportButtons
                        filename={`chat-strikes-${strikeLedger.rows.length}`}
                        rows={chatStrikeExportRows(strikeLedger.rows)}
                      />
                    </div>
                    <p className="muted" style={{ fontSize: 12, margin: "4px 0 8px" }}>
                      sustained-offender escalation decided IN CODE from the accumulated ledger
                      (watch → timeout → ban): a block never gets walked back by a quiet scroll;
                      bot tempo (a handle posting &gt;4 messages per fold) only ever feeds holds —
                      <strong>the ban lane needs real blocks</strong>, because speed is suspicious,
                      not attacking; errored messages excluded and counted ({strikeLedger.errors}{" "}
                      in the last fold), never silently dropped
                    </p>
                    {strikeLedger.rows.length > 0 ? (
                      <table>
                        <thead>
                          <tr>
                            <th>user</th>
                            <th>holds</th>
                            <th>blocks</th>
                            <th>bursts</th>
                            <th>score</th>
                            <th>state</th>
                          </tr>
                        </thead>
                        <tbody>
                          {strikeLedger.rows.map((r) => (
                            <tr key={r.user}>
                              <td className="mono">{r.user}</td>
                              <td className="mono">{r.holds}</td>
                              <td className="mono">{r.blocks}</td>
                              <td className="mono">{r.bursts}</td>
                              <td className="mono">{r.score}</td>
                              <td>
                                <StrikeBadge state={r.state} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <p className="muted" style={{ fontSize: 12 }}>
                        nobody on the board — no handle has earned a hold or a block across{" "}
                        {strikeLedger.folded} folded messages
                      </p>
                    )}
                    <div className="row" style={{ gap: 10, marginTop: 8, alignItems: "center" }}>
                      <button
                        className="ghost"
                        onClick={() => {
                          // Amnesty is an EXPLICIT mod call, never a
                          // side effect of quiet traffic.
                          strikePrev.current = [];
                          strikeSeen.current = new Set();
                          setStrikeLedger(null);
                        }}
                      >
                        Clear ledger (mod amnesty)
                      </button>
                      <span className="muted" style={{ fontSize: 11.5 }}>
                        resets the accumulation; the ledger never resets itself
                      </span>
                    </div>
                  </div>
                )}
                {batch.items.map((it) => (
                  <MessageRow key={it.id} item={it} />
                ))}
              </>
            )}
          </div>
        </div>

        <div className="card">
          <strong>Raw JSON</strong>
          <pre className="mono" style={{ marginTop: 10, maxHeight: 480, overflow: "auto" }}>
            {raw || "moderate a message to see the wire"}
          </pre>
        </div>
      </div>
    </div>
  );
}
