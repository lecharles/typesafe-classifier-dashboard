/**
 * D8: CSV/JSON export helpers for every dashboard.
 * Pure functions so they can be unit tested without a DOM.
 */

export type ExportCell = string | number | boolean | null | undefined;
export type ExportRow = Record<string, ExportCell>;

/** RFC-4180-ish CSV: quote anything with comma/quote/newline, double inner quotes. */
export function toCSV(rows: ExportRow[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const esc = (v: ExportCell) => {
    const s = v == null ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers, ...rows.map((r) => headers.map((h) => r[h]))]
    .map((line) => line.map(esc).join(","))
    .join("\r\n");
}

export function toJSON(rows: ExportRow[]): string {
  return JSON.stringify(rows, null, 2);
}

/** Trigger a browser download. No-op during SSR. */
export function downloadFile(name: string, text: string, mime: string) {
  if (typeof window === "undefined") return;
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
