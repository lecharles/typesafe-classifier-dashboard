/**
 * UC#5 RAG re-ranker demo corpus — synthetic retrieval passages for one
 * query against a fictional product's documentation. Every passage is
 * invented on purpose; one is deliberately stale so the conflict floor has
 * something to catch.
 */

export type RagPassage = { id: string; text: string };

export const RAG_QUERY = "How do I set up SSO with Okta on the enterprise plan?";

export const ragPassages: RagPassage[] = [
  {
    id: "r01",
    text: "SSO on Enterprise: go to Admin → Identity, choose Okta, and paste your app's metadata URL. SAML and OIDC are both supported.",
  },
  {
    id: "r02",
    text: "Your Okta admin can follow our SSO guide to connect in about 20 minutes. Enterprise only.",
  },
  {
    id: "r03",
    text: "Okta is a third-party identity provider founded in 2009 and known for workforce sign-on across many SaaS products.",
  },
  {
    id: "r04",
    text: "Plans: Free (1 seat), Pro ($19/seat), Enterprise ($49/seat, includes SSO, audit logs, and priority support).",
  },
  {
    id: "r05",
    text: "The per-region sync quota causes nightly failures around 2am UTC. Raise the window to 6 hours under Admin → Sync → Limits.",
  },
  {
    id: "r06",
    text: "To reset your password, open Settings → Account → Password and tap 'Forgot password'. The link expires after 30 minutes.",
  },
  {
    id: "r07",
    text: "[v1.8 docs] Enterprise SSO supports SAML only; OIDC and Okta integrations are not available and are not on the roadmap.",
  },
  {
    id: "r08",
    text: "Adding an Okta app: in Okta create a SAML app, copy the sign-on URL and certificate, then paste both into our Admin → Identity → SAML form.",
  },
  {
    id: "r09",
    text: "Contact support by email or chat; enterprise customers receive priority responses within one business day.",
  },
  {
    id: "r10",
    text: "SSO seats are billed per named user; minimum 10 seats on Enterprise. (See the provisioning page for how users are assigned.)",
  },
  {
    id: "r11",
    text: "Changelog v2.4: OIDC single sign-on added to Enterprise, including Okta and Entra ID as identity providers.",
  },
  {
    id: "r12",
    text: "Failed webhooks are retried up to three times with exponential backoff, then land in the dead-letter view.",
  },
];
