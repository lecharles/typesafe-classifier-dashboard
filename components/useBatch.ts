"use client";

import { useEffect, useState } from "react";
import type { BatchItem, BatchItemResult } from "@/lib/batch";
import type { Question } from "@/lib/schema";
import { saveRun, loadRun, clearStoredRun } from "@/lib/persist";

export function useBatch(storageKey?: string) {
  const [results, setResults] = useState<BatchItemResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // D8: restore the last run for this dashboard from localStorage.
  useEffect(() => {
    if (!storageKey || typeof window === "undefined") return;
    const stored = loadRun(window.localStorage, storageKey);
    if (stored) {
      setResults(stored.results as BatchItemResult[]);
      setSavedAt(stored.savedAt);
    }
  }, [storageKey]);

  async function run(items: BatchItem[], questions: Record<string, Question>) {
    setLoading(true);
    setError(null);
    setResults([]);
    setSavedAt(null);
    // Shared dev view: ?dev=1 asks the API to attach raw request/response traces.
    const dev =
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("dev") === "1";
    try {
      const res = await fetch("/api/classify-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(dev ? { items, questions, dev: true } : { items, questions }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "request failed");
      const next = data.results as BatchItemResult[];
      setResults(next);
      if (storageKey && typeof window !== "undefined") {
        setSavedAt(saveRun(window.localStorage, storageKey, next));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setLoading(false);
    }
  }

  function clearRun() {
    setResults([]);
    setSavedAt(null);
    if (storageKey && typeof window !== "undefined") {
      clearStoredRun(window.localStorage, storageKey);
    }
  }

  return { results, loading, error, run, savedAt, clearRun };
}
