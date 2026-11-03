# Roadmap v2 — Jev Expertise Hub (from 2026-11-03)

Status: **real Jev live** on http://76.13.122.86:8094/ via the AI Gateway `typesafe`
surface (vck_ key + paid credits). Emulated Claude path remains selectable
(`provider=gateway`) for comparison. This roadmap supersedes the "swap" plan, which is done.

Three tracks run concurrently, one visible commit minimum per day:

- **A. Experience** — audit and upgrade every dashboard's interactivity.
- **B. Dev views** — see the full Jev payload behind every screen, not just Playground.
- **C. Use-case gallery** — grow the app into the go-to place for Jev expertise, one
  real use case at a time, in batches of 5–10 items each, like emails/YouTube.

---

## Track A — dashboard-by-dashboard feature audit (code-verified)

### Playground (/playground)
**Today:** free-text box, 3 samples, single classify, model + token pills, answer cards
(Choice/Score/Noul), raw request/response viewer (RawIO). Default provider is now real Jev.
**Gaps → upgrades:**
- [ ] Provider toggle (Real Jev / Emulated) + side-by-side "ask both" mode.
- [ ] Editable question builder (add/remove Choice/Score/Noul without code).
- [ ] History of runs within the session (persist answers across refresh — localStorage).
- [ ] Latency readout per call (Jev is ~150 ms; worth showing).

### Email triage (/emails)
**Today:** limit selector (10…All 40), Classify button, donut (categories), histograms
(urgency/priority), stat tiles, gauge (avg confidence), table sortable by
subject/category/priority/urgent/confidence.
**Gaps → upgrades:**
- [ ] Click a stat/donut slice/histogram bar → filters the table to that bucket.
- [ ] Click a table row → slide-over with full email text + raw Jev payload for that item.
- [ ] Confidence-gated routing view: auto-handle vs needs-human split (Jev-native pattern)
      with adjustable threshold sliders that re-segment instantly.
- [ ] CSV/JSON export of results incl. probabilities.
- [ ] Paste-in mode (bring your own emails) like Playground.

### YouTube analyzer (/youtube)
**Today:** limit selector, Analyze button, topic donut, sentiment & clickbait histograms,
gauges, timeline, stats. **Table is NOT sortable** and nothing is clickable.
**Gaps → upgrades:**
- [ ] Table sorting (parity with emails) + row click → full raw payload + explanation.
- [ ] Click "N clickbait" stat or clickbait histogram bar → list only those videos
      (the exact ask: every number becomes a filter).
- [ ] Per-video BS score badge in a dedicated ranked "Most clickbait" list.
- [ ] Export + paste-in titles.

### Cross-app
- [ ] Shared dev view: a `?dev=1` mode or per-page toggle showing the real
      `/v1/systemone` request + response for every batch item (not just Playground).
- [ ] All stats/tables/charts fed from the same filter state (chart→table→detail drill path).

## Track B — developer views

Every dashboard gets the Playground's raw-payload treatment: exact Jev request (model,
state, questions) and exact answer JSON per item, token usage, retry/fallback events
visible. This is how the app teaches Jev — it already lives in `components/RawIO.tsx`
and just needs to be wired into batch rows and drill-overs.

## Track C — use-case gallery (researched from docs.typesafe.ai + ecosystem)

Pattern: each use case = a mini-dashboard like emails/YouTube: dataset, typed questions,
batch classify (5–10 items), charts, dev view. Sources: TypeSafe cookbooks & use-case map.

Priority order (agentic first, as agreed):
1. **Tool-call dispatcher (agentic flagship)** — natural-language request → function name +
   closed-set arguments as Choice questions with confidence (trading-API cookbook pattern:
   `plot_price(symbol='AAPL', resolution='1d')` @ 0.75). Shows Jev as the decision layer of an agent.
2. **Model router** — classify intent/difficulty/risk → route to cheap vs frontier model.
3. **LLM guardrails** — screen messages in/out of any LLM app (pass/review/block by threshold).
4. **Citation checker** — does the quote support the claim? (Choice) — verification lane.
5. **RAG passage re-ranker** — score retrieved passages, pick what reaches the answering model.
6. **Memory curator** — which requests/answers are worth remembering (Noul + Score).
7. **Spam/BS unified** — merge email spam + YouTube clickbait into one "internet BS detector".
8. **Date/value extraction** — normalize messy dates or amounts, validate in code.
9. **Twitch-style chat filter** — insults/spam/spoilers with per-message batched questions.
10. **Entity alignment / dedup** — are these two records the same product? (Score + Nouls).
Later: hierarchical classification (beam search over Choice probabilities), skill
suggestion for agent catalogs, Intelliprompter (live transcript tick-off), Box questions
(images, danger-zone header).

Each gallery item keeps the batch discipline: 5 items first, then 10, then All.

## Cadence (daily commits, ~14 days to current scope)

| Day | Deliverable |
|-----|-------------|
| D3  | Track A start: chart→table filtering on YouTube (clickbait stat/Bar → filtered list) + sortable table |
| D4  | Same filtering + row drill-over (raw payload slide-over) on Emails |
| D5  | Playground provider toggle + "ask both" side-by-side; latency pills |
| D6  | Confidence-gated routing view on Emails (threshold sliders, auto vs human) |
| D7  | Shared dev view (`?dev=1`) incl. per-item raw Jev payloads + retry/fallback events |
| D8  | CSV/JSON export (all dashboards) + localStorage run persistence |
| D9  | Use-case #1 scaffold: tool-call dispatcher page (registry of 5 functions, Choice-per-arg) |
| D10 | Dispatcher live with batches (5→10), confidence-gated execution in code |
| D11 | Use-case #2: model router dashboard |
| D12 | Use-case #3: guardrails screen-in/screen-out |
| D13 | Use-case #4–5: citation checker + RAG re-ranker |
| D14 | Comparison harness wrap-up: emulated-vs-Jev agreement page across all datasets |

After D14 we re-plan from the use-case list (items 6–10) and stretch goals
(persistence/SQLite, real corpora upload, calibration view, one-click deploy).

## Non-goals (unchanged)
No fine-tuning; no scraping (official APIs only); no auth yet. Key handling: secrets stay
in ~/secrets/classifier.env on the VPS, never in git.
