"use client";

import { useState } from "react";

export function RawIO({ request, response }: { request: unknown; response: unknown }) {
  const [tab, setTab] = useState<"request" | "response">("response");
  const shown = tab === "request" ? request : response;
  return (
    <div className="card">
      <div className="row between" style={{ marginBottom: 10 }}>
        <strong>Raw API {tab}</strong>
        <div className="row" style={{ gap: 8 }}>
          <button className="ghost" onClick={() => setTab("request")} disabled={tab === "request"}>
            Request
          </button>
          <button className="ghost" onClick={() => setTab("response")} disabled={tab === "response"}>
            Response
          </button>
        </div>
      </div>
      <pre className="mono">{shown ? JSON.stringify(shown, null, 2) : "— run a classification to see output —"}</pre>
    </div>
  );
}
