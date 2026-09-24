# TypeSafe Classifier Dashboard

A local Next.js app that runs **structured text classification** through the
[Vercel AI Gateway](https://vercel.com/docs/ai-gateway), modeled on
[typesafe.ai](https://docs.typesafe.ai/introduction)'s three primitives:

| Primitive | Meaning | Returns |
|-----------|---------|---------|
| **Choice** | pick one option from a set | choice + per-option probabilities + confidence |
| **Score** | rate on an ordered rubric (2–10 levels) | level + probabilities + confidence |
| **Noul** | yes/no | probability of "yes" (0–1) |

> Note: typesafe.ai / Jev has its own separate API and key. This project **emulates**
> those primitives using a general model via the Vercel AI Gateway, so it works with a
> standard `vck_...` gateway key.

## Three dashboards (crescendo)

1. **Playground** (`/playground`) — classify any text live and inspect the raw gateway request/response.
2. **Email triage** (`/emails`) — batch-classify 40 support emails into category, urgency, and priority. Donut, histograms, sortable table.
3. **YouTube analyzer** (`/youtube`) — classify ~50 videos by topic, clickbait, sentiment, promotional/news. Topic donut, sentiment & clickbait histograms, gauges, timeline, table.

## Setup

```bash
cp .env.example .env.local
# edit .env.local and paste your Vercel AI Gateway key into AI_GATEWAY_API_KEY
npm install
npm run dev            # http://localhost:3000
```

### Environment variables

| Var | Required | Purpose |
|-----|----------|---------|
| `AI_GATEWAY_API_KEY` | yes | Your Vercel AI Gateway key (`vck_...`). |
| `CLASSIFIER_MODEL` | no | Model id. Default `anthropic/claude-3-haiku` (free-tier friendly). |
| `YOUTUBE_API_KEY` | no | Enables the live YouTube Data API v3 path in the analyzer. Without it, the bundled sample is used. |

> The gateway free tier can't access premium models (e.g. `claude-haiku-4.5`). The
> default `anthropic/claude-3-haiku` works; `amazon/nova-micro` is used as a fallback.

## Architecture

```
Browser (React + Recharts)
  → /api/classify or /api/classify-batch   (server-only; holds the key)
    → lib/classify.ts  (strict JSON prompt, zod validation + repair retry)
      → lib/gateway.ts (retry on 429/5xx, model fallback)
        → Vercel AI Gateway → anthropic/claude-3-haiku
```

- `lib/schema.ts` — zod schemas + types for questions and answers.
- `lib/gateway.ts` — gateway client with retry and model fallback.
- `lib/classify.ts` — prompt building, JSON extraction, validation, one repair retry.
- `lib/batch.ts` — bounded-concurrency batch with per-item error isolation.
- `lib/aggregate.ts` — chart aggregations (counts, histograms, confidence, tokens).
- `data/` — bundled datasets and the Choice/Score/Noul question sets.
- `components/charts/` — Recharts wrappers.
- `app/` — dashboards and API routes.

## Testing

```bash
npm test        # 21 unit tests (schema, gateway, classify, batch, aggregate, charts)
npm run build   # typecheck + production build
```

## Deploy

Deployable to Vercel unchanged. Set the same env vars in the project settings.
