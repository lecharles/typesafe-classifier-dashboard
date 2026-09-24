import type { BatchItemResult } from "@/lib/batch";
import type { Answer, Usage } from "@/lib/schema";

export type NamedCount = { name: string; value: number };
export type Bin = { bin: string; count: number };

/** Successful results only. */
export function successes(results: BatchItemResult[]): BatchItemResult[] {
  return results.filter((r) => r.result);
}

function answerFor(r: BatchItemResult, qid: string): Answer | undefined {
  return r.result?.answers[qid];
}

/** Count how many items landed in each choice option. */
export function choiceCounts(results: BatchItemResult[], qid: string): NamedCount[] {
  const counts = new Map<string, number>();
  for (const r of results) {
    const a = answerFor(r, qid);
    if (a?.type === "choice") counts.set(a.choice, (counts.get(a.choice) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((x, y) => y.value - x.value);
}

/** Histogram of score levels (0..levels-1) using human labels. */
export function scoreHistogram(results: BatchItemResult[], qid: string, levels: string[]): Bin[] {
  const counts = new Array(levels.length).fill(0);
  for (const r of results) {
    const a = answerFor(r, qid);
    if (a?.type === "score" && a.score >= 0 && a.score < levels.length) {
      counts[Math.round(a.score)]++;
    }
  }
  return levels.map((label, i) => ({ bin: label, count: counts[i] }));
}

/** Histogram of a noul probability, bucketed into 10% bins. */
export function noulHistogram(results: BatchItemResult[], qid: string): Bin[] {
  const buckets = new Array(10).fill(0);
  for (const r of results) {
    const a = answerFor(r, qid);
    if (a?.type === "noul") {
      const idx = Math.min(9, Math.floor(a.noul * 10));
      buckets[idx]++;
    }
  }
  return buckets.map((count, i) => ({ bin: `${i * 10}-${i * 10 + 10}%`, count }));
}

/** Fraction of items whose noul probability is >= threshold. */
export function noulRate(results: BatchItemResult[], qid: string, threshold = 0.5): number {
  let yes = 0;
  let total = 0;
  for (const r of results) {
    const a = answerFor(r, qid);
    if (a?.type === "noul") {
      total++;
      if (a.noul >= threshold) yes++;
    }
  }
  return total ? yes / total : 0;
}

/** Average confidence across all choice/score answers in the batch. */
export function avgConfidence(results: BatchItemResult[]): number {
  let sum = 0;
  let n = 0;
  for (const r of results) {
    if (!r.result) continue;
    for (const a of Object.values(r.result.answers)) {
      if (a.type === "choice" || a.type === "score") {
        sum += a.confidence;
        n++;
      }
    }
  }
  return n ? sum / n : 0;
}

/** Sum token usage across the batch. */
export function sumUsage(results: BatchItemResult[]): Usage {
  return results.reduce<Usage>(
    (acc, r) => {
      if (r.result) {
        acc.input_tokens += r.result.usage.input_tokens;
        acc.output_tokens += r.result.usage.output_tokens;
      }
      return acc;
    },
    { input_tokens: 0, output_tokens: 0 },
  );
}

/** Count of items by publish month, chronological. */
export function countByMonth(items: { publishedAt: string }[]): Bin[] {
  const counts = new Map<string, number>();
  for (const it of items) {
    const month = it.publishedAt.slice(0, 7); // YYYY-MM
    counts.set(month, (counts.get(month) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bin, count]) => ({ bin, count }));
}
