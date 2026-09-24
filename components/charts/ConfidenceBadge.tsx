export function ConfidenceBadge({ value }: { value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const cls = pct >= 75 ? "good" : pct >= 50 ? "warn" : "bad";
  return <span className={`badge ${cls}`}>{pct}%</span>;
}
