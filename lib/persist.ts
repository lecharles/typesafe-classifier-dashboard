/**
 * D8: localStorage persistence of the most recent batch run per dashboard,
 * so a page refresh (or a return the next day) restores the last classification.
 */

export type StoredRun = { savedAt: string; results: unknown[] };

const key = (k: string) => `jev.run.${k}`;

export function saveRun(storage: Storage, k: string, results: unknown[]): string {
  const savedAt = new Date().toISOString();
  storage.setItem(key(k), JSON.stringify({ savedAt, results }));
  return savedAt;
}

export function loadRun(storage: Storage, k: string): StoredRun | null {
  try {
    const raw = storage.getItem(key(k));
    if (!raw) return null;
    const d = JSON.parse(raw) as { savedAt?: unknown; results?: unknown };
    if (!d || !Array.isArray(d.results)) return null;
    return { savedAt: String(d.savedAt ?? ""), results: d.results };
  } catch {
    return null;
  }
}

export function clearStoredRun(storage: Storage, k: string) {
  storage.removeItem(key(k));
}
