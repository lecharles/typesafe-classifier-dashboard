import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "TypeSafe Classifier Dashboard",
  description: "Structured classification (Choice / Score / Noul) via the Vercel AI Gateway",
};

const nav = [
  { href: "/playground", label: "Playground" },
  { href: "/emails", label: "Email triage" },
  { href: "/youtube", label: "YouTube analyzer" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <Link href="/" className="brand">◆ TypeSafe Classifier</Link>
          <nav>
            {nav.map((n) => (
              <Link key={n.href} href={n.href}>{n.label}</Link>
            ))}
          </nav>
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
