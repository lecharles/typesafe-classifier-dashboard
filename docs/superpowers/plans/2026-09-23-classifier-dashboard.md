# TypeSafe Classifier Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local Next.js app that runs structured classification (Choice/Score/Noul) through the Vercel AI Gateway and visualizes results across three progressive dashboards.

**Architecture:** Server-side API routes hold the gateway key and call `anthropic/claude-3-haiku`; a small classifier library builds strict-JSON prompts and validates responses with zod; a React + Recharts frontend renders playground, email, and YouTube dashboards.

**Tech Stack:** Next.js (App Router), TypeScript, zod, Recharts, vitest.

## Global Constraints

- Model: `anthropic/claude-3-haiku` (primary), `amazon/nova-micro` (fallback). Overridable via `CLASSIFIER_MODEL`.
- Gateway base URL: `https://ai-gateway.vercel.sh/v1`.
- Secret `AI_GATEWAY_API_KEY` is read **only** in server code; never imported into client components.
- `.env.local` is gitignored; `.env.example` documents required vars.
- Node >= 18.18 (Next.js requirement). Package manager: npm.
- All gateway calls flow through `lib/gateway.ts`; all classification through `lib/classify.ts`.

---

### Task 1: Scaffold Next.js app + tooling

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.mjs`, `.env.example`, `app/layout.tsx`, `app/page.tsx`, `vitest.config.ts`
- Create: `app/globals.css`

**Interfaces:**
- Produces: a runnable Next.js app (`npm run dev`) and a test runner (`npm test`).

- [ ] **Step 1:** `npx create-next-app@latest . --ts --app --no-tailwind --eslint --src-dir=false --import-alias "@/*"` (accept defaults; app in current dir).
- [ ] **Step 2:** Install deps: `npm i zod recharts` and `npm i -D vitest @vitejs/plugin-react jsdom @testing-library/react`.
- [ ] **Step 3:** Add `vitest.config.ts` (jsdom env, react plugin, `@` alias) and `"test": "vitest run"`, `"test:watch": "vitest"` to `package.json` scripts.
- [ ] **Step 4:** Create `.env.example` with `AI_GATEWAY_API_KEY=`, `CLASSIFIER_MODEL=anthropic/claude-3-haiku`, `YOUTUBE_API_KEY=`.
- [ ] **Step 5:** Replace `app/page.tsx` with a simple home linking to `/playground`, `/emails`, `/youtube`.
- [ ] **Step 6:** Run `npm run build` to verify it compiles. Commit: `chore: scaffold Next.js app`.

---

### Task 2: Schemas (`lib/schema.ts`)

**Files:**
- Create: `lib/schema.ts`, `lib/__tests__/schema.test.ts`

**Interfaces:**
- Produces:
  - Types `ChoiceQuestion`, `ScoreQuestion`, `NoulQuestion`, `Question = Choice|Score|Noul` (discriminated on `type`).
  - `ChoiceQuestion = { type:'choice'; instructions:string; criteria: Record<string,string> }`
  - `ScoreQuestion = { type:'score'; instructions:string; criteria: string[] }` (2–10 levels)
  - `NoulQuestion = { type:'noul'; instructions:string; criteria?: {true:string;false:string} }`
  - Answer types + zod validators: `choiceAnswer`, `scoreAnswer`, `noulAnswer`.
  - `answerSchemaFor(q: Question): ZodType` → returns the zod schema for that question's answer.
  - `ClassifyRequest = { state: string; questions: Record<string, Question> }`
  - `ClassifyResult = { answers: Record<string, Answer>; usage: {input_tokens:number; output_tokens:number}; model:string }`

- [ ] **Step 1: Write failing test** — `answerSchemaFor` on a choice question accepts `{type:'choice',choice:'a',probabilities:{a:0.9,b:0.1},confidence:0.9}` and rejects a missing `choice`.
- [ ] **Step 2:** Run `npx vitest run lib/__tests__/schema.test.ts` → FAIL.
- [ ] **Step 3:** Implement the zod schemas and types. Choice answer: `{type:'choice', choice:string, probabilities:record(number), confidence:number(0..1)}`. Score answer: `{type:'score', score:number, probabilities:record(number), confidence:number}`. Noul answer: `{type:'noul', noul:number(0..1)}`.
- [ ] **Step 4:** Run tests → PASS. Commit: `feat: add classification schemas`.

---

### Task 3: Gateway client (`lib/gateway.ts`)

**Files:**
- Create: `lib/gateway.ts`, `lib/__tests__/gateway.test.ts`

**Interfaces:**
- Consumes: `AI_GATEWAY_API_KEY`, `CLASSIFIER_MODEL` env.
- Produces: `async function chat(messages: {role:string;content:string}[], opts?:{model?:string}): Promise<{text:string; usage:{input_tokens:number;output_tokens:number}; model:string}>`. Retries 429/5xx twice with backoff; on final failure with primary model, retries once with fallback `amazon/nova-micro`.

- [ ] **Step 1: Write failing test** — mock `global.fetch`; assert `chat()` posts to the gateway URL with the Bearer header and returns parsed `text`+`usage`. Second test: fetch returns 429 twice then 200 → resolves.
- [ ] **Step 2:** Run test → FAIL.
- [ ] **Step 3:** Implement `chat()` using `fetch` to `${BASE}/chat/completions`, body `{model, messages, max_tokens, temperature:0}`. Parse `choices[0].message.content` and `usage` (map OpenAI `prompt_tokens/completion_tokens` to `input_tokens/output_tokens`). Backoff `await sleep(300*2^n)`.
- [ ] **Step 4:** Run tests → PASS. Commit: `feat: add gateway client with retry+fallback`.

---

### Task 4: Classifier (`lib/classify.ts`)

**Files:**
- Create: `lib/classify.ts`, `lib/__tests__/classify.test.ts`

**Interfaces:**
- Consumes: `chat` (Task 3), schemas (Task 2).
- Produces: `async function classify(req: ClassifyRequest): Promise<ClassifyResult>`. Builds a single prompt describing each question + required JSON output shape; calls `chat`; extracts JSON (strips code fences), validates each answer with `answerSchemaFor`; on parse/validation failure, retries once with a stricter "return ONLY valid JSON" instruction.

- [ ] **Step 1: Write failing test** — mock `chat` to return a fenced JSON blob with a choice + noul answer; assert `classify` returns typed answers and sums usage. Second test: first call returns junk, second returns valid → still resolves (repair path).
- [ ] **Step 2:** Run test → FAIL.
- [ ] **Step 3:** Implement prompt builder (`buildPrompt(req)`), JSON extraction (`extractJson(text)`), validation loop, usage summing.
- [ ] **Step 4:** Run tests → PASS. Commit: `feat: add classifier with JSON repair`.

---

### Task 5: API route (`app/api/classify/route.ts`)

**Files:**
- Create: `app/api/classify/route.ts`

**Interfaces:**
- Consumes: `classify` (Task 4).
- Produces: `POST /api/classify` accepting `ClassifyRequest` JSON → `ClassifyResult` JSON. Validates body with the `ClassifyRequest` zod schema; returns 400 on bad body, 502 with the gateway error message on gateway failure.

- [ ] **Step 1:** Implement route (`export async function POST(req)`). `runtime = 'nodejs'`.
- [ ] **Step 2:** Manual test: `curl -s localhost:3000/api/classify -d '{"state":"I love this","questions":{"sentiment":{"type":"score","instructions":"Rate sentiment","criteria":["negative","neutral","positive"]}}}' -H 'content-type: application/json'` → returns a valid score answer. (Requires `AI_GATEWAY_API_KEY` in `.env.local`.)
- [ ] **Step 3:** Commit: `feat: add /api/classify route`.

---

### Task 6: Chart components (`components/charts/*`)

**Files:**
- Create: `components/charts/Donut.tsx`, `Histogram.tsx`, `Gauge.tsx`, `StatTile.tsx`, `ConfidenceBadge.tsx`

**Interfaces:**
- Produces pure presentational components:
  - `Donut({data:{name:string;value:number}[]})`
  - `Histogram({data:{bin:string;count:number}[], xLabel?, yLabel?})`
  - `Gauge({label:string; value:number /*0..1*/})`
  - `StatTile({label:string; value:string|number})`
  - `ConfidenceBadge({value:number})`

- [ ] **Step 1:** Implement each with Recharts (`PieChart`, `BarChart`, `RadialBarChart`). Follow the dataviz skill for palette/legibility.
- [ ] **Step 2:** Smoke-render test with @testing-library that `Donut` renders given sample data.
- [ ] **Step 3:** Commit: `feat: add chart components`.

---

### Task 7: Bundled datasets (`data/emails.ts`, `data/youtube.ts`)

**Files:**
- Create: `data/emails.ts` (~40 support emails), `data/youtube.ts` (~150 videos), `data/questions.ts` (the question sets)

**Interfaces:**
- Produces: `emails: {id,subject,body}[]`, `videos: {id,title,description,channel,publishedAt}[]`, and question-set constants `EMAIL_QUESTIONS`, `YOUTUBE_QUESTIONS`, `PLAYGROUND_QUESTIONS` typed as `Record<string,Question>`.

- [ ] **Step 1:** Author the datasets (realistic, varied categories). YouTube sample drawn from public trending-style metadata.
- [ ] **Step 2:** Define the three question sets per the spec (email: category Choice, is_urgent Noul, priority Score; youtube: category Choice, clickbait Score, is_promotional Noul, is_news Noul, title_sentiment Score).
- [ ] **Step 3:** Commit: `feat: add bundled datasets and question sets`.

---

### Task 8: Batch classify helper + hook

**Files:**
- Create: `lib/batch.ts`, `app/api/classify-batch/route.ts`

**Interfaces:**
- Produces: `async function classifyBatch(items:{id:string;state:string}[], questions, {concurrency=5}): Promise<{id:string; result?:ClassifyResult; error?:string}[]>`. `POST /api/classify-batch` accepting `{items, questions}` → array of per-item results (errors isolated).

- [ ] **Step 1: Write failing test** — mock `classify`; assert `classifyBatch` respects concurrency and isolates a thrown item as `{error}`.
- [ ] **Step 2:** Run → FAIL. Implement with a simple promise pool. Run → PASS.
- [ ] **Step 3:** Add the route. Commit: `feat: add batch classification`.

---

### Task 9: Level 1 — Playground page (`app/playground/page.tsx`)

**Files:**
- Create: `app/playground/page.tsx`, `components/RawIO.tsx`

**Interfaces:**
- Consumes: `POST /api/classify`, `PLAYGROUND_QUESTIONS`.

- [ ] **Step 1:** Client component: textarea + "Classify" button → POST to `/api/classify`; render answers (choice w/ probabilities bar, score, noul gauge) and a `RawIO` panel showing request + response JSON.
- [ ] **Step 2:** Manual verify in browser. Commit: `feat: add playground dashboard`.

---

### Task 10: Level 2 — Email triage (`app/emails/page.tsx`)

**Files:**
- Create: `app/emails/page.tsx`, `lib/aggregate.ts`, `lib/__tests__/aggregate.test.ts`

**Interfaces:**
- Consumes: `classify-batch`, `emails`, `EMAIL_QUESTIONS`, charts.
- Produces: `aggregate.ts` — `categoryCounts(results)`, `histogram(values, bins)`, `avgConfidence(results)`.

- [ ] **Step 1: Write failing test** for `categoryCounts` and `histogram`. Run → FAIL → implement → PASS.
- [ ] **Step 2:** Page: "Classify all" button runs the batch with a progress bar; render StatTiles (total, tokens, avg confidence), category Donut, urgency Histogram, confidence Histogram, and a sortable table.
- [ ] **Step 3:** Manual verify. Commit: `feat: add email triage dashboard`.

---

### Task 11: Level 3 — YouTube analyzer (`app/youtube/page.tsx`)

**Files:**
- Create: `app/youtube/page.tsx`, `lib/youtube.ts` (optional live fetch)

**Interfaces:**
- Consumes: `classify-batch`, `videos`, `YOUTUBE_QUESTIONS`, charts, `aggregate.ts`.
- Produces: `lib/youtube.ts` — `fetchVideos({channelId?|query?}): Promise<Video[]>` used only when `YOUTUBE_API_KEY` set; falls back to bundled `videos`.

- [ ] **Step 1:** Page: source toggle (bundled / live-if-key), "Analyze" runs batch; render topic Donut, sentiment Histogram, Gauges (%promotional/%news/%clickbaity), publish-date bar, and a browsable table.
- [ ] **Step 2:** Implement `lib/youtube.ts` live fetch guarded by env; if no key, return bundled.
- [ ] **Step 3:** Manual verify. Commit: `feat: add YouTube analyzer dashboard`.

---

### Task 12: Polish, README, verify, push to GitHub

**Files:**
- Create: `README.md`

**Interfaces:** none.

- [ ] **Step 1:** README: what it is, setup (`cp .env.example .env.local`, add key, `npm run dev`), the three dashboards, how to enable live YouTube.
- [ ] **Step 2:** Run `npm run build` and `npm test` → all pass. Exercise all three dashboards in the browser (use the /verify skill).
- [ ] **Step 3:** `gh repo create` + push. Confirm `.env.local` is NOT in the repo (`git ls-files | grep env` shows only `.env.example`).
- [ ] **Step 4:** Commit: `docs: add README`.

---

## Self-Review

**Spec coverage:** primitives (T2), gateway w/ fallback & free-tier model (T3), classifier w/ repair (T4), API (T5), charts (T6), datasets incl. YouTube (T7), batch w/ concurrency & error isolation (T8), three dashboards (T9–11), error handling (T3/T4/T5), testing (unit tests in T2/T3/T4/T8/T10), GitHub push + secret hygiene (T12). All spec sections covered.

**Placeholders:** none — each task has concrete files, interfaces, and commands.

**Type consistency:** `ClassifyRequest`/`ClassifyResult`/`Question`/`Answer` defined in T2 and reused verbatim in T3–T11; `classify`, `chat`, `classifyBatch`, `aggregate` signatures consistent across consumers.
