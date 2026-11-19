/**
 * UC#8 date/value extraction LIVE demo corpus — synthetic messy snippets
 * (tickets, notes, chats) stuffed with human date and amount forms.
 * Everything is invented on purpose. The corpus deliberately contains:
 * ISO + numeric + month-name dates, ambiguous orders (both components
 * ≤ 12), impossible calendar dates the code validator must refuse,
 * leap-year traps (2026 is NOT a leap year, 2028 is), relative
 * expressions that need an anchor, and money in symbols, codes, and
 * magnitude shorthand — so every rung of the extraction ladder fires.
 * Validator v2 (11-20 row) adds the deepened traps: the end-of-day
 * 24:00 notation, a sub-cent bond figure, fractional yen, and a
 * mixed-separator date typo — each DETECTED so the refusal is visible.
 */

export type ExtractionSnippet = {
  id: string;
  text: string;
};

export const extractionCorpus: ExtractionSnippet[] = [
  {
    id: "x01",
    text: "Ship the patch by 11/20/2026 please — the infra budget line is $1,200.50.",
  },
  {
    id: "x02",
    text: "Payroll closes 2026-02-30 (yes, the form let me type it); net transfer € 45,300.00.",
  },
  {
    id: "x03",
    text: "We sign the renewal 03/04/2026 at 09:00; the deposit is $5k.",
  },
  {
    id: "x04",
    text: "Kickoff tomorrow, catering quoted at $200 flat.",
  },
  {
    id: "x05",
    text: "Invoice dated 12/25/2025, total ¥1,000,000 due on receipt.",
  },
  {
    id: "x06",
    text: "Renewal in 30 days; new term starts 2027-01-05T00:00:00Z, fee $1,299.99.",
  },
  {
    id: "x07",
    text: "Deliver next Friday; GBP 250 deposit already received.",
  },
  {
    id: "x08",
    text: "Records sealed as of 31/12/2026; storage overage billed 512 GB monthly.",
  },
  {
    id: "x09",
    text: "Lunch soon, the card terminal flashed an error and nothing was charged.",
  },
  {
    id: "x10",
    text: "Event on February 30, 2026 at 7pm — tickets $89 each, refundable.",
  },
  {
    id: "x11",
    text: "Backorder ETA 2026-09-14; partial refund of $75.50 issued today.",
  },
  {
    id: "x12",
    text: "Quote valid until Nov 3 2026; bundle price €3m for the full rollout.",
  },
  {
    id: "x13",
    text: "Party sometime next month — cake costs $15.99.",
  },
  {
    id: "x14",
    text: "Form due 07/01/26; filing fee $300.00, late penalty $45.",
  },
  {
    id: "x15",
    text: "Leap-day sync scheduled 2028-02-29; migration credit $100 applied.",
  },
  {
    id: "x16",
    text: "Wrap the venue by 2026-11-20T24:00; the cleanup bond of $250.499 clears at signing.",
  },
  {
    id: "x17",
    text: "Per-unit pricing ¥1.5 was voided on arrival; the old ticket 11/20-2026 was reprinted as 11/21/2026.",
  },
];
