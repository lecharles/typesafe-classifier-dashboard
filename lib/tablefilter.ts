import type { RouteBucket } from "@/lib/routing";

/**
 * D4: click-to-filter on the Emails dashboard. Pure helpers so the page
 * component stays declarative and the logic is unit-testable.
 */

export type EmailFilterKind = "category" | "priority" | "urgency" | "routing";
export type EmailFilter = { kind: EmailFilterKind; value: string };

/** The per-row fields a filter matches against (derived from the batch result). */
export type EmailFilterableRow = {
  cat: string;
  priLabel: string;
  urgBin: string;
  routing: RouteBucket;
};

export const FILTER_LABELS: Record<EmailFilterKind, string> = {
  category: "Category",
  priority: "Priority",
  urgency: "Urgency",
  routing: "Routing",
};

/** Bucket a 0..1 noul probability into the same "40-50%" label the histogram draws. */
export function urgencyBin(p: number): string {
  const i = Math.min(9, Math.max(0, Math.floor(p * 10)));
  return `${i * 10}-${i * 10 + 10}%`;
}

/** True when `row` satisfies `filter` (a null filter matches everything). */
export function matchesEmailFilter(row: EmailFilterableRow, filter: EmailFilter | null): boolean {
  if (!filter) return true;
  switch (filter.kind) {
    case "category":
      return row.cat === filter.value;
    case "priority":
      return row.priLabel === filter.value;
    case "urgency":
      return row.urgBin === filter.value;
    case "routing":
      return row.routing === filter.value;
  }
}

export function applyEmailFilter<T extends EmailFilterableRow>(
  rows: T[],
  filter: EmailFilter | null,
): T[] {
  return filter ? rows.filter((r) => matchesEmailFilter(r, filter)) : rows;
}

/** Re-clicking the same element clears the filter (single-filter UX, like D3 on YouTube). */
export function toggleEmailFilter(cur: EmailFilter | null, next: EmailFilter): EmailFilter | null {
  return cur && cur.kind === next.kind && cur.value === next.value ? null : next;
}
