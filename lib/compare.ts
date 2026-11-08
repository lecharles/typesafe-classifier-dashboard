import type { Answer, ClassifyResult, Provider } from "@/lib/schema";

/**
 * D5: comparison helpers for the Playground's provider toggle and
 * ask-both side-by-side mode. Pure + unit-testable.
 */

export type ProviderChoice = "auto" | Provider;

export const PROVIDER_CHOICES: { id: ProviderChoice; label: string; hint: string }[] = [
  { id: "auto", label: "Auto", hint: "Server default: Jev if a key is set, else the gateway" },
  { id: "jev", label: "Jev", hint: "Real TypeSafe/Jev API (System One)" },
  { id: "gateway", label: "Gateway", hint: "Emulated primitives via Vercel AI Gateway" },
];

/** The effective decision of an answer: option key, rounded level, or yes/no. */
export function decisionOf(a: Answer): string | number | boolean {
  switch (a.type) {
    case "choice":
      return a.choice;
    case "score":
      return Math.round(a.score);
    case "noul":
      return a.noul >= 0.5;
  }
}

/** Two answers agree when they share a type and an identical decision. */
export function answersMatch(x: Answer, y: Answer): boolean {
  return x.type === y.type && decisionOf(x) === decisionOf(y);
}

export type Agreement = "match" | "diff" | "n/a";

/** Per-question match report across two results (n/a when either side lacks it). */
export function compareResults(
  x: ClassifyResult | null | undefined,
  y: ClassifyResult | null | undefined,
): Record<string, Agreement> {
  const ids = new Set<string>([
    ...Object.keys(x?.answers ?? {}),
    ...Object.keys(y?.answers ?? {}),
  ]);
  const out: Record<string, Agreement> = {};
  for (const id of ids) {
    const a = x?.answers[id];
    const b = y?.answers[id];
    out[id] = a && b ? (answersMatch(a, b) ? "match" : "diff") : "n/a";
  }
  return out;
}

/** "412 ms" for sub-second, "1.34 s" beyond; em-dash when unknown. */
export function latencyLabel(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return "—";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}
