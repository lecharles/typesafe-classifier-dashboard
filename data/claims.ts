/**
 * UC#4 citation-checker demo corpus — synthetic claim/quote pairs written
 * against a fictional product's documentation. Every claim and quote here
 * is invented on purpose so a broken citation can be shipped safely.
 */

export type ClaimCase = { id: string; claim: string; quote: string };

export const claimCases: ClaimCase[] = [
  {
    id: "k01",
    claim: "The Enterprise plan includes SSO with Okta.",
    quote: "Enterprise supports SAML and OIDC single sign-on, including Okta.",
  },
  {
    id: "k02",
    claim: "Password-reset links expire after 30 minutes.",
    quote: "The reset link is valid for 30 minutes.",
  },
  {
    id: "k03",
    claim: "CSV export covers the last 24 months of invoices.",
    quote: "Exports are available in CSV and JSON formats.",
  },
  {
    id: "k04",
    claim: "The nightly EU sync failure is caused by the per-region quota.",
    quote: "That's the per-region sync quota. Raise the window to 6 hours under Admin → Sync → Limits.",
  },
  {
    id: "k05",
    claim: "The Free plan allows two seats.",
    quote: "Free plan includes 1 seat and paid plans start at $19 per seat.",
  },
  {
    id: "k06",
    claim: "Okta admin setup takes about 20 minutes.",
    quote: "Your Okta admin can follow our SSO guide to connect in about 20 minutes.",
  },
  {
    id: "k07",
    claim: "The company reported strong funding news this quarter.",
    quote: "Click here to buy discount watches at 90% off, limited stock!",
  },
  {
    id: "k08",
    claim: "Failed webhooks are retried up to three times.",
    quote: "Webhooks are retried.",
  },
  {
    id: "k09",
    claim: "The Usage dashboard tracks cost per workspace.",
    quote: "We are thrilled to announce our brand-new dashboard experience!",
  },
  {
    id: "k10",
    claim: "The API allows 1,000 requests per minute per token.",
    quote: "1,000 requests per minute are allowed per token.",
  },
  {
    id: "k11",
    claim: "Support created ticket OPS-2214 for the sync issue.",
    quote: "That's the per-region sync quota. I created ticket OPS-2214 with logs attached.",
  },
  {
    id: "k12",
    claim: "Engagement grows by posting consistently and replying honestly.",
    quote: "Engagement tips: post consistently, reply to comments, run honest giveaways.",
  },
];
