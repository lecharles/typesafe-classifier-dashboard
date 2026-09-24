# Roadmap

The current app is a working demo: three dashboards running structured classification
(Choice / Score / Noul) through the Vercel AI Gateway, on bundled sample data. Below is
where it could go next, roughly in priority order.

## Near term

- **Real datasets.** Import public corpora (Enron emails, SMS/SpamAssassin spam) and add
  CSV/JSON upload so any email or text set can be classified.
- **Paste-in mode.** A "bring your own text" box on the data dashboards, like the Playground.
- **Result export.** Download batch results as CSV/JSON, including probabilities and confidence.
- **Live streaming progress.** Stream per-item results as the batch runs instead of waiting
  for the whole batch to finish.

## Medium term

- **Multi-model comparison.** Run the same classification across several gateway models
  (e.g. `claude-3-haiku`, `nova-micro`, a Qwen model) and compare labels, confidence, and
  agreement side by side.
- **Provider abstraction → real typesafe.ai.** Swap the gateway classifier for typesafe.ai's
  Jev when a key is available, and compare the emulated primitives against the real ones.
- **Persistence.** Save runs to a local SQLite database with history, so dashboards survive
  reloads and runs can be compared over time.
- **Live YouTube + more sources.** Wire the YouTube Data API path end to end, and add other
  sources (RSS feeds, news APIs).

## Longer term

- **Confidence calibration view.** Plot predicted confidence against agreement across models
  to see how well-calibrated the classifier is.
- **Cost & usage dashboard.** Track token spend per run and over time.
- **Auth & per-user data.** Sign-in with per-user ownership of saved runs.
- **One-click deploy.** A Vercel deploy template with env vars pre-wired.
- **In-app explainers.** Short guides on the Choice/Score/Noul model, confidence, and prompt
  design, in the spirit of teaching the structured-classification approach.

## Non-goals (for now)

- No training or fine-tuning — this app is about *inference-time* structured classification.
- No scraping of sites that forbid it; live data comes only from official APIs.
