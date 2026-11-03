export function StatTile({
  label,
  value,
  onClick,
  active = false,
  hint,
}: {
  label: string;
  value: string | number;
  /** Optional: makes the tile a button (e.g. click a count to filter the table). */
  onClick?: () => void;
  active?: boolean;
  hint?: string;
}) {
  const cls = `stat-tile${onClick ? " clickable" : ""}${active ? " active" : ""}`;
  if (onClick) {
    return (
      <div className={cls} role="button" tabIndex={0} title={hint} aria-pressed={active} onClick={onClick}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onClick(); }}>
        <div className="label">{label}</div>
        <div className="value">{value}</div>
      </div>
    );
  }
  return (
    <div className={cls}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}
