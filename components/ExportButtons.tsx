"use client";

import { toCSV, toJSON, downloadFile, type ExportRow } from "@/lib/export";

/** D8: CSV/JSON export of the current table view of any dashboard. */
export function ExportButtons({ filename, rows }: { filename: string; rows: ExportRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="row" style={{ gap: 8 }}>
      <button
        className="ghost"
        onClick={() => downloadFile(`${filename}.csv`, toCSV(rows), "text/csv;charset=utf-8")}
      >
        Export CSV
      </button>
      <button
        className="ghost"
        onClick={() => downloadFile(`${filename}.json`, toJSON(rows), "application/json")}
      >
        Export JSON
      </button>
    </div>
  );
}
