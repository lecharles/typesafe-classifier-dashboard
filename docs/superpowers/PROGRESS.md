# Progress / Handoff — TypeSafe Classifier Dashboard

**Last updated:** 2026-09-23

## What this project is
Local Next.js app doing structured classification (Choice/Score/Noul, emulating
typesafe.ai's primitives) via the **Vercel AI Gateway**. Three dashboards:
Playground, Email triage, YouTube analyzer.

- Spec: `docs/superpowers/specs/2026-09-23-classifier-dashboard-design.md`
- Plan: `docs/superpowers/plans/2026-09-23-classifier-dashboard.md` (task checkboxes)

## Key facts (already resolved — don't re-investigate)
- typesafe.ai needs its OWN key; the user only has a Vercel AI Gateway key (`vck_...`)
  which returns 401 against typesafe.ai. So we EMULATE the primitives via the gateway.
- Gateway works after a credit card was added. **Free tier CANNOT use premium models**
  (claude-haiku-4.5 → 403). Working models: `anthropic/claude-3-haiku` (primary, clean
  JSON), `amazon/nova-micro` / `amazon/nova-lite` (fallbacks).
- Key lives in `.env.local` (gitignored). `.env.example` documents vars.

## Done ✅
- [x] Task 1: Scaffold (package.json, tsconfig, next.config, vitest, app shell). Deps installed. Next bumped to 14.2.35 (security).
- [x] Task 2: `lib/schema.ts` (zod Choice/Score/Noul + request/result types)
- [x] Task 3: `lib/gateway.ts` (retry on 429/5xx + fallback model)
- [x] Task 4: `lib/classify.ts` (prompt build, JSON extract, validate + 1 repair retry)
- [x] Task 5: `app/api/classify/route.ts` (POST endpoint)
- 10 unit tests passing (`npm test`).

## Done ✅ (continued)
- [x] Task 6: Chart components (Donut, Histogram, Gauge, StatTile, ConfidenceBadge, palette)
- [x] Task 7: Bundled datasets — `data/emails.ts` (40), `data/youtube.ts` (50), `data/questions.ts`
- [x] Task 8: `lib/batch.ts` + `app/api/classify-batch/route.ts` (concurrency 5, error isolation) + `lib/aggregate.ts`
- [x] Task 9: `app/playground/page.tsx` (Level 1) with raw request/response viewer
- [x] Task 10: `app/emails/page.tsx` (Level 2)
- [x] Task 11: `app/youtube/page.tsx` + `lib/youtube.ts` optional live fetch (Level 3)
- [x] Task 12: README, verified end-to-end (all pages 200, live gateway calls work), pushed to GitHub

**Status: COMPLETE.** 21 unit tests pass, `npm run build` clean, all three dashboards verified
against the live gateway (`anthropic/claude-3-haiku`). Dev server: `npm run dev`.

## Follow-ups / ideas
- Rotate the gateway key (was pasted in chat).
- Optional: persist batch results (currently session-memory only).
- Optional: wire a real `YOUTUBE_API_KEY` for live video pulls.

## How to run
```bash
cp .env.example .env.local   # then paste the gateway key (already done locally)
npm install
npm run dev                  # http://localhost:3000
npm test                    # unit tests
```

---

## Lane update — real Jev swap (2026-11-02, Hermes lane)

**Goal:** replace the emulated primitives with the real TypeSafe/Jev API and keep
a comparison path. Daily commits from this lane; plan in docs/ROADMAP.md.

Done today (Day 1):
- `lib/jev.ts`: real System One client — `POST /v1/systemone`, Bearer `TYPESAFE_API_KEY`,
  retry on 429/529/5xx + connection errors honoring `Retry-After` (cap 65s), non-retryable
  400/401/413/415/422 surface readable `detail` (incl. 422 field paths). `GET /v1/models`
  helper (`listModels`).
- Provider abstraction: `classify(req, { provider })`, `defaultProvider()` from env
  (`CLASSIFIER_PROVIDER`, else `jev` if key present, else `gateway`). Per-request override
  via `"provider"` in `/api/classify` and `/api/classify-batch` bodies. Batch passes it
  through; every `ClassifyResult` now carries `provider`.
- Key win: the Jev path answers **all questions in one request** (the emulation needed a
  prompt per state); gateway path untouched as fallback and for comparison runs.
- `app/api/models/route.ts` for live connectivity checks. `.env.example` documents the new vars.
- Tests: 9 new in `lib/__tests__/jev.test.ts` (30 total pass). `tsc --noEmit` clean, `next build` clean.

Blocked on: a `TYPESAFE_API_KEY` (console.typesafe.ai/keys). It will be installed in
`.env.local` on the VPS — never committed. Until then the deployed site falls back to
gateway mode and returns a clear 401 message.

Next (Day 2): live smoke vs real API once the key lands + provider toggle + raw-IO view;
(Day 3) VPS deploy behind a public port + minisite index link; (Day 4) emulated-vs-Jev
comparison harness on the bundled email/YouTube sets.

## Route discovery (2026-11-02, later same day)

The Vercel AI Gateway hosts a **TypeSafe-compatible surface**:
`https://ai-gateway.vercel.sh/typesafe/v1/systemone` (+ `/typesafe/v1/models`),
auth = the same `vck_` AI Gateway key, model ids `typesafe-ai/jev`,
`typesafe-ai/jev-1.13.0`, `typesafe-ai/jev-1.14.0`.
=> Carlos's existing Vercel gateway key is enough for REAL Jev; no separate
console.typesafe.ai account needed. lib/jev.ts now supports both routes
(TYPESAFE_API_BASE + key fallback), gateway route selected by default once the
vck key is in ~/secrets/classifier.env. One key then powers BOTH providers
(real jev + emulated claude), which makes the comparison harness trivial.

## LIVE MILESTONE — real Jev answering through the VPS (2026-11-03 00:44 UTC)

Carlos topped up Vercel AI Gateway credits (the $20 key budget was just a cap, not a
balance; the team had to move off free tier — Jev is a paid-tier model). The vck_ key now
serves real Jev with zero code changes:
- Default provider flipped to `jev` automatically (gateway route + credits present).
- Single classify live: payment-failed email -> billing (0.99/0.98 conf), urgency score
  2.99/3 (0.99), angry noul 0.9, 409 in / 71 out tokens, model "jev".
- Batch (4 emails x 2 questions, concurrency 4) live in 0.386s, all correct.
- Emulated fallback STILL selectable (provider=gateway -> amazon/nova-micro), and both
  backends agree ("technical" on the outage email) => comparison harness is unblocked.
- All pages 200 locally and at http://76.13.122.86:8094/.

Cost note: Jev ~$0.042/1M input tokens; the full 90-item comparison run is well under $1.

NEXT (was Day 3, now the live focus): comparison harness — run all 40 emails + 50 YouTube
titles through BOTH providers; capture label agreement, confidence delta, latency, tokens,
cost. Then UI toggle + fractional-score fidelity.
