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
