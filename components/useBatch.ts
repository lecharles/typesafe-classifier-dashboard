"use client";

import { useState } from "react";
import type { BatchItem, BatchItemResult } from "@/lib/batch";
import type { Question } from "@/lib/schema";

export function useBatch() {
  const [results, setResults] = useState<BatchItemResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(items: BatchItem[], questions: Record<string, Question>) {
    setLoading(true);
    setError(null);
    setResults([]);
    try {
      const res = await fetch("/api/classify-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items, questions }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "request failed");
      setResults(data.results as BatchItemResult[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setLoading(false);
    }
  }

  return { results, loading, error, run };
}
