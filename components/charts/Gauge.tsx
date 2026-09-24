"use client";

// A compact 0..1 gauge rendered as a horizontal meter (accessible, no chart lib needed).
export function Gauge({ label, value }: { label: string; value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const color = pct >= 66 ? "#ff6b6b" : pct >= 33 ? "#ffb454" : "#3ecf8e";
  return (
    <div className="stat-tile" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div className="between row" style={{ marginBottom: 8 }}>
        <span className="label">{label}</span>
        <span style={{ fontWeight: 700, color }}>{pct}%</span>
      </div>
      <div className="progress">
        <div style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}
