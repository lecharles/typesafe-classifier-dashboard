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
