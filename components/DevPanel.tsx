"use client";

import { useMemo, useState } from "react";
import type { BatchItemResult } from "@/lib/batch";

/**
 * D7 shared dev view (?dev=1): per-item raw provider payloads plus
 * retry/fallback diagnostics, straight from the batch trace.
 */
export function DevPanel({ results }: { results: BatchItemResult[] }) {
  const [openId, setOpenId] = useState<string | null>(null);

  const stats = useMemo(() => {
    let retried = 0;
    let fallbacks = 0;
    const providers = new Set<string>();
    for (const r of results) {
      const t = r.result?.trace;
      if (!t) continue;
      providers.add(t.provider_used);
      if (t.retries > 0) retried++;
      if (t.fallback_from) fallbacks++;
    }
    return { retried, fallbacks, providers: [...providers] };
  }, [results]);

  if (results.length === 0) return null;

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="row between" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>Dev view</h2>
        <span className="muted" style={{ fontSize: 13 }}>
          {results.length} items · providers: {stats.providers.join(", ") || "—"} · retried:{" "}
          {stats.retried} · fallbacks: {stats.fallbacks}
        </span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th>Status</th>
            <th>Provider</th>
            <th>Attempts</th>
            <th>Fallback</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {results.map((r) => {
            const t = r.result?.trace;
            const failed = !r.result;
            return (
              <tr key={r.id}>
                <td className="mono">{r.id}</td>
                <td>
                  <span className={`badge ${failed ? "bad" : "good"}`}>
                    {failed ? "error" : "ok"}
                  </span>
                </td>
                <td>{t ? t.provider_used : failed ? "—" : "(no trace)"}</td>
                <td>{t ? `${t.attempts.length}${t.retries > 0 ? ` (${t.retries} retries)` : ""}` : "—"}</td>
                <td>
                  {t?.fallback_from ? (
                    <span className="badge warn" title={t.fallback_reason}>
                      from {t.fallback_from}
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  <button
                    className="ghost"
                    onClick={() => setOpenId(openId === r.id ? null : r.id)}
                  >
                    {openId === r.id ? "Hide raw" : "Raw payload"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {results
        .filter((r) => r.id === openId)
        .map((r) => {
          const t = r.result?.trace;
          return (
            <div key={`raw-${r.id}`} style={{ marginTop: 12 }}>
              <div className="row between">
                <strong className="mono">{r.id}</strong>
              </div>
              {failed(r) && (
                <pre className="mono" style={{ marginTop: 8 }}>
                  error: {r.error}
                </pre>
              )}
              {t ? (
                <div className="grid cols-2" style={{ gap: 12, marginTop: 8 }}>
                  <div>
                    <p className="muted" style={{ fontSize: 12 }}>Request → {t.endpoint}</p>
                    <pre className="mono">{JSON.stringify(t.request, null, 2)}</pre>
                  </div>
                  <div>
                    <p className="muted" style={{ fontSize: 12 }}>Response</p>
                    <pre className="mono">
                      {typeof t.response === "string"
                        ? t.response
                        : JSON.stringify(t.response ?? {}, null, 2)}
                    </pre>
                    {t.attempts.length > 1 && (
                      <pre className="mono">{JSON.stringify(t.attempts, null, 2)}</pre>
                    )}
                  </div>
                </div>
              ) : (
                <p className="muted" style={{ fontSize: 13 }}>
                  No trace on this item — run the batch with ?dev=1 to capture raw payloads.
                </p>
              )}
            </div>
          );
        })}
    </div>
  );
}

const failed = (r: BatchItemResult) => !r.result;
