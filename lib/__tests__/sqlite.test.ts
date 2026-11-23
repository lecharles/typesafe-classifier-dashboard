// @vitest-environment node
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  WALK_WINDOW,
  closeResultsDb,
  countRuns,
  listRecentRuns,
  loadLatestRun,
  openResultsDb,
  purgeLane,
  resultsDbPath,
  saveBatchRun,
  sharedResultsDb,
} from "@/lib/sqlite";
import {
  DEFAULT_GATES,
  ENTITY_VERDICTS,
  entityPairExportRows,
  entityRunSummary,
  foldEntityClusters,
  isEntityBatchReport,
  runEntityBatch,
  type EntityBatchItem,
  type EntityBatchReport,
  type EntityRecord,
} from "@/lib/entities";
import type { Answer, ClassifyResult } from "@/lib/schema";

/* ------------------------------------------------------------------ *
 * Fixtures — a REAL batch report from the ladder, via a fake classifier.
 * ------------------------------------------------------------------ */

const noul = (p: number): Answer => ({ type: "noul", noul: p });
const score = (s: number, conf = 0.9): Answer => ({
  type: "score",
  score: s,
  probabilities: { [String(Math.round(s))]: conf },
  confidence: conf,
});

function fakeResult(answers: Record<string, Answer>): ClassifyResult {
  return {
    answers,
    usage: { input_tokens: 10, output_tokens: 5 },
    model: "jev-test",
    provider: "gateway",
  };
}

function entityAnswers(over: Partial<Record<string, Answer>> = {}): Record<string, Answer> {
  return {
    similarity: score(2, 0.9),
    conflict: noul(0.05),
    genericName: noul(0.05),
    ...over,
  };
}

const rec = (id: string, name: string, extra: Partial<EntityRecord> = {}): EntityRecord => ({
  id,
  name,
  ...extra,
});

// twins merge, a contradicted chain is refused, one pair booms — the
// exact shapes a persisted run must carry through disk and back.
const corpus = [
  { id: "t01", a: rec("gA", "widget alpha"), b: rec("gB", "widget beta") }, // merge 4.9
  { id: "t02", a: rec("gB", "widget beta"), b: rec("gC", "widget gamma") }, // merge 4.2
  { id: "t03", a: rec("gA", "widget alpha"), b: rec("gD", "widget delta") }, // conflict → distinct
  { id: "t04", a: rec("gC", "widget gamma"), b: rec("gD", "widget delta") }, // merge 4.4
  { id: "t05", a: rec("gM", "BOOM breaker"), b: rec("gN", "BOOM two") }, // error
  { id: "t06", a: rec("gK", "UNRELATED lamp"), b: rec("gL", "UNRELATED side table") }, // distinct
];

async function fakeClassify(req: { state: string }): Promise<ClassifyResult> {
  if (req.state.includes("(gA)") && req.state.includes("(gB)")) {
    return fakeResult(entityAnswers({ similarity: score(4.9, 0.95) }));
  }
  if (req.state.includes("(gC)") && req.state.includes("(gD)")) {
    return fakeResult(entityAnswers({ similarity: score(4.4, 0.95) }));
  }
  if (req.state.includes("(gB)") && req.state.includes("(gC)")) {
    return fakeResult(entityAnswers({ similarity: score(4.2, 0.95) }));
  }
  if (req.state.includes("(gA)") && req.state.includes("(gD)")) {
    return fakeResult(entityAnswers({ similarity: score(4.3, 0.95), conflict: noul(0.9) }));
  }
  if (req.state.includes("BOOM")) throw new Error("gateway down for t05");
  return fakeResult(entityAnswers({ similarity: score(0.4, 0.95) }));
}

async function makeReport(): Promise<EntityBatchReport> {
  return runEntityBatch(corpus, { classifyFn: fakeClassify as never, limit: null });
}

function saveEntities(
  db: DatabaseSync,
  payload: unknown,
  over: Partial<{ limit: number | null; savedAt: string; lane: string }> = {},
) {
  return saveBatchRun(db, {
    lane: over.lane ?? "entities",
    payload,
    guard: isEntityBatchReport,
    summarize: entityRunSummary,
    limit: over.limit,
    savedAt: over.savedAt,
  });
}

/** Simulate a broken row written by something other than the store. */
function insertRaw(
  db: DatabaseSync,
  runId: string,
  lane: string,
  savedAt: string,
  payload: string,
) {
  db.prepare(
    `INSERT INTO batch_runs (run_id, lane, saved_at, batch_limit, compared, errors, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(runId, lane, savedAt, null, 1, 0, payload);
}

const tmpRoot = mkdtempSync(join(tmpdir(), "jev-results-"));
const freshMem = () => openResultsDb(":memory:");
let memN = 0;
const tmpFile = () => join(tmpRoot, `store-${memN++}.db`);

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */

describe("UC#10-persist openResultsDb — schema + file discipline", () => {
  it("creates the batch_runs table and the file lands on disk", () => {
    const p = tmpFile();
    const db = openResultsDb(p);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='batch_runs'")
      .all();
    expect(tables.length).toBe(1);
    closeResultsDb(db);
    expect(existsSync(p)).toBe(true);
  });

  it("re-opening an existing file keeps every stored row (the table is on disk, not in the handle)", () => {
    const p = tmpFile();
    const db1 = openResultsDb(p);
    db1.exec("CREATE TABLE IF NOT EXISTS probe(x)");
    db1.exec("INSERT INTO probe VALUES (7)");
    closeResultsDb(db1);
    const db2 = openResultsDb(p);
    expect((db2.prepare("SELECT x FROM probe").get() as { x: number }).x).toBe(7);
    closeResultsDb(db2);
  });

  it("resultsDbPath: RESULTS_DB_PATH wins; default is data/results.db under cwd", () => {
    const prev = process.env.RESULTS_DB_PATH;
    try {
      process.env.RESULTS_DB_PATH = join(tmpRoot, "custom.db");
      expect(resultsDbPath()).toBe(join(tmpRoot, "custom.db"));
      delete process.env.RESULTS_DB_PATH;
      expect(resultsDbPath().endsWith(join("data", "results.db"))).toBe(true);
    } finally {
      if (prev !== undefined) process.env.RESULTS_DB_PATH = prev;
      else delete process.env.RESULTS_DB_PATH;
    }
  });

  it("sharedResultsDb caches one handle per path — the server does not re-open per request", () => {
    const a = tmpFile();
    const b = tmpFile();
    const d1 = sharedResultsDb(a);
    expect(sharedResultsDb(a)).toBe(d1);
    expect(sharedResultsDb(b)).not.toBe(d1);
    closeResultsDb(d1);
    closeResultsDb(sharedResultsDb(b));
  });
});

describe("UC#10-persist saveBatchRun — the store decides, in code, before anything is written", () => {
  it("returns a receipt: lane-prefixed runId, ISO savedAt, recomputed summary", async () => {
    const db = freshMem();
    const rep = await makeReport();
    const saved = saveEntities(db, rep, { limit: null });
    expect(saved.runId.startsWith("entities-")).toBe(true);
    expect(Number.isInteger(Date.parse(saved.savedAt))).toBe(true);
    expect(saved.summary).toEqual({ compared: 6, errors: 1 });
    expect(saved.payload).toBe(rep);
    closeResultsDb(db);
  });

  it("runIds are unique even for identical reports saved back-to-back", async () => {
    const db = freshMem();
    const rep = await makeReport();
    const ids = new Set([
      saveEntities(db, rep).runId,
      saveEntities(db, rep).runId,
      saveEntities(db, rep).runId,
    ]);
    expect(ids.size).toBe(3);
    closeResultsDb(db);
  });

  it("REFUSES a payload the lane guard does not recognize — and stores nothing", () => {
    const db = freshMem();
    expect(() => saveEntities(db, {})).toThrow(/does not recognize/);
    expect(() => saveEntities(db, [1, 2, 3])).toThrow(/does not recognize/);
    expect(() => saveEntities(db, "not even an object")).toThrow(/does not recognize/);
    const counts = countRuns(db, "entities", isEntityBatchReport);
    expect(counts).toEqual({ total: 0, readable: 0 });
    closeResultsDb(db);
  });

  it("the summary columns are RECOMPUTED — a caller-supplied summarize owns what is stored, not the payload", async () => {
    const db = freshMem();
    const rep = await makeReport();
    saveBatchRun(db, {
      lane: "entities",
      payload: rep,
      guard: isEntityBatchReport,
      summarize: () => ({ compared: 42, errors: 7 }),
      limit: null,
    });
    const loaded = loadLatestRun<EntityBatchReport>(db, "entities", isEntityBatchReport);
    expect(loaded?.summary).toEqual({ compared: 42, errors: 7 });
    expect(loaded?.payload.totals.compared).toBe(6); // payload untouched, columns still code-side
    closeResultsDb(db);
  });

  it("rejects nonsense summaries: non-integer, negative, or errors > compared", async () => {
    const db = freshMem();
    const rep = await makeReport();
    const base = { lane: "entities", payload: rep, guard: isEntityBatchReport };
    expect(() =>
      saveBatchRun(db, { ...base, summarize: () => ({ compared: 1.5, errors: 0 }) }),
    ).toThrow(/non-negative integer/);
    expect(() =>
      saveBatchRun(db, { ...base, summarize: () => ({ compared: 3, errors: -1 }) }),
    ).toThrow(/non-negative integer/);
    expect(() =>
      saveBatchRun(db, { ...base, summarize: () => ({ compared: 3, errors: 5 }) }),
    ).toThrow(/exceed/);
    expect(countRuns(db, "entities", isEntityBatchReport).total).toBe(0);
    closeResultsDb(db);
  });

  it("rejects nonsense limits and timestamps; accepts null = All", async () => {
    const db = freshMem();
    const rep = await makeReport();
    expect(() => saveEntities(db, rep, { limit: 2.5 })).toThrow(/non-negative integer/);
    expect(() => saveEntities(db, rep, { limit: -1 })).toThrow(/non-negative integer/);
    expect(() => saveEntities(db, rep, { savedAt: "yesterday" })).toThrow(/ISO timestamp/);
    const all = saveEntities(db, rep, { limit: null });
    expect(all.limit).toBeNull();
    const five = saveEntities(db, rep, { limit: 5 });
    expect(five.limit).toBe(5);
    expect(saveEntities(db, rep).limit).toBeNull(); // omitted → stored as null
    closeResultsDb(db);
  });

  it("rejects a blank or overlong lane slug", async () => {
    const db = freshMem();
    const rep = await makeReport();
    expect(() => saveEntities(db, rep, { lane: "   " })).toThrow(/lane/);
    expect(() => saveEntities(db, rep, { lane: "x".repeat(65) })).toThrow(/lane/);
    closeResultsDb(db);
  });

  it("the payload column is honest JSON of the whole report, errors and blocked joins included", async () => {
    const db = freshMem();
    const rep = await makeReport();
    saveEntities(db, rep, { limit: null });
    const row = db.prepare("SELECT payload FROM batch_runs").get() as { payload: string };
    const back = JSON.parse(row.payload) as EntityBatchReport;
    expect(back.items.find((i) => i.id === "t05")?.error).toMatch(/gateway down/);
    expect(back.blocked.length).toBe(1);
    closeResultsDb(db);
  });
});

describe("UC#10-persist read paths — never trust, never silently drop", () => {
  it("empty store: latest null, list empty, counts zeroed", () => {
    const db = freshMem();
    expect(loadLatestRun(db, "entities", isEntityBatchReport)).toBeNull();
    expect(listRecentRuns(db, "entities", isEntityBatchReport, 5)).toEqual([]);
    expect(countRuns(db, "entities", isEntityBatchReport)).toEqual({ total: 0, readable: 0 });
    closeResultsDb(db);
  });

  it("newest-first by savedAt — an explicit history walks back in order", async () => {
    const db = freshMem();
    const rep = await makeReport();
    saveEntities(db, rep, { savedAt: "2026-11-21T00:00:00.000Z" });
    saveEntities(db, rep, { savedAt: "2026-11-23T00:00:00.000Z" });
    saveEntities(db, rep, { savedAt: "2026-11-22T00:00:00.000Z" });
    const latest = loadLatestRun<EntityBatchReport>(db, "entities", isEntityBatchReport);
    expect(latest?.savedAt).toBe("2026-11-23T00:00:00.000Z");
    const recent = listRecentRuns(db, "entities", isEntityBatchReport, 5);
    expect(recent.map((r) => r.savedAt)).toEqual([
      "2026-11-23T00:00:00.000Z",
      "2026-11-22T00:00:00.000Z",
      "2026-11-21T00:00:00.000Z",
    ]);
    closeResultsDb(db);
  });

  it("same-millisecond saves still have ONE newest — rowid breaks the tie deterministically", async () => {
    const db = freshMem();
    const rep = await makeReport();
    const a = saveEntities(db, rep, { savedAt: "2026-11-23T12:00:00.000Z" });
    const b = saveEntities(db, rep, { savedAt: "2026-11-23T12:00:00.000Z" });
    const latest = loadLatestRun(db, "entities", isEntityBatchReport);
    expect(latest?.runId).toBe(b.runId);
    expect(latest?.runId).not.toBe(a.runId);
    closeResultsDb(db);
  });

  it("lane isolation: a chat lane never sees the entities runs and vice versa", async () => {
    const db = freshMem();
    const rep = await makeReport();
    saveEntities(db, rep);
    expect(loadLatestRun(db, "chat", isEntityBatchReport)).toBeNull();
    expect(countRuns(db, "chat", isEntityBatchReport)).toEqual({ total: 0, readable: 0 });
    expect(countRuns(db, "entities", isEntityBatchReport).total).toBe(1);
    closeResultsDb(db);
  });

  it("a corrupt tail is WALKED PAST, not obeyed — and visible as the total/readable gap", async () => {
    const db = freshMem();
    const rep = await makeReport();
    saveEntities(db, rep, { savedAt: "2026-11-21T00:00:00.000Z" });
    saveEntities(db, rep, { savedAt: "2026-11-22T00:00:00.000Z" });
    insertRaw(db, "entities-broken", "entities", "2026-11-23T00:00:00.000Z", "{not json");
    const latest = loadLatestRun<EntityBatchReport>(db, "entities", isEntityBatchReport);
    expect(latest?.savedAt).toBe("2026-11-22T00:00:00.000Z"); // newest VALID, not newest row
    expect(countRuns(db, "entities", isEntityBatchReport)).toEqual({ total: 3, readable: 2 });
    const recent = listRecentRuns(db, "entities", isEntityBatchReport, 5);
    expect(recent.length).toBe(2); // broken row skipped, never silently counted as a run
    closeResultsDb(db);
  });

  it("a guard-failing JSON row is skipped exactly like garbage", async () => {
    const db = freshMem();
    const rep = await makeReport();
    saveEntities(db, rep, { savedAt: "2026-11-21T00:00:00.000Z" });
    insertRaw(db, "entities-shape", "entities", "2026-11-22T00:00:00.000Z", JSON.stringify({ items: [] }));
    const latest = loadLatestRun(db, "entities", isEntityBatchReport);
    expect(latest?.savedAt).toBe("2026-11-21T00:00:00.000Z");
    expect(countRuns(db, "entities", isEntityBatchReport)).toEqual({ total: 2, readable: 1 });
    closeResultsDb(db);
  });

  it("listRecentRuns caps: integers honored, negatives/0 empty, non-integers refused, > MAX clamped", async () => {
    const db = freshMem();
    const rep = await makeReport();
    for (let i = 1; i <= 7; i++) {
      saveEntities(db, rep, { savedAt: `2026-11-${String(i).padStart(2, "0")}T00:00:00.000Z` });
    }
    expect(listRecentRuns(db, "entities", isEntityBatchReport, 3).map((r) => r.savedAt)).toEqual([
      "2026-11-07T00:00:00.000Z",
      "2026-11-06T00:00:00.000Z",
      "2026-11-05T00:00:00.000Z",
    ]);
    expect(listRecentRuns(db, "entities", isEntityBatchReport, 0)).toEqual([]);
    expect(listRecentRuns(db, "entities", isEntityBatchReport, -5)).toEqual([]);
    expect(listRecentRuns(db, "entities", isEntityBatchReport, 999).length).toBe(7);
    expect(() => listRecentRuns(db, "entities", isEntityBatchReport, 2.5)).toThrow(/integer/);
    closeResultsDb(db);
  });

  it("walk window is bounded — the store does not table-scan forever hunting one good row", () => {
    expect(WALK_WINDOW).toBeGreaterThan(0);
    expect(WALK_WINDOW).toBeLessThanOrEqual(256);
  });

  it("purgeLane clears a lane and reports exactly how many rows it removed", async () => {
    const db = freshMem();
    const rep = await makeReport();
    saveEntities(db, rep);
    saveEntities(db, rep);
    insertRaw(db, "entities-x", "entities", "2026-11-23T00:00:00.000Z", "{}");
    expect(purgeLane(db, "entities")).toBe(3);
    expect(loadLatestRun(db, "entities", isEntityBatchReport)).toBeNull();
    expect(purgeLane(db, "entities")).toBe(0);
    closeResultsDb(db);
  });
});

describe("UC#10-persist THE SPIKE CLAIM — a run survives a restart", () => {
  it("save under one connection, close it, re-open the FILE: the newest report comes back whole", async () => {
    const p = tmpFile();
    const rep = await makeReport();
    const db1 = openResultsDb(p);
    const saved = saveEntities(db1, rep, { limit: null });
    const sizeBefore = statSync(p).size;
    closeResultsDb(db1); // simulated process death
    expect(sizeBefore).toBeGreaterThan(0);

    const db2 = openResultsDb(p);
    const loaded = loadLatestRun<EntityBatchReport>(db2, "entities", isEntityBatchReport);
    expect(loaded).not.toBeNull();
    expect(loaded?.runId).toBe(saved.runId);
    expect(loaded?.payload).toEqual(rep);
    expect(loaded?.summary).toEqual({ compared: 6, errors: 1 });
    expect(loaded?.limit).toBeNull();
    closeResultsDb(db2);
  });

  it("a restored report STILL FOLDS: clusters recomputed from loaded items equal the stored ones", async () => {
    const p = tmpFile();
    const rep = await makeReport();
    const db1 = openResultsDb(p);
    saveEntities(db1, rep, { limit: null });
    closeResultsDb(db1);

    const db2 = openResultsDb(p);
    const loaded = loadLatestRun<EntityBatchReport>(db2, "entities", isEntityBatchReport)!;
    const refold = foldEntityClusters(loaded.payload.items as EntityBatchItem[]);
    expect(refold.clusters).toEqual(rep.clusters);
    expect(refold.blocked).toEqual(rep.blocked);
    // and the chain that was refused while live is still refused after reload
    expect(loaded.payload.blocked.length).toBe(1);
    expect(loaded.payload.blocked[0].reason).toMatch(/never overrules a called separation/);
    closeResultsDb(db2);
  });

  it("a restored report still feeds the D8 export pipeline unchanged", async () => {
    const p = tmpFile();
    const rep = await makeReport();
    const db1 = openResultsDb(p);
    saveEntities(db1, rep, { limit: 5 });
    closeResultsDb(db1);
    const db2 = openResultsDb(p);
    const loaded = loadLatestRun<EntityBatchReport>(db2, "entities", isEntityBatchReport)!;
    const rows = entityPairExportRows(loaded.payload.items);
    expect(rows.length).toBe(6);
    expect(rows[0]).toHaveProperty("pair");
    expect(rows[0]).toHaveProperty("verdict");
    expect(loaded.limit).toBe(5); // rung of the run that made it rides along
    closeResultsDb(db2);
  });
});

describe("UC#10-persist isEntityBatchReport — shape AND self-consistency", () => {
  it("accepts a real report fresh off the ladder", async () => {
    expect(isEntityBatchReport(await makeReport())).toBe(true);
  });

  it("rejects everything that is not an object at all", () => {
    for (const junk of [null, undefined, 42, "report", [], [{}]]) {
      expect(isEntityBatchReport(junk)).toBe(false);
    }
  });

  it("rejects structural liars: missing keys, wrong item shapes, unknown verdicts, bad providers", async () => {
    const rep = await makeReport();
    const cut = (mutate: (r: Record<string, unknown>) => void) => {
      const clone = JSON.parse(JSON.stringify(rep)) as Record<string, unknown>;
      mutate(clone);
      expect(isEntityBatchReport(clone)).toBe(false);
    };
    cut((r) => {
      r.items = "not an array";
    });
    cut((r) => {
      delete r.totals;
    });
    cut((r) => {
      delete r.gates;
    });
    cut((r) => {
      (r.items as Record<string, unknown>[])[0].verdict = "banana";
    });
    cut((r) => {
      (r.items as Record<string, unknown>[])[0].a = { id: "ghost" }; // name missing
    });
    cut((r) => {
      r.provider = "gpt-4";
    });
    cut((r) => {
      (r.blocked as Record<string, unknown>[]).length && delete (r.blocked as unknown[])[0];
    });
    const badGates = JSON.parse(JSON.stringify(rep)) as unknown as {
      gates: Record<string, unknown>;
    };
    badGates.gates.mergeAt = "three point five";
    expect(isEntityBatchReport(badGates)).toBe(false);
  });

  it("rejects reports whose summary LIES about their own items", async () => {
    const rep = await makeReport();
    const inflate = JSON.parse(JSON.stringify(rep)) as EntityBatchReport;
    inflate.totals.compared = 999;
    expect(isEntityBatchReport(inflate)).toBe(false);

    const fakeErrors = JSON.parse(JSON.stringify(rep)) as EntityBatchReport;
    fakeErrors.totals.errors = 0;
    expect(isEntityBatchReport(fakeErrors)).toBe(false);

    const fakeTally = JSON.parse(JSON.stringify(rep)) as EntityBatchReport;
    fakeTally.totals.verdicts.merge = fakeTally.totals.verdicts.merge + 1;
    expect(isEntityBatchReport(fakeTally)).toBe(false);
  });

  it("entityRunSummary recomputes from items — compared = count, errors = errored count", async () => {
    const rep = await makeReport();
    expect(entityRunSummary(rep)).toEqual({
      compared: rep.items.length,
      errors: rep.items.filter((i) => !!i.error).length,
    });
    expect(entityRunSummary(rep)).toEqual({ compared: 6, errors: 1 });
  });

  it("every shipped verdict in a live report is inside the declared ladder set", async () => {
    const rep = await makeReport();
    for (const i of rep.items) {
      if (!i.error && i.verdict) expect(ENTITY_VERDICTS).toContain(i.verdict);
    }
    expect(rep.gates).toEqual(DEFAULT_GATES);
  });
});
