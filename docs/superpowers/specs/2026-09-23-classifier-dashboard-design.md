# TypeSafe Classifier Dashboard — Design

**Date:** 2026-09-23
**Author:** Carlos Lozano (with Claude)
**Status:** Approved for implementation

## 1. Summary

A local Next.js web app that performs **structured text classification** through the
**Vercel AI Gateway**, deliberately modeled on the three
[typesafe.ai](https://docs.typesafe.ai/introduction) primitives so it mirrors that
product's mental model without depending on its (separate, unavailable) API.

The app presents three progressively richer dashboards ("crescendo") so the user can
watch the gateway API being exercised on real-looking data and see the results told as
a visual story (donuts, histograms, gauges, tables).

## 2. Background & Constraints (discovered during brainstorming)

- **typesafe.ai / Jev** is a structured-decision API (primitives: Choice, Score, Noul).
  It requires its **own** `TYPESAFE_API_KEY`. The user only has a Vercel AI Gateway key.
  A live test confirmed the gateway key returns **401** against typesafe.ai — they are
  separate systems. We therefore *emulate* the primitives via a general model.
- **Vercel AI Gateway** key (`vck_...`) is valid. After the user added a credit card,
  the gateway serves requests. **Free-tier credits cannot access premium models**
  (e.g. `claude-haiku-4.5` → 403 RestrictedModelsError), but these work today:
  `anthropic/claude-3-haiku` (clean instruction-following — **primary**),
  `amazon/nova-micro`, `amazon/nova-lite` (**fallbacks**).
- **Live social data is hard.** X/Twitter needs paid API access; scraping is
  unreliable/ToS-violating. Decision: use **YouTube video metadata**, defaulting to a
  **bundled sample dataset** with an **optional** live YouTube Data API v3 path.

## 3. Core Concepts

"State" (typesafe terminology) = the text under evaluation (email body, or a YouTube
video's title + description). Each classification request sends the state plus a set of
typed questions and returns validated structured answers.

| Primitive | Meaning | Answer shape |
|-----------|---------|--------------|
| **Choice** | pick one option from a defined set | `{ choice, probabilities: {opt: p}, confidence }` |
| **Score**  | rate against an ordered rubric (2–10 levels) | `{ score, probabilities: {level: p}, confidence }` |
| **Noul**   | yes/no → probability of "yes" | `{ noul: 0..1 }` |

Questions are **atomic and independent** (per typesafe's philosophy): each dashboard
composes several small questions rather than asking one big one.

## 4. Architecture

```
Browser (React + Recharts)
   │  fetch /api/classify  (POST: { state, questions })
   ▼
Next.js API route (server-only; holds the gateway key)
   │  builds a strict JSON-schema prompt, calls the gateway
   ▼
Vercel AI Gateway  →  anthropic/claude-3-haiku  (fallback: amazon/nova-micro)
   │  returns text
   ▼
zod validation + repair/retry  →  typed Answer objects  →  JSON to browser
```

### Units (each independently testable)

- **`lib/gateway.ts`** — thin gateway client. Input: model + messages. Output: raw text.
  Handles auth header, base URL, timeout, 429/5xx retry with backoff, model fallback.
  Depends on: `AI_GATEWAY_API_KEY` env var only.
- **`lib/classify.ts`** — the classifier. Input: `{ state, questions }` where questions
  are Choice/Score/Noul specs. Builds the prompt, calls `gateway.ts`, parses + validates
  with **zod**, retries once on invalid JSON. Output: typed `answers`. Provider-agnostic.
- **`lib/schema.ts`** — zod schemas + TS types for questions and answers (single source
  of truth shared by server and client).
- **`app/api/classify/route.ts`** — HTTP boundary; validates request, calls `classify.ts`.
- **`data/emails.ts`**, **`data/youtube.ts`** — bundled sample datasets (typed).
- **`lib/youtube.ts`** — optional live fetch via YouTube Data API v3 (used only if
  `YOUTUBE_API_KEY` is set); returns the same shape as the bundled data.
- **`components/charts/*`** — presentational Recharts wrappers (Donut, Histogram, Gauge,
  ConfidenceBar). Pure: props in, SVG out.
- **`app/(dashboards)/*`** — the three pages below.

### Config / secrets

`.env.local` (gitignored): `AI_GATEWAY_API_KEY`, optional `YOUTUBE_API_KEY`,
optional `CLASSIFIER_MODEL` (default `anthropic/claude-3-haiku`). Key never reaches the
browser — all gateway calls happen in API routes.

## 5. The three dashboards (crescendo)

### Level 1 — Playground (`/playground`)
Paste arbitrary text → run a default question set (topic Choice, sentiment Score,
is-urgent Noul) live. Shows the answers *and* a raw request/response panel so the API is
visible. Purpose: prove the pipeline end-to-end.

### Level 2 — Email triage (`/emails`)
Bundled ~40 support emails across categories (billing, bug, feature request, complaint,
praise, other). Batch-classify (Choice=category, Noul=is_urgent, Score=priority 1–5).
Viz: **donut** of category mix, **histogram** of urgency probability, **histogram** of
confidence, sortable **table** of every email + labels. "Classify all" button runs the
batch live with a progress indicator; results cached in memory for the session.

### Level 3 — YouTube analyzer (`/youtube`)  *(showpiece)*
~150 bundled videos (title + description + channel), optional live fetch by channel/query
if `YOUTUBE_API_KEY` is set. Questions: content category (Choice), clickbait level
(Score 0–4), is_promotional (Noul), is_news (Noul), title sentiment (Score).
Viz: topic **donut**, sentiment **histogram**, **gauges** for %promotional / %news /
%clickbaity, a **timeline/bar** by publish date, and a browsable **table**.

Shared "story" header on each dashboard: total items, total tokens used, avg confidence.

## 6. Data flow & performance

- Batch classification fans out with a small concurrency limit (e.g. 5) to respect rate
  limits; per-item failures are isolated (item marked "error", batch continues).
- Token usage is summed from gateway responses and surfaced in the UI (ties back to the
  user's "see the API being used" goal).
- Datasets are bundled as typed TS modules so the app runs with **zero external calls**
  besides the gateway; live YouTube fetching is strictly opt-in.

## 7. Error handling

- Missing/invalid `AI_GATEWAY_API_KEY` → clear server error surfaced in the UI banner.
- Gateway 402/403 (credits/model access) → surfaced verbatim with a hint to top up.
- Gateway 429/5xx → exponential backoff (2 retries), then model fallback, then error.
- Invalid JSON from model → one repair retry with a stricter instruction, then mark the
  item as failed without crashing the batch.
- Zod validation guarantees the browser only ever receives well-typed answers.

## 8. Testing

- Unit: `classify.ts` prompt-building + zod parsing (including malformed-JSON repair) with
  a mocked `gateway.ts`. `gateway.ts` retry/fallback logic with a mocked fetch.
- Integration: one real gateway smoke test against `anthropic/claude-3-haiku` (skipped if
  no key) asserting a valid Choice answer.
- Manual verification: run `npm run dev`, exercise all three dashboards, confirm charts
  render and token counts increment.

## 9. Out of scope (YAGNI)

- No auth/multi-user, no database (session-memory caching only).
- No real typesafe.ai integration (separate key; explicitly emulated instead).
- No live X/Twitter. YouTube live fetch is optional, not required for the demo.

## 10. Delivery

- Runs locally via `npm run dev`.
- Final step: commit and **push to GitHub** (`.env.local` gitignored; a `.env.example`
  documents required vars). Deployable to Vercel unchanged.

## 11. Chosen defaults (decisions locked)

- Model: `anthropic/claude-3-haiku` (primary), `amazon/nova-micro` (fallback).
- Stack: Next.js (App Router) + TypeScript + Recharts + zod.
- Datasets: bundled email (~40) and YouTube (~150) samples; YouTube live fetch optional.
