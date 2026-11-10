# C-lane commit train ledger (Typesafe Classifier Dashboard / Jev)

Source rows: docs/ROADMAP-YEAR-END.md column C. Oldest-first, no backdating.

| Row | Slice | Status | Commit | Date (PT) |
|-----|-------|--------|--------|-----------|
| D6  | Confidence-gated routing view on Emails | SHIPPED | 6c27106 | 2026-11-06 |
| D7  | Shared dev view `?dev=1` — per-item raw Jev payloads + retry/fallback | SHIPPED | 1ff4719 | 2026-11-07 |
| D8  | CSV/JSON export all dashboards + localStorage run persistence | SHIPPED | 1ff4719 | 2026-11-08 |
| D4  | Emails click-to-filter (donut/histograms/routing tiles) + raw-payload row drill-over slide-over | SHIPPED | 665b3ec | 2026-11-08 |
| D5  | Playground provider toggle (auto/jev/gateway) + ask-both side-by-side + latency pills | SHIPPED | aaedb91 | 2026-11-08 |

Notes:
- D4/D5 were listed as "docs-only days" but never actually landed — burned as catch-up slices on 11-08 alongside the D7+D8 batch. All November D-rows now SHIPPED; next queued: UC#1 (11-09) tool-call dispatcher scaffold.
- 86 lib/component tests green (28 new: tablefilter 14, slideover 4, compare 10); trace coverage in lib/__tests__/trace.test.ts, export/persist in lib/__tests__/export.test.ts, filter logic in lib/tablefilter.ts, agreement/latency in lib/compare.ts.
| UC#1 | Tool-call dispatcher scaffold (5-function registry, Choice-per-arg) | SHIPPED | 15d21bb | 2026-11-08 |
| UC#1-live | Dispatcher live: batches 5→10→All + confidence-gated execution in code (exec gate 0.85, registry re-check, simulated audit effects) | SHIPPED | a1520c3 | 2026-11-09 |
| UC#2 | Model router dashboard: intent (Choice) + difficulty (Score) + risk (Noul) → cheap/mid/frontier decided in code; gates as sliders; batch 5→10→All; savings-vs-all-frontier costing; /router + /api/router + /api/router-batch, Level-5 home card + nav | SHIPPED | 4b17b3d | 2026-11-10 |

Notes:
- 124 tests green (20 new in lib/__tests__/router.test.ts); tsc clean; :8094 200; router strings confirmed in `.next/static/chunks/app/router/page-*.js`.
- Calendar pull-forward, no swap: the 11-10 row (UC#1-live) was already burned on 11-09, so this run ships the 11-11 row (UC#2) on 11-10. Queue is one day ahead; nothing dark.
- Router decisions are code-side rule ladders (risk floor → frontier; difficulty ladder; code-intent floor; low-confidence bump) — never a free-model write. Errors isolated per batch item.
