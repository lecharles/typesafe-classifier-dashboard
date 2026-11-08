"use client";

import { useEffect, type ReactNode } from "react";

/**
 * D4: right-hand drill-over panel. Open it with a row click, dismiss it with
 * the ×, the backdrop, or Escape.
 */
export function SlideOver({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <>
      <div className="slide-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="slide-over" role="dialog" aria-modal="true" aria-label={title}>
        <div className="row between" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="ghost" onClick={onClose} aria-label="Close panel">
            ×
          </button>
        </div>
        <div style={{ overflowY: "auto" }}>{children}</div>
      </aside>
    </>
  );
}
