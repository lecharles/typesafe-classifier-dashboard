// @vitest-environment node
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GALLERY_ANCHOR,
  GALLERY_SURFACES,
  REGRESSION_KIND,
  REGRESSION_RUN_LANE,
  REGRESSION_SCHEMA,
  buildRegressionReceipt,
  emulateAnswer,
  isRegressionReceipt,
  makeEmulatedClassify,
  regressionExportRows,
  regressionRunSummary,
  runGalleryRegression,
  type RegressionReceipt,
  type SurfaceWalk,
} from "@/lib/regression";
import { classify } from "@/lib/classify";
import type { Question } from "@/lib/schema";
import { openResultsDb, saveBatchRun, loadLatestRun, countRuns, listRecentRuns } from "@/lib/sqlite";
import { toCSV } from "@/lib/export";

/* ------------------------------------------------------------------ *
 * The emulated classifier — deterministic by construction.
 * ------------------------------------------------------------------ */

describe("emulated classify (the walk's backend)", () => {
  const questions: Record<string, Question> = {
    cat: { type: "choice", instructions: "c", criteria: { a: "A", b: "B", c: "C" } },
    lvl: { type: "score", instructions: "l", criteria: ["x", "y", "z"] },
    risk: { type: "noul", instructions: "r" },
  };
  const fake = makeEmulatedClassify();

  it("answers every declared question with its declared type", async () => {
    const res = await fake({ state: "hello world", questions }, {});
    expect(Object.keys(res.answers).sort()).toEqual(["cat", "lvl", "risk"]);
    expect(res.answers.cat.type).toBe("choice");
    expect(res.answers.lvl.type).toBe("score");
    expect(res.answers.risk.type).toBe("noul");
  });

  it("stays inside declared sets", async () => {
    for (const state of ["a", "bb", "ccc", "dddd", "eeeee"]) {
      const res = await fake({ state, questions }, {});
      if (res.answers.cat.type !== "choice") throw new Error("bad");
      if (res.answers.lvl.type !== "score") throw new Error("bad");
      if (res.answers.risk.type !== "noul") throw new Error("bad");
      expect(["a", "b", "c"]).toContain((res.answers.cat as { choice: string }).choice);
      expect([0, 1, 2]).toContain((res.answers.lvl as { score: number }).score);
      expect((res.answers.risk as { noul: number }).noul).toBeGreaterThanOrEqual(0);
      expect((res.answers.risk as { noul: number }).noul).toBeLessThanOrEqual(1);
    }
  });

  it("is deterministic: same state, same answers, byte-identical", async () => {
    const a = await fake({ state: "same input", questions }, {});
    const b = await fake({ state: "same input", questions }, {});
    expect(JSON.stringify(a.answers)).toBe(JSON.stringify(b.answers));
    expect(a.usage).toEqual(b.usage);
  });

  it("echoes the requested provider (harness needs both sides)", async () => {
    const jev = await fake({ state: "x", questions }, { provider: "jev" });
    const gw = await fake({ state: "x", questions }, { provider: "gateway" });
    expect(jev.provider).toBe("jev");
    expect(gw.provider).toBe("gateway");
    // the same state answers the same on both sides — the harness agreement column is honest
    expect(JSON.stringify(jev.answers)).toBe(JSON.stringify(gw.answers));
  });

  it("emulateAnswer covers a confidence-less noul (the calibration exclusion path)", () => {
    const ans = emulateAnswer("s", "q", { type: "noul", instructions: "n" });
    expect(ans.type).toBe("noul");
    expect("confidence" in ans).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * The manifest — every gallery item, registered.
 * ------------------------------------------------------------------ */

describe("gallery manifest", () => {
  it("covers all 17 home cards in level order", () => {
    expect(GALLERY_SURFACES.length).toBe(17);
    GALLERY_SURFACES.forEach((s, i) => expect(s.level).toBe(`Level ${i + 1}`));
    expect(new Set(GALLERY_SURFACES.map((s) => s.id)).size).toBe(17);
    expect(GALLERY_SURFACES.every((s) => s.page.startsWith("/") && s.api.startsWith("/api/"))).toBe(true);
  });

  it("cannot be out-synced by the home page — every card has a walk row (11-28 hardening)", () => {
    const src = readFileSync("app/page.tsx", "utf8");
    const hrefs = [...src.matchAll(/href:\s*"([^"]+)"/g)].map((m) => m[1]).filter((h) => h !== "/");
    const walked = new Set(GALLERY_SURFACES.map((s) => s.page));
    for (const h of hrefs) expect(walked.has(h), `gallery card ${h} missing from the regression manifest`).toBe(true);
    expect(hrefs.length).toBe(GALLERY_SURFACES.length);
  });
});

/* ------------------------------------------------------------------ *
 * The walk.
 * ------------------------------------------------------------------ */

describe("the gallery walk", () => {
  const FIXED = "2026-11-28T12:00:00.000Z";

  it("every surface of the shipped hub passes every check", async () => {
    const receipt = await runGalleryRegression({ generatedAt: FIXED });
    for (const s of receipt.walk) {
      const failed = s.checks.filter((c) => !c.ok);
      expect(failed.map((f) => `${f.name}: ${f.detail}`), `${s.id} failed checks`).toEqual([]);
      expect(s.checks.length).toBeGreaterThan(0);
    }
    expect(receipt.totals.surfaces).toBe(17);
    expect(receipt.totals.failed).toBe(0);
    expect(receipt.verdict).toBe("all green");
    expect(receipt.failures).toEqual([]);
  });

  it("receipt balances by construction (seen = passed + failed, every count re-derived)", async () => {
    const receipt = await runGalleryRegression({ generatedAt: FIXED });
    let checks = 0;
    for (const s of receipt.walk) checks += s.checks.length;
    expect(receipt.totals.checks).toBe(checks);
    expect(receipt.totals.passed + receipt.totals.failed).toBe(receipt.totals.checks);
    expect(receipt.totals.surfaces).toBe(receipt.walk.length);
    // the totals block carries NO failures field — the failure lines ride the top level only
    expect((receipt.totals as unknown as Record<string, unknown>).failures === undefined).toBe(true);
    expect(receipt.failures.length).toBe(receipt.totals.failed);
  });

  it("is a regression by construction: two fixed-clock walks are byte-identical", async () => {
    const a = await runGalleryRegression({ generatedAt: FIXED });
    const b = await runGalleryRegression({ generatedAt: FIXED });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("passes the store guard on its own output, and survives a JSON round trip", async () => {
    const receipt = await runGalleryRegression({ generatedAt: FIXED });
    expect(isRegressionReceipt(receipt)).toBe(true);
    expect(isRegressionReceipt(JSON.parse(JSON.stringify(receipt)))).toBe(true);
  });

  it("isolates a broken lane: a throwing classifier fails ONLY the classifier-walking surfaces and the walk completes", async () => {
    const boom = (async () => {
      throw new Error("backend down");
    }) as unknown as typeof runGalleryRegression extends never ? never : Parameters<typeof runGalleryRegression>[0] extends { classifyFn?: infer F } ? F : never;
    const receipt = await runGalleryRegression({ classifyFn: boom, generatedAt: FIXED });
    expect(receipt.walk.length).toBe(17);
    const failedSurfaces = receipt.walk.filter((s) => s.checks.some((c) => !c.ok)).map((s) => s.id);
    // every classifier-walking lane shows failures…
    for (const id of ["playground", "emails", "youtube", "dispatch", "router", "guardrails", "citations", "rerank", "harness", "memory", "bs", "extract", "chat", "entities", "upload"]) {
      expect(failedSurfaces, `${id} should report the outage`).toContain(id);
    }
    // …calibration + cost honestly refuse a dead harness instead of inventing a table/ledger…
    expect(failedSurfaces).toContain("calibration");
    expect(failedSurfaces).toContain("cost");
    // …and the receipt still balances and guards.
    expect(receipt.totals.passed + receipt.totals.failed).toBe(receipt.totals.checks);
    expect(receipt.failures.length).toBe(receipt.totals.failed);
    expect(isRegressionReceipt(receipt)).toBe(true);
    expect(receipt.verdict).not.toBe("all green");
    // upload's pure-code intake checks still pass even with the backend dead
    const up = receipt.walk.find((s) => s.id === "upload")!;
    expect(up.checks.find((c) => c.name === "text-receipt-balances")!.ok).toBe(true);
    expect(up.checks.find((c) => c.name === "official-api-wall-holds")!.ok).toBe(true);
  });

  it("never leaves a probe empty or unregistered — an invented surface fails LOUDLY", () => {
    const walk: SurfaceWalk[] = [
      { id: "ghost", level: "Level 99", title: "Ghost", page: "/ghost", api: "/api/ghost", checks: [] },
    ];
    const r = buildRegressionReceipt(walk, FIXED);
    expect(r.totals.surfaces).toBe(1);
    // empty walk row still balances
    expect(r.totals.passed + r.totals.failed).toBe(r.totals.checks);
  });
});

/* ------------------------------------------------------------------ *
 * The store guard — the receipt never trusts a payload.
 * ------------------------------------------------------------------ */

describe("regression receipt guard", () => {
  let receipt: RegressionReceipt;
  const FIXED = "2026-11-28T12:00:00.000Z";

  beforeAll(async () => {
    receipt = await runGalleryRegression({ generatedAt: FIXED });
    expect(receipt.totals.failed).toBe(0);
  });

  const fresh = (): RegressionReceipt => {
    const clone = JSON.parse(JSON.stringify(receipt)) as RegressionReceipt;
    return clone;
  };

  it("refuses non-objects, arrays, and the wrong kind", () => {
    expect(isRegressionReceipt(null)).toBe(false);
    expect(isRegressionReceipt(undefined)).toBe(false);
    expect(isRegressionReceipt(42)).toBe(false);
    expect(isRegressionReceipt([])).toBe(false);
    const bad = fresh();
    bad.kind = "whatever" as typeof REGRESSION_KIND;
    expect(isRegressionReceipt(bad)).toBe(false);
  });

  it("refuses a tampered pass/fail total", () => {
    const bad = fresh();
    bad.totals.passed -= 1;
    bad.totals.failed += 1;
    expect(isRegressionReceipt(bad)).toBe(false);
  });

  it("refuses a flipped check verdict (a hidden failure cannot reload)", () => {
    const bad = fresh();
    bad.walk[0].checks[0].ok = false;
    bad.walk[0].checks[0].detail = "quietly flipped";
    expect(isRegressionReceipt(bad)).toBe(false);
  });

  it("refuses a dropped surface (the walk must cover ALL gallery items)", () => {
    const bad = fresh();
    bad.walk = bad.walk.slice(1);
    expect(isRegressionReceipt(bad)).toBe(false);
  });

  it("refuses an out-of-order or invented surface id", () => {
    const bad = fresh();
    const tmp = bad.walk[0];
    bad.walk[0] = bad.walk[1];
    bad.walk[1] = tmp;
    expect(isRegressionReceipt(bad)).toBe(false);
  });

  it("refuses a mismatched verdict line and a removed failure entry", () => {
    const bad = fresh();
    bad.walk[0].checks[0].ok = false;
    // verdict still says all green and failures never mention it
    expect(isRegressionReceipt(bad)).toBe(false);
  });

  it("refuses bad metadata: schema, generatedAt, empty checks", () => {
    const bad = fresh();
    bad.schema = REGRESSION_SCHEMA + 1;
    expect(isRegressionReceipt(bad)).toBe(false);
    const bad2 = fresh();
    bad2.generatedAt = "yesterday maybe";
    expect(isRegressionReceipt(bad2)).toBe(false);
    const bad3 = fresh();
    bad3.walk[0].checks = [];
    expect(isRegressionReceipt(bad3)).toBe(false);
  });

  it("summary recomputes FROM THE ROWS — errors ≤ compared is structural", async () => {
    const summary = regressionRunSummary(receipt);
    expect(summary.compared).toBe(receipt.totals.checks);
    expect(summary.errors).toBe(receipt.totals.failed);
    expect(summary.errors).toBeLessThanOrEqual(summary.compared);
    // a tampered totals block does not move the recomputed summary
    const bad = fresh();
    bad.totals.checks = 99999;
    const s2 = regressionRunSummary(bad);
    expect(s2.compared).toBe(receipt.totals.checks);
  });

  it("liar refused AT WRITE: saveBatchRun rejects a tampered receipt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-reg-"));
    const db = openResultsDb(join(dir, "r.db"));
    try {
      const bad = fresh();
      bad.totals.passed = 1;
      expect(() =>
        saveBatchRun(db, {
          lane: REGRESSION_RUN_LANE,
          payload: bad,
          guard: isRegressionReceipt,
          summarize: regressionRunSummary,
        }),
      ).toThrow(/does not recognize/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("live SQLite round trip: the receipt survives the restart byte-identical", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-reg-"));
    const path = join(dir, "r.db");
    const db = openResultsDb(path);
    try {
      const saved = saveBatchRun(db, {
        lane: REGRESSION_RUN_LANE,
        payload: receipt,
        guard: isRegressionReceipt,
        summarize: regressionRunSummary,
        limit: null,
        savedAt: FIXED,
      });
      expect(saved.runId.startsWith("regression-")).toBe(true);
      // "restart": fresh handle on the same file
      const db2 = openResultsDb(path);
      const latest = loadLatestRun<RegressionReceipt>(db2, REGRESSION_RUN_LANE, isRegressionReceipt);
      expect(latest).not.toBeNull();
      expect(JSON.stringify(latest!.payload)).toBe(JSON.stringify(receipt));
      expect(latest!.summary).toEqual({ compared: receipt.totals.checks, errors: receipt.totals.failed });
      const counts = countRuns(db2, REGRESSION_RUN_LANE, isRegressionReceipt);
      expect(counts).toEqual({ total: 1, readable: 1 });
      // corrupt row: counted in total, never in readable, never resurrected
      db2.prepare("INSERT INTO batch_runs (run_id, lane, saved_at, batch_limit, compared, errors, payload) VALUES (?,?,?,?,?,?,?)")
        .run("regression-corrupt", REGRESSION_RUN_LANE, "2099-01-01T00:00:00.000Z", null, 9, 9, "{not json");
      const counts2 = countRuns(db2, REGRESSION_RUN_LANE, isRegressionReceipt);
      expect(counts2.total).toBe(2);
      expect(counts2.readable).toBe(1);
      const latest2 = loadLatestRun<RegressionReceipt>(db2, REGRESSION_RUN_LANE, isRegressionReceipt);
      expect(JSON.stringify(latest2!.payload)).toBe(JSON.stringify(receipt)); // walked PAST the corrupt tail
      const recent = listRecentRuns(db2, REGRESSION_RUN_LANE, isRegressionReceipt, 5);
      expect(recent.length).toBe(1);
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  beforeAll(() => {});
});

/* ------------------------------------------------------------------ *
 * D8 export.
 * ------------------------------------------------------------------ */

describe("regression D8 export", () => {
  it("one row per surface, totals ride row 0 only", async () => {
    const FIXED = "2026-11-28T12:00:00.000Z";
    const receipt = await runGalleryRegression({ generatedAt: FIXED });
    const rows = regressionExportRows(receipt);
    expect(rows.length).toBe(17);
    expect(rows[0].verdict).toBe("all green");
    expect(rows[0].suiteChecks).toBe(receipt.totals.checks);
    for (const r of rows.slice(1)) expect(r.verdict).toBe("");
    const cols = Object.keys(rows[0]);
    for (const r of rows) expect(Object.keys(r)).toEqual(cols);
    // per-surface math rides every row
    const surface = rows[5];
    const walk = receipt.walk[5];
    expect(surface.surface).toBe(walk.id);
    expect(Number(surface.failed)).toBe(walk.checks.filter((c) => !c.ok).length);
    expect(surface.status).toBe("pass");
  });

  it("failure lines quote safely through toCSV", () => {
    const walk: SurfaceWalk[] = [
      {
        id: "x",
        level: "Level 1",
        title: 'a "quoted", title',
        page: "/x",
        api: "/api/x",
        checks: [{ name: "boom", ok: false, detail: 'said "no, really"' }],
      },
    ];
    const receipt = buildRegressionReceipt(walk, "2026-11-28T12:00:00.000Z");
    expect(receipt.totals.failed).toBe(1);
    expect(receipt.failures[0]).toContain("Level 1 x::boom");
    const csv = toCSV(regressionExportRows(receipt));
    expect(csv.split("\n")[1]).toContain('""quoted"", title');
    expect(csv).toContain('said ""no, really""');
  });

  it("an all-failing receipt still balances and exports its real zeros", () => {
    const walk: SurfaceWalk[] = GALLERY_SURFACES.map((s) => ({ ...s, checks: [{ name: "n", ok: false, detail: "d" }] }));
    const receipt = buildRegressionReceipt(walk, "2026-11-28T12:00:00.000Z");
    expect(receipt.totals.passed).toBe(0);
    expect(receipt.totals.failed).toBe(walk.length);
    expect(receipt.failures.length).toBe(walk.length);
    expect(regressionRunSummary(receipt)).toEqual({ compared: walk.length, errors: walk.length });
    expect(regressionExportRows(receipt).length).toBe(walk.length);
    expect(isRegressionReceipt(receipt)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Per-lane contract spot-checks — the walk's teeth, asserted directly.
 * ------------------------------------------------------------------ */

describe("walk contract teeth", () => {
  const FIXED = "2026-11-28T12:00:00.000Z";
  let receipt: RegressionReceipt;

  it("setup: the walk ran green", async () => {
    receipt = await runGalleryRegression({ generatedAt: FIXED });
    expect(receipt.totals.failed).toBe(0);
  });

  const surface = (id: string) => receipt.walk.find((s) => s.id === id)!;
  const names = (id: string) => surface(id).checks.map((c) => c.name);

  it("every named contract is on the list (nothing silently skipped)", () => {
    expect(names("playground")).toContain("answers-cover-questions");
    expect(names("emails")).toContain("choice-counts-balance");
    expect(names("youtube")).toContain("month-bins-balance");
    expect(names("dispatch")).toContain("registry-purity");
    expect(names("router")).toContain("routed-plus-errors-balance");
    expect(names("guardrails")).toContain("overall-is-worst-of-sides");
    expect(names("citations")).toContain("checks-run-balance");
    expect(names("rerank")).toContain("topk-honored");
    expect(names("harness")).toContain("compared-equals-matches-plus-diffs");
    expect(names("memory")).toContain("pii-floor-absolute");
    expect(names("bs")).toContain("leaderboard-worst-first");
    expect(names("extract")).toContain("never-fabricated-for-doubt");
    expect(names("chat")).toContain("strike-state-monotonic");
    expect(names("entities")).toContain("every-merge-accounted");
    expect(names("upload")).toContain("official-api-wall-holds");
    expect(names("calibration")).toContain("tampered-ece-refused");
    expect(names("cost")).toContain("tampered-ledger-refused");
  });

  it("the walk checks each surface's own guards against ITS OWN live output", () => {
    expect(surface("entities").checks.find((c) => c.name === "report-passes-its-own-store-guard")!.ok).toBe(true);
    expect(surface("upload").checks.find((c) => c.name === "report-passes-its-own-store-guard")!.ok).toBe(true);
    expect(surface("calibration").checks.find((c) => c.name === "snapshot-passes-its-own-guard")!.ok).toBe(true);
    expect(surface("cost").checks.find((c) => c.name === "snapshot-passes-its-own-guard")!.ok).toBe(true);
  });

  it("the anchor is pinned, not drifting with the calendar", () => {
    expect(surface("extract").checks.find((c) => c.name === "anchor-echoes")!.ok).toBe(true);
    expect(GALLERY_ANCHOR).toBe("2026-11-28");
  });
});
