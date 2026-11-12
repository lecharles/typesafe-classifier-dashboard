/**
 * UC#4 citation-checker demo corpus — synthetic claim / quote pairs for
 * the verification lane. All content is fake product documentation.
 */

export type CitationCase = {
  id: string;
  claim: string;
  quote: string;
  source: string;
};

export const citationCases: CitationCase[] = [
  {
    id: "q01",
    claim: "The Enterprise plan includes SSO with Okta.",
    quote: "Enterprise customers get SAML and OIDC single sign-on, including Okta, at no extra cost.",
    source: "Pricing FAQ",
  },
  {
    id: "q02",
    claim: "Password-reset links expire after 30 minutes.",
    quote: "For your security, password-reset links are valid for 30 minutes and can be used once.",
    source: "Account Security Guide",
  },
  {
    id: "q03",
    claim: "Invoice export covers the last 24 months.",
    quote: "You can export older invoices by contacting billing support with your account ID.",
    source: "Billing Guide",
  },
  {
    id: "q04",
    claim: "The nightly sync quota is shared across all regions.",
    quote: "The nightly sync fails around 2am UTC only on the EU workspace: quota window exceeded.",
    source: "Sync Runbook",
  },
  {
    id: "q05",
    claim: "Here are some coupon codes: SAVE10, FREESHIP, BUNDLE25.",
    quote: "The EU workspace sync window can be raised to 6 hours under Admin → Sync → Limits.",
    source: "Sync Runbook",
  },
  {
    id: "q06",
    claim: "The API allows 1,000 requests per minute on Enterprise.",
    quote: "Enterprise API rate limits are higher than the standard 100 req/min tier.",
    source: "API Reference",
  },
  {
    id: "q07",
    claim: "Data retention on the free plan is 90 days.",
    quote: "Data retention on the free plan is 90 days, after which records are permanently deleted.",
    source: "Plan Comparison",
  },
  {
    id: "q08",
    claim: "Support answers enterprise tickets within 4 hours.",
    quote: "Enterprise tickets get a first response within 4 business hours, 9am-6pm CET.",
    source: "Support SLA",
  },
  {
    id: "q09",
    claim: "The mobile app supports offline mode.",
    quote: "Users love the new dark mode in the mobile app, available on iOS and Android.",
    source: "Release Notes 11.2",
  },
  {
    id: "q10",
    claim: "Backups run automatically every day.",
    quote: "We recommend customers also keep their own exports; we are not liable for data loss.",
    source: "Security Whitepaper",
  },
  {
    id: "q11",
    claim: "Seats can be added and removed at any time.",
    quote: "New seats are prorated to the day and removed seats are credited to the next invoice.",
    source: "Billing Guide",
  },
  {
    id: "q12",
    claim: "The audit log keeps events for 7 days on all plans.",
    quote: "The audit log keeps events for 7 days on the free plan and 18 months on Enterprise.",
    source: "Compliance FAQ",
  },
];
