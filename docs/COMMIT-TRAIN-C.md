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
