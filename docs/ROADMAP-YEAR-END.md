# Year-end shipping calendar — Nov 3 → Dec 31, 2026

Lanes:
- **C** — Typesafe Classifier Dashboard / Jev Expertise Hub (`:8094`, this repo)
- **T** — LLM Tuner commit train (`llm-fine-tuner-agent-tester`, `:8090`)
- **S** — Signal-ops daily digest (`:8091`, cron `39f1e9255bcf` @ 15:00 UTC)

Streak rule (Carlos, unchanged): **at least one visible commit per lane, per calendar
day**. Weekend rows are scoped docs/tests/polish. Never idle the train.

## Daily test floor (every day, before committing)

- C: `npx tsc --noEmit` · `npm run build` · `npm test` (vitest, 36 green as of 11-03) ·
  live check `http://76.13.122.86:8094/` · one dogfood click-pass on the day's surface
- T: `py_compile` + fresh `import main` + `pytest` · `npm run build` when frontend touched ·
  live check `:8090`
- S: digest delivered to home channel; delivery errors logged
- Secrets stay in `~/secrets/*.env` on the VPS. Never in git.

---

## Today — Tue 11-03

| Lane | Commit |
|---|---|
| C | This calendar + D3 verification (36 tests, tsc, live :8094 ✅) |
| T | **Arm the November train** — flip S46–S74 rows `DRAFT → TODO` in `docs/COMMIT-TRAIN-NOVEMBER.md` (needs Carlos GO; lane then runs the 11-04 14:00 UTC catch-up). Streak broke 11-02; arming restores it. |
| S | Daily digest ran ✅ (15:08 UTC). One-time unblock pending on Carlos: X cookie export for quote posting. |

## November — daily

| Date | C — Jev Expertise Hub | T — LLM Tuner (drafted rows) |
|---|---|---|
| 11-04 | D4: Emails click-to-filter + row drill-over (raw payload slide-over) | S46 backup/restore recipe + drill |
| 11-05 | D5: Playground provider toggle + ask-both side-by-side + latency pills | S47 HTTPS at the edge (certbot script + proxy ADR) |
| 11-06 | D6: Confidence-gated routing view on Emails (threshold sliders) | S48 `docs/MAC-VERIFY.md` — 10 pending recipes |
| 11-07 (Sat) | D7: shared dev view `?dev=1` — per-item raw Jev payloads + retry/fallback | S49 pairing-token mint UI + `POST /api/bridge/pair` |
| 11-08 (Sun) | D8: CSV/JSON export all dashboards + localStorage run persistence | S50 end-to-end train handoff over WS hub |
| 11-09 | UC#1 tool-call dispatcher scaffold (5-function registry, Choice-per-arg) | S51 loss-curve axis labels + tooltips |
| 11-10 | UC#1 dispatcher live: batches 5→10, confidence-gated execution in code | S52 companion protocol unit tests vs fake hub |
| 11-11 | UC#2 model router dashboard | S53 Library 2: public dataset detail |
| 11-12 | UC#3 LLM guardrails (screen-in / screen-out) | S54 passlib retirement + filelock bump |
| 11-13 | UC#4 citation checker + UC#5 RAG re-ranker | S55 `:8090` restart runbook |
| 11-14 (Sat) | D14: emulated-vs-Jev comparison page | S56 dataset dedupe + merge QA pairs |
| 11-15 (Sun) | UC#6 memory curator scaffold | S57 GitHub issues reconciliation |
| 11-16 | UC#6 memory curator live + tests | S58 Compare 3: side-by-side scoring |
| 11-17 | UC#7 internet-BS unified (spam + clickbait merged) | S59 per-user train queue (409 on second start) |
| 11-18 (Sun) | UC#7 ranked BS leaderboard + export | S60 auth-throttle + CSP regression tests |
| 11-19 | UC#8 date/value extraction | S61 dataset export JSONL + sharegpt |
| 11-20 | UC#8 extraction validation-in-code + tests | S62 `llmtuner serve` Modelfile generation |
| 11-21 (Sat) | UC#9 Twitch-style chat filter | S63 Mac-verify checkpoint #2 (fix what S48/S50 surface) |
| 11-22 (Sun) | UC#9 chat filter batch discipline 5→10→All | S64 Settings page (account + bridge perms) |
| 11-23 | UC#10 entity alignment / dedup | S65 contextual hints on Library/History/Settings |
| 11-24 | UC#10 dedup + tests; SQLite results persistence spike | S66 CI polish: pytest budget + build artifact |
| 11-25 | Real-corpora upload (official APIs only) + UI | S67 search 1: FTS5 migration + endpoint |
| 11-26 | Calibration view: confidence vs correctness | S68 search 2: UI + command-K palette |
| 11-27 | Cost/token dashboard (Jev $/Mtok tracking) | S69 request-latency metrics p50/p95 |
| 11-28 (Sat) | Regression hardening: live tests over every gallery item | S70 Mac-verify checkpoint #3 + S71 onboarding demo seed |
| 11-29 (Sun) | Accessibility + keyboard-nav pass | S72 visibility fuzz tests + S73 QUICKSTART/DEMO refresh |
| 11-30 | **Month close: v0.2 tag, November retro, December draft** | S74 **Month close: v0.2.0-rc, November retro, December draft** |

## December — daily

December T rows formally land in the November close-out (S74 deliverable);
this is the draft they arm from. Gate reminders: RN prototype needs #25 sign-off,
Swift shell needs S50 end-to-end.

| Date | C — Jev Expertise Hub | T — LLM Tuner |
|---|---|---|
| 12-01 | Arm December train + one-click deploy prep (Vercel) | rc-feedback triage from Mac-verify |
| 12-02 | Case study #1 write-up: tool-call dispatcher (the agentic flagship) | Stabilization fix 1 |
| 12-03 | Case study #2 write-up: model router (with cost-savings numbers) | Stabilization fix 2 |
| 12-04 | Case study #3 write-up: guardrails | Stabilization fix 3 |
| 12-05 (Sat) | Comparison harness v2: agreement + calibration across all datasets | v0.2.0 GA prep |
| 12-06 (Sun) | README + docs overhaul, fresh screenshot gallery | **v0.2.0 tag + release notes** |
| 12-07 | Hierarchical-classification experiment (beam over Choice probs) | React Native Expo prototype day 1 (gated) |
| 12-08 | UC#11 skill-suggestion for agent catalogs | RN day 2 + TestFlight prep |
| 12-09 | Intelliprompter prototype (live transcript tick-off) | RN day 3 |
| 12-10 | Box-questions spike (images / danger-zone) | RN wrap + feasibility findings |
| 12-11 | Perf pass: batch latency, caching, bundle size | macOS Swift menu-bar day 1 (gated) |
| 12-12 (Sat) | Security review: key handling, CSP on :8094, dep audit | Swift day 2 |
| 12-13 (Sun) | Demo video walkthrough (capture skill) | Swift wrap + findings |
| 12-14 | Test coverage push: ≥90% on `lib/` | Mac installer polish |
| 12-15 | Paste-in "bring your own data" on every gallery | Postgres migration decision ADR |
| 12-16 | Live YouTube data via official API end-to-end | Multi-user quota design |
| 12-17 | Public landing page for the hub | Backup/restore drill #2 |
| 12-18 | Usage analytics: which use-cases get clicked | Security hardening pass |
| 12-19 (Sat) | Bug bash + polish | Xmas-safe docs row |
| 12-20 (Sun) | Bug bash + polish | Docs row |
| 12-21 | Case study bundle #4: memory curator | Docs row |
| 12-22 | Case study bundle #5: BS detector | Docs row |
| 12-23 | Calibration deep-dive page | Docs row |
| 12-24 | Light: docs + tests | Light: docs + tests |
| 12-25 | Light: year-journal entry | Light: changelog |
| 12-26 (Sat) | Light: screenshot refresh | Light: docs |
| 12-27 | Best-of-2026 gallery curation | Code-health sweep for the year |
| 12-28 | Uptime + deploy check, all three lanes | Uptime + deploy check |
| 12-29 | Year-end demo day: full walkthrough script recorded | Demo-run rehearsal on :8090 |
| 12-30 | 2026 retro (C) · S: year-of-signal wrapup ships | 2026 retro (T) |
| 12-31 | **January roadmap + day-59 streak commit** | **January train draft + streak commit** |

## Standing risks / dependencies

1. **T train is idle** until November rows are armed (GO needed). Streak broke 11-02.
2. **GitHub API 401** — PAT dead since 10-25; SSH pushes fine. Issue comments /
   milestone sync stay dark until a fresh PAT lands.
3. **Signal-ops X quotes** blocked on owner cookie export.
4. **Gateway credits**: $0.042/Mtok in; a full 90-item comparison run < $0.10.
   Watch the balance mid-November or D14+ comparison pages stall.
5. Every "after D14" C row is roadmap-v2 Track C follow-on; scope stays batch-
   disciplined (5→10→All) with the dev view wired into each new surface.
