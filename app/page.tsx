import Link from "next/link";

const cards = [
  {
    href: "/playground",
    num: "Level 1",
    title: "Playground",
    body: "Paste any text and run Choice / Score / Noul classification live. See the raw gateway request and response.",
  },
  {
    href: "/emails",
    num: "Level 2",
    title: "Email triage",
    body: "Batch-classify a set of support emails into categories, urgency, and priority. Donut, histograms, sortable table.",
  },
  {
    href: "/youtube",
    num: "Level 3",
    title: "YouTube analyzer",
    body: "Classify ~150 videos by topic, clickbait, sentiment, and more. Topic donut, sentiment histogram, gauges, timeline.",
  },
  {
    href: "/dispatch",
    num: "Level 4",
    title: "Tool dispatcher",
    body: "UC#1 scaffold: a 5-function registry where every argument is a Jev Choice. Plan side-effect-free tool calls from any state.",
  },
  {
    href: "/router",
    num: "Level 5",
    title: "Model router",
    body: "UC#2: intent (Choice) + difficulty (Score) + risk (Noul) decide cheap vs frontier model in code, with batch discipline and estimated cost savings.",
  },
  {
    href: "/guardrails",
    num: "Level 6",
    title: "LLM guardrails",
    body: "UC#3: screen messages in and out of any LLM app — category (Choice) + severity (Score) + risk Noul decide pass / review / block in code.",
  },
  {
    href: "/citations",
    num: "Level 7",
    title: "Citation checker",
    body: "UC#4: does the quote support the claim? support (Choice) + specificity (Score) + fabrication Noul decide pass / review / flag in code.",
  },
  {
    href: "/rerank",
    num: "Level 8",
    title: "RAG re-ranker",
    body: "UC#5: relevance (Score) + grounding (Choice) + conflict Noul pick, in code, which retrieved passages reach the answering model — ship / bench / drop with a top-k cut.",
  },
  {
    href: "/harness",
    num: "Level 9",
    title: "Emulated vs Jev harness",
    body: "D14: the same state through the real Jev API and the emulated gateway, side by side — per-question agreement decided in code across the email + YouTube corpora.",
  },
  {
    href: "/memory",
    num: "Level 10",
    title: "Memory curator",
    body: "UC#6 live: which requests/answers are worth remembering? reuse (Score) + durability & PII (Noul) decide keep / review / forget in code — batch ladder 5 → 10 → All, private data never persisted.",
  },
  {
    href: "/bs",
    num: "Level 11",
    title: "Internet BS detector",
    body: "UC#7: email spam + YouTube clickbait unified into ONE pipeline — intensity (Score) + malice & payoff (Noul) decide clean / suspicious / bs in code, batched 5 → 10 → All over the merged 90-item corpus with per-source tallies, plus a ranked worst-first leaderboard exported through the D8 CSV/JSON pipeline.",
  },
  {
    href: "/extract",
    num: "Level 12",
    title: "Date/value extractor",
    body: "UC#8: messy dates and amounts in, canonical values out — CODE detects, validates, and normalizes every token (no Feb 30 ever ships; validator v2 also refuses impossible clock times, bad UTC offsets, mixed-separator typos, and fractional yen), while kind (Choice) + precision (Score) + ambiguity (Noul) decide resolved / guessed / vague / rejected in code, batched 5 → 10 → All over the messy-snippet corpus.",
  },
  {
    href: "/chat",
    num: "Level 13",
    title: "Live chat filter",
    body: "UC#9: Twitch-style chat moderation — insults, spam & spoilers out; toxicity (Score) + promo & spoiler (Noul) decide allow / hold / block in CODE (a friendly-voiced scam link is still spam; a spoiler never passes silently but is hidden, not punished), batched 5 → 10 → All over a 28-message stream scroll with a per-user offender rollup exported through the D8 pipeline, folded batch-to-batch into a repeat-offender strike ledger (watch → timeout → ban decided in code; tempo alone never bans).",
  },
  {
    href: "/entities",
    num: "Level 14",
    title: "Entity alignment / dedup",
    body: "UC#10: are these two marketplace records the same product? similarity (Score) + conflict & generic-name (Noul) decide distinct / review / merge in CODE — merge is the destructive lane: a hard identifier contradiction forces the pair apart, a generic name never merges alone, doubt never enters the join lane; merge edges fold into contradiction-safe clusters (a chain never overrules a called separation), batched 5 → 10 → All over a 25-pair market audit with D8 CSV/JSON export.",
  },
];

export default function Home() {
  return (
    <div>
      <h1>TypeSafe Classifier Dashboard</h1>
      <p className="subtitle">
        Structured classification modeled on typesafe.ai&apos;s Choice / Score / Noul primitives,
        powered by the Vercel AI Gateway.
      </p>
      <div className="home-cards">
        {cards.map((c) => (
          <Link key={c.href} href={c.href} className="card">
            <div className="num">{c.num}</div>
            <h3>{c.title}</h3>
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>{c.body}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
