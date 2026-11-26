/**
 * UC#10-persist (11-24 row, the SQLite results persistence spike):
 * batch reports that survive a restart.
 *
 * D8 made runs survive a page refresh through localStorage — that is
 * CLIENT state, and it dies when the server process does. This spike
 * is the server side of the same promise: every completed batch report
 * is written to a local SQLite database (`node:sqlite`, no new
 * dependency, no daemon, no port), and the entities lane re-reads the
 * latest persisted run on page load. A crashed or redeployed server
 * comes back with its last market audit still on the board.
 *
 * Spike discipline, same family as every code-side rule in this repo:
 *
 *  - THE STORE NEVER TRUSTS A PAYLOAD. Every save walks the lane's
 *    shape guard first; a payload the guard does not recognize is
 *    REFUSED at save time and SKIPPED at read time — a corrupt or
 *    hand-edited row can never resurrect itself as a report.
 *  - THE SUMMARY COLUMNS ARE COMPUTED, NEVER ACCEPTED. `compared` and
 *    `errors` are recomputed by the lane's `summarize` from the payload
 *    at save time; a stored summary that disagrees with its own report
 *    is structurally impossible because nothing ever stores one.
 *  - BROKEN ROWS ARE COUNTED, NEVER SILENTLY DROPPED. `countRuns`
 *    returns { total, readable }: a corrupt tail is visible as the gap
 *    between the two while `loadLatestRun` walks back to the newest
 *    VALID row instead of dying at it.
 *  - ORDER IS DETERMINISTIC: saved_at DESC, rowid DESC — two runs
 *    saved inside the same millisecond still have a newest.
 *
 * Scope note: the spike rides the ENTITIES lane only (like localStorage
 * persistence rode D8's chosen surfaces); the generic store is lane-
 * agnostic so other lanes can be folded in after the month close.
 */

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

/**
 * node:sqlite is loaded through CJS require on purpose: a static
 * ESM import of `node:sqlite` gets its scheme stripped by Vite's
 * module graph (vite-node chokes on it, and webpack builds are
 * fragile for newer builtins), while require() goes straight to the
 * Node runtime. Types stay strict via the ambient declaration in
 * types/node-sqlite.d.ts.
 */
const { DatabaseSync: DatabaseSyncClass } = createRequire(__filename)(
  "node:sqlite",
) as typeof import("node:sqlite");

/* ------------------------------------------------------------------ *
 * Shapes.
 * ------------------------------------------------------------------ */

export type RunSummary = { compared: number; errors: number };

export type StoredRun<T = unknown> = {
  runId: string;
  lane: string;
  /** ISO timestamp assigned when the run was persisted */
  savedAt: string;
  /** batch ladder rung that produced it; null = All */
  limit: number | null;
  /** recomputed in code at save time — never accepted from a caller */
  summary: RunSummary;
  payload: T;
};

export type SaveRunOptions<T> = {
  lane: string;
  payload: T;
  /** lane shape guard — refuses what it does not recognize */
  guard: (payload: unknown) => boolean;
  /** lane summary recomputation — the store trusts THIS, not the payload */
  summarize: (payload: unknown) => RunSummary;
  /** ladder rung (5 | 10 | null=All); non-rung integers are legal data */
  limit?: number | null;
  /** ISO override for tests / deterministic ordering; default: now */
  savedAt?: string;
};

/** Rows walked back past a corrupt tail when hunting the newest valid run. */
export const WALK_WINDOW = 64;

/** Hard ceiling on history lists — a spike never streams an unbounded table. */
export const MAX_LIST_CAP = 200;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS batch_runs (
  run_id TEXT PRIMARY KEY,
  lane TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  batch_limit INTEGER,
  compared INTEGER NOT NULL,
  errors INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_batch_runs_lane ON batch_runs (lane, saved_at DESC);
`;

type Row = {
  run_id: string | null;
  lane: string | null;
  saved_at: string | null;
  batch_limit: number | bigint | null;
  compared: number | bigint | null;
  errors: number | bigint | null;
  payload: string | null;
};

/* ------------------------------------------------------------------ *
 * Connection management.
 * ------------------------------------------------------------------ */

/** RESULTS_DB_PATH wins (tests + the deploy can point the store anywhere). */
export function resultsDbPath(): string {
  const env = process.env.RESULTS_DB_PATH;
  if (env && env.trim()) {
    return isAbsolute(env) ? env : resolve(process.cwd(), env);
  }
  return join(process.cwd(), "data", "results.db");
}

export function openResultsDb(path: string = resultsDbPath()): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSyncClass(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}

export function closeResultsDb(db: DatabaseSync): void {
  db.close();
}

/**
 * One handle per path for the whole server process — Next route handlers
 * run in the same node process under `next start`, so the store stays
 * open between requests instead of re-fsyncing per call.
 */
const handleCache = globalThis as unknown as { __jevResultsDbs?: Map<string, DatabaseSync> };

export function sharedResultsDb(path: string = resultsDbPath()): DatabaseSync {
  if (!handleCache.__jevResultsDbs) handleCache.__jevResultsDbs = new Map();
  const cached = handleCache.__jevResultsDbs.get(path);
  if (cached) return cached;
  const db = openResultsDb(path);
  handleCache.__jevResultsDbs.set(path, db);
  return db;
}

/* ------------------------------------------------------------------ *
 * Save.
 * ------------------------------------------------------------------ */

function countable(n: unknown, what: string): number {
  if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`results: ${what} must be a non-negative integer, got ${String(n)}`);
  }
  return n;
}

/**
 * Persist one completed batch report. Everything the store writes about
 * the run (its summary columns, its refusal to accept garbage) is
 * decided IN CODE here, before a single byte touches the table.
 */
export function saveBatchRun<T>(db: DatabaseSync, opts: SaveRunOptions<T>): StoredRun<T> {
  const lane = typeof opts.lane === "string" ? opts.lane.trim() : "";
  if (!lane || lane.length > 64) {
    throw new Error("results: lane must be a non-empty slug (64 chars or fewer)");
  }
  if (!opts.guard(opts.payload)) {
    throw new Error(
      `results: refusing to store a payload the '${lane}' shape guard does not recognize`,
    );
  }
  // The summary is RECOMPUTED from the payload — a stored summary that
  // disagrees with its own report cannot exist, because nothing ever
  // stores one.
  const summary = opts.summarize(opts.payload);
  const compared = countable(summary.compared, "compared");
  const errors = countable(summary.errors, "errors");
  if (errors > compared) {
    throw new Error(`results: errors (${errors}) exceed compared (${compared})`);
  }
  let limit: number | null = null;
  if (opts.limit !== undefined && opts.limit !== null) {
    limit = countable(opts.limit, "limit");
  }
  const savedAt = opts.savedAt ?? new Date().toISOString();
  if (!Number.isInteger(Date.parse(savedAt))) {
    throw new Error(`results: savedAt must be a parseable ISO timestamp, got ${savedAt}`);
  }
  const runId = `${lane}-${randomUUID()}`;
  db.prepare(
    `INSERT INTO batch_runs (run_id, lane, saved_at, batch_limit, compared, errors, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(runId, lane, savedAt, limit, compared, errors, JSON.stringify(opts.payload));
  return { runId, lane, savedAt, limit, summary: { compared, errors }, payload: opts.payload };
}

/* ------------------------------------------------------------------ *
 * Read.
 * ------------------------------------------------------------------ */

function rowToRun(row: Row, guard: (payload: unknown) => boolean): StoredRun | null {
  if (!row || typeof row.payload !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload);
  } catch {
    return null; // corrupt row: skipped on read, counted by countRuns — never trusted
  }
  if (!guard(parsed)) return null; // wrong shape: same discipline
  return {
    runId: String(row.run_id ?? ""),
    lane: String(row.lane ?? ""),
    savedAt: String(row.saved_at ?? ""),
    limit: row.batch_limit === null || row.batch_limit === undefined ? null : Number(row.batch_limit),
    summary: { compared: Number(row.compared ?? 0), errors: Number(row.errors ?? 0) },
    payload: parsed,
  };
}

const SELECT_ROWS = `
SELECT run_id, lane, saved_at, batch_limit, compared, errors, payload
FROM batch_runs WHERE lane = ?
ORDER BY saved_at DESC, rowid DESC
LIMIT ?`;

/**
 * Newest VALID run for a lane. A corrupt tail is walked past (up to
 * WALK_WINDOW rows) rather than obeyed — and countRuns still shows the
 * gap, so the skip is never silent.
 */
export function loadLatestRun<T = unknown>(
  db: DatabaseSync,
  lane: string,
  guard: (payload: unknown) => boolean,
): StoredRun<T> | null {
  const rows = db.prepare(SELECT_ROWS).all(lane, WALK_WINDOW) as unknown as Row[];
  for (const r of rows) {
    const run = rowToRun(r, guard);
    if (run) return run as StoredRun<T>;
  }
  return null;
}

/** Newest-first valid runs for a lane, capped. Non-integer caps are refused. */
export function listRecentRuns<T = unknown>(
  db: DatabaseSync,
  lane: string,
  guard: (payload: unknown) => boolean,
  cap: number,
): StoredRun<T>[] {
  if (!Number.isInteger(cap)) {
    throw new Error(`results: list cap must be an integer, got ${String(cap)}`);
  }
  const n = Math.max(0, Math.min(cap, MAX_LIST_CAP));
  if (n === 0) return [];
  const rows = db.prepare(SELECT_ROWS).all(lane, n + WALK_WINDOW) as unknown as Row[];
  const out: StoredRun<T>[] = [];
  for (const r of rows) {
    const run = rowToRun(r, guard);
    if (run) {
      out.push(run as StoredRun<T>);
      if (out.length >= n) break;
    }
  }
  return out;
}

/**
 * { total, readable } — the honest spike answer to "what broke?": a
 * corrupt row lives in total and not in readable, so skipped garbage is
 * VISIBLE as a gap instead of quietly gone.
 */
export function countRuns(
  db: DatabaseSync,
  lane: string,
  guard: (payload: unknown) => boolean,
): { total: number; readable: number } {
  const totalRow = db
    .prepare("SELECT COUNT(*) AS n FROM batch_runs WHERE lane = ?")
    .get(lane) as { n: number | bigint } | undefined;
  const rows = db
    .prepare("SELECT payload FROM batch_runs WHERE lane = ?")
    .all(lane) as unknown as { payload: string | null }[];
  let readable = 0;
  for (const r of rows) {
    try {
      if (typeof r.payload === "string" && guard(JSON.parse(r.payload))) readable += 1;
    } catch {
      // broken row: counted in total, never in readable
    }
  }
  return { total: Number(totalRow?.n ?? 0), readable };
}

/** Delete every stored run for a lane (housekeeping; returns rows removed). */
export function purgeLane(db: DatabaseSync, lane: string): number {
  const res = db.prepare("DELETE FROM batch_runs WHERE lane = ?").run(lane);
  return Number(res.changes);
}

/* ------------------------------------------------------------------ *
 * Cross-lane scan (cost lane): the ledger prices WHATEVER is on disk.
 * ------------------------------------------------------------------ */

export type RawRunRow = {
  lane: string;
  runId: string;
  savedAt: string;
  /** parsed JSON — null when the row is corrupt (counted, never trusted) */
  payload: unknown | null;
};

/**
 * Newest-first rows across EVERY lane, capped. Deliberately guard-less:
 * the CALLING lane's extractor decides what is a receipt, so a lane this
 * file knows nothing about still reaches the ledger (or its honest
 * skip). Corrupt payloads come back as payload: null — counted, never
 * silently dropped.
 */
export function scanAllRuns(db: DatabaseSync, cap = 100): RawRunRow[] {
  if (!Number.isInteger(cap)) {
    throw new Error(`results: scan cap must be an integer, got ${String(cap)}`);
  }
  const n = Math.max(0, Math.min(cap, MAX_LIST_CAP));
  if (n === 0) return [];
  const rows = db
    .prepare(
      `SELECT lane, run_id, saved_at, payload FROM batch_runs
       ORDER BY lane ASC, saved_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(n) as unknown as { lane: string | null; run_id: string | null; saved_at: string | null; payload: string | null }[];
  return rows.map((r) => {
    let payload: unknown | null = null;
    try {
      payload = typeof r.payload === "string" ? JSON.parse(r.payload) : null;
    } catch {
      payload = null; // corrupt: the lane's extractor counts it as refused
    }
    return {
      lane: String(r.lane ?? ""),
      runId: String(r.run_id ?? ""),
      savedAt: String(r.saved_at ?? ""),
      payload,
    };
  });
}

/** What is on disk, lane by lane — the honest "before you price it" view. */
export function laneSummaries(
  db: DatabaseSync,
): { lane: string; runs: number; newest: string }[] {
  const rows = db
    .prepare(
      `SELECT lane, COUNT(*) AS n, MAX(saved_at) AS newest
       FROM batch_runs GROUP BY lane ORDER BY lane ASC`,
    )
    .all() as unknown as { lane: string | null; n: number | bigint; newest: string | null }[];
  return rows.map((r) => ({ lane: String(r.lane ?? ""), runs: Number(r.n ?? 0), newest: String(r.newest ?? "") }));
}
