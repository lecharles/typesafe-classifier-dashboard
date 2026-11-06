export type RouteBucket = "auto" | "assist" | "human";

export interface RoutingThresholds {
  /** Confidence at or above this routes to auto-handling. */
  high: number;
  /** Confidence below this routes to a human; in between is assist. */
  low: number;
}

export const DEFAULT_THRESHOLDS: RoutingThresholds = { high: 0.8, low: 0.5 };

/**
 * Confidence-gated routing decision for a single item.
 * conf >= high  -> auto (Jev handles end-to-end)
 * conf <  low   -> human (route to a person)
 * otherwise     -> assist (Jev drafts, human confirms)
 */
export function routeDecision(conf: number, t: RoutingThresholds): RouteBucket {
  if (conf >= t.high) return "auto";
  if (conf < t.low) return "human";
  return "assist";
}

export interface RoutingSummary {
  auto: number;
  assist: number;
  human: number;
  total: number;
  /** Share of items safe to auto-handle, 0..1. */
  autoRate: number;
}

export function summarizeRouting(
  confidences: Iterable<number>,
  t: RoutingThresholds,
): RoutingSummary {
  const s: RoutingSummary = { auto: 0, assist: 0, human: 0, total: 0, autoRate: 0 };
  for (const c of confidences) {
    s[routeDecision(c, t)] += 1;
    s.total += 1;
  }
  s.autoRate = s.total ? s.auto / s.total : 0;
  return s;
}

/** Clamp + order guard so two crossed sliders can't produce an impossible band. */
export function normalizeThresholds(high: number, low: number): RoutingThresholds {
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const h = clamp01(high);
  const l = clamp01(low);
  return l > h ? { high: l, low: h } : { high: h, low: l };
}
