import { classify } from "@/lib/classify";
import type { ClassifyResult, Question } from "@/lib/schema";

export type BatchItem = { id: string; state: string };

export type BatchItemResult = {
  id: string;
  result?: ClassifyResult;
  error?: string;
};

/**
 * Classify many items with a bounded concurrency pool. A failure on one item is
 * isolated (recorded as `error`) and does not abort the rest of the batch.
 */
export async function classifyBatch(
  items: BatchItem[],
  questions: Record<string, Question>,
  opts: { concurrency?: number; classifyFn?: typeof classify } = {},
): Promise<BatchItemResult[]> {
  const concurrency = Math.max(1, opts.concurrency ?? 5);
  const run = opts.classifyFn ?? classify;
  const results: BatchItemResult[] = new Array(items.length);
  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i];
      try {
        const result = await run({ state: item.state, questions });
        results[i] = { id: item.id, result };
      } catch (err) {
        results[i] = { id: item.id, error: err instanceof Error ? err.message : "failed" };
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}
