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
