import { classify } from "@/lib/classify";
import { BATCH_LADDER } from "@/lib/dispatch";
import type { ClassifyResult, Provider, Question, Usage } from "@/lib/schema";

/**
 * UC#8 (11-19 on the calendar, shipped 11-18 one day ahead): date/value
 * extraction. ROADMAP-V2 Track C item 8 — "normalize messy dates or
 * amounts, validate in code".
 *
 * The extraction pipeline is the most code-heavy use case in the lane:
 * CODE detects candidate tokens (dates and amounts in their messy human
 * forms), CODE validates them against the real calendar and real
 * numbers, and CODE normalizes them to a canonical output. The
 * classifier only answers three typed questions per candidate:
 *
 *   kind       → Choice  date / money / other — is this token really
 *                         the kind of value the grammar thinks it is?
 *   precision  → Score   vague-relative … exact-with-tz — how sharp is
 *                         the value as written?
 *   ambiguous  → Noul    probability the token admits more than one
 *                         plausible reading (day/month order, currency,
 *                         magnitude shorthand, unstated reference date)
 *
 * and CODE — never the free model — decides resolved / guessed / vague /
 * rejected. Rule order mirrors the memory/guardrails ladders:
 * validate-in-code floor (absolute — a Feb 30 never ships a value
 * however confident the reader is) → precision ladder → code-chosen-
 * convention floor → kind-agreement floor → ambiguity floor →
 * low-confidence demotion (toward guessed, never past it toward
 * rejected). Two safety stories: nothing invalid or unanchored is ever
 * silently normalized, and a value produced by convention ("we read it
 * MM/DD") is always FLAGGED, never shipped clean.
 */

/* ------------------------------------------------------------------ *
 * Verdicts (extraction status).
 * ------------------------------------------------------------------ */

export const EXTRACT_STATUS = [
  "resolved",
  "guessed",
  "vague",
  "rejected",
] as const;
export type ExtractStatus = (typeof EXTRACT_STATUS)[number];

export const STATUS_RANK: Record<ExtractStatus, number> = {
  resolved: 0,
  guessed: 1,
  vague: 2,
  rejected: 3,
};

export const STATUS_NOTE: Record<ExtractStatus, string> = {
  resolved: "normalized to a canonical value — no convention was chosen for it",
  guessed: "normalized, but by a documented convention or under flag — review-worthy",
  vague: "no canonical value emitted — too coarse or unanchored to pin down",
  rejected: "code validation refused the token — nothing invalid is ever normalized",
};

export function statusBadgeClass(s: ExtractStatus): "good" | "warn" | "bad" {
  return s === "resolved" ? "good" : s === "rejected" ? "bad" : "warn";
}

function clampStatus(v: number): ExtractStatus {
  return EXTRACT_STATUS[Math.min(Math.max(0, v), EXTRACT_STATUS.length - 1)];
}

/* ------------------------------------------------------------------ *
 * The typed questions.
 * ------------------------------------------------------------------ */

export const KIND_LEVELS = ["date", "money", "other"];

/** 0 vague … 4 fully-specified — a five-rung sharpness ladder. */
export const PRECISION_LEVELS = [
  "unanchored or fragmentary",
  "relative to a reference date",
  "coarse (week/month-level)",
  "day-precision",
  "exact (time and/or timezone, or a fully-quantified amount)",
];

export function extractQuestions(): Record<string, Question> {
  return {
    kind: {
      type: "choice",
      instructions:
        "What kind of value does the CANDIDATE token denote — a calendar date/time, a monetary amount, or something else entirely?",
      criteria: {
        date: "a calendar date or time (any format, relative or absolute)",
        money: "a monetary amount in some currency",
        other: "not a date or money value at all (a count, an id, an accident of typography)",
      },
    },
    precision: {
      type: "score",
      instructions:
        "How sharply is the CANDIDATE value specified as written, from an unanchored fragment to an exact instant or a fully-quantified amount?",
      criteria: PRECISION_LEVELS,
    },
    ambiguous: {
      type: "noul",
      instructions:
        "Does the CANDIDATE token admit more than one plausible reading — day/month order, which currency, magnitude shorthand, or an unstated reference date?",
      criteria: {
        true: "a careful reader could normalize it two different ways — more than one plausible reading",
        false: "exactly one plausible reading",
      },
    },
  };
}

/* ------------------------------------------------------------------ *
 * Signals + gates.
 * ------------------------------------------------------------------ */

export type ExtractSignals = {
  /** the reader's verdict on what kind of value the token is */
  kind: string;
  /** precision level index (fractional values allowed, as Jev scores) */
  precision: number;
  /** probability the token has more than one plausible reading */
  ambiguous: number;
  /** classification confidence (the precision Score's confidence) */
  confidence: number;
};

export type ExtractGates = {
  /** precision at or above which the base status is RESOLVED. */
  resolveAt: number;
  /** ambiguity probability at or above which resolved is capped to guessed. */
  ambiguousFloor: number;
  /** confidence below which a RESOLVED is demoted to GUESSED (never worse). */
  lowConfBump: number;
};

export const DEFAULT_GATES: ExtractGates = {
  resolveAt: 3,
  ambiguousFloor: 0.5,
  lowConfBump: 0.6,
};

/** Merge partial slider values over the shipped gate defaults. */
export function normalizeGates(partial?: Partial<ExtractGates>): ExtractGates {
  return { ...DEFAULT_GATES, ...(partial ?? {}) };
}

/* ------------------------------------------------------------------ *
 * Answer validation — dispatcher discipline: anything outside the
 * declared option/level set or a non-probability Noul is a hard error.
 * ------------------------------------------------------------------ */

export function signalsFrom(answers: Record<string, unknown>): ExtractSignals {
  const kind = answers.kind as { type?: string; choice?: string } | undefined;
  if (
    kind?.type !== "choice" ||
    typeof kind.choice !== "string" ||
    !KIND_LEVELS.includes(kind.choice)
  ) {
    throw new Error("extract: kind answer is outside the declared options");
  }
  const precision = answers.precision as
    | { type?: string; score?: number; confidence?: number }
    | undefined;
  if (
    precision?.type !== "score" ||
    typeof precision.score !== "number" ||
    !Number.isFinite(precision.score) ||
    precision.score < 0 ||
    precision.score >= PRECISION_LEVELS.length
  ) {
    throw new Error("extract: precision score is outside the declared levels");
  }
  const ambiguous = answers.ambiguous as
    | { type?: string; noul?: number }
    | undefined;
  if (
    ambiguous?.type !== "noul" ||
    typeof ambiguous.noul !== "number" ||
    !Number.isFinite(ambiguous.noul) ||
    ambiguous.noul < 0 ||
    ambiguous.noul > 1
  ) {
    throw new Error("extract: ambiguous answer missing or not a probability");
  }
  return {
    kind: kind.choice,
    precision: precision.score,
    ambiguous: ambiguous.noul,
    confidence: precision.confidence ?? 0,
  };
}

/* ------------------------------------------------------------------ *
 * CODE-side detection — messy date/amount tokens found by grammar,
 * never by the free model. ISO spans are claimed first so the numeric
 * M/D/Y pass can never tear "2026-11-20" into fake fragments.
 * ------------------------------------------------------------------ */

export type DetectedKind = "date" | "money";

export type TokenShape =
  | {
      shape: "iso";
      y: number;
      mo: number;
      d: number;
      hh?: string;
      mi?: string;
      ss?: string;
      tz?: string;
    }
  | { shape: "numeric"; a: number; b: number; y: number; twoDigitYear: boolean }
  | { shape: "monthname"; mo: number; d: number; y: number }
  | {
      shape: "relative";
      rel:
        | "today"
        | "tonight"
        | "tomorrow"
        | "next-weekday"
        | "next-week"
        | "next-month"
        | "in-days"
        | "in-weeks"
        | "in-months";
      weekday?: number;
      n?: number;
    }
  | { shape: "money"; currency: string; amount: number; multiplier?: string };

export type Detected = {
  token: string;
  kind: DetectedKind;
  shape: TokenShape;
  index: number;
};

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

function monthIndex(name: string): number {
  return MONTHS.indexOf(name.slice(0, 3).toLowerCase());
}

const MONTH_NAME =
  "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";

const ISO_RE =
  /\b(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?)?\b/g;
const MN_MONTH_FIRST_RE = new RegExp(
  `\\b(${MONTH_NAME})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`,
  "gi",
);
const MN_DAY_FIRST_RE = new RegExp(
  `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAME})\\.?,?\\s+(\\d{4})\\b`,
  "gi",
);
const REL_TODAY_RE = /\b(today|tonight|tomorrow)\b/gi;
const REL_NEXTWD_RE =
  /\bnext (week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi;
const REL_IN_RE = /\bin (\d{1,3}) (days?|weeks?|months?)\b/gi;
const NUMERIC_RE = /\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4}|\d{2})\b/g;
const MONEY_PREFIX_SYM_RE =
  /([$€£¥])\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)([kmb])?\b/gi;
const MONEY_CODE_PREFIX_RE =
  /\b(USD|EUR|GBP|JPY)\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)([kmb])?\b/gi;
const MONEY_CODE_SUFFIX_RE =
  /\b(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s(USD|EUR|GBP|JPY)\b/gi;

const SYMBOL_CCY: Record<string, string> = {
  $: "USD",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
};
const MULTIPLIER: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };
const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

function num(raw: string): number {
  return parseFloat(raw.replace(/,/g, ""));
}

/** Detect every date/money candidate token in messy text. Pure, deterministic. */
export function detectCandidates(text: string): Detected[] {
  const out: Detected[] = [];
  const taken: Array<[number, number]> = [];
  const claim = (start: number, end: number): boolean => {
    for (const [s, e] of taken) {
      if (start < e && end > s) return false;
    }
    taken.push([start, end]);
    return true;
  };
  const add = (
    m: RegExpExecArray,
    kind: DetectedKind,
    shape: TokenShape,
  ): void => {
    if (!claim(m.index, m.index + m[0].length)) return;
    out.push({ token: m[0], kind, shape, index: m.index });
  };
  const drain = (
    re: RegExp,
    kind: DetectedKind,
    map: (m: RegExpExecArray) => TokenShape | null,
  ) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      const shape = map(m);
      if (!shape) continue;
      add(m, kind, shape);
    }
  };

  // ISO first — it owns its span.
  drain(ISO_RE, "date", (m) => ({
    shape: "iso",
    y: Number(m[1]),
    mo: Number(m[2]),
    d: Number(m[3]),
    hh: m[4],
    mi: m[5],
    ss: m[6],
    tz: m[7],
  }));

  drain(MN_MONTH_FIRST_RE, "date", (m) => {
    const mo = monthIndex(m[1]);
    if (mo < 0) return null;
    return { shape: "monthname", mo: mo + 1, d: Number(m[2]), y: Number(m[3]) };
  });
  drain(MN_DAY_FIRST_RE, "date", (m) => {
    const mo = monthIndex(m[2]);
    if (mo < 0) return null;
    return { shape: "monthname", mo: mo + 1, d: Number(m[1]), y: Number(m[3]) };
  });

  drain(REL_TODAY_RE, "date", (m) => ({
    shape: "relative",
    rel: m[1].toLowerCase() as "today" | "tonight" | "tomorrow",
  }));
  drain(REL_NEXTWD_RE, "date", (m) => {
    const word = m[1].toLowerCase();
    if (word === "week") return { shape: "relative", rel: "next-week" };
    if (word === "month") return { shape: "relative", rel: "next-month" };
    const weekday = WEEKDAYS.indexOf(word);
    if (weekday < 0) return null;
    return { shape: "relative", rel: "next-weekday", weekday };
  });
  drain(REL_IN_RE, "date", (m) => {
    const unit = m[2].toLowerCase().replace(/s$/, "");
    if (unit !== "day" && unit !== "week" && unit !== "month") return null;
    return {
      shape: "relative",
      rel: `in-${unit}s` as "in-days" | "in-weeks" | "in-months",
      n: Number(m[1]),
    };
  });

  drain(NUMERIC_RE, "date", (m) => ({
    shape: "numeric",
    a: Number(m[1]),
    b: Number(m[2]),
    y: Number(m[3]),
    twoDigitYear: m[3].length === 2,
  }));

  drain(MONEY_PREFIX_SYM_RE, "money", (m) => ({
    shape: "money",
    currency: SYMBOL_CCY[m[1]] ?? "USD",
    amount: num(m[2]) * (m[3] ? MULTIPLIER[m[3].toLowerCase()] : 1),
    multiplier: m[3]?.toLowerCase(),
  }));
  drain(MONEY_CODE_PREFIX_RE, "money", (m) => ({
    shape: "money",
    currency: m[1].toUpperCase(),
    amount: num(m[2]) * (m[3] ? MULTIPLIER[m[3].toLowerCase()] : 1),
    multiplier: m[3]?.toLowerCase(),
  }));
  drain(MONEY_CODE_SUFFIX_RE, "money", (m) => ({
    shape: "money",
    currency: m[2].toUpperCase(),
    amount: num(m[1]),
  }));

  return out.sort((x, y) => x.index - y.index);
}

/* ------------------------------------------------------------------ *
 * CODE-side validation + normalization — the "validate in code" the
 * calendar row names. Pure and deterministic.
 * ------------------------------------------------------------------ */

export type Normalized = {
  /** canonical value, or null when code refused / could not pin it */
  value: string | null;
  /** interpretation notes — conventions chosen, things a human should see */
  note?: string;
  /** lowest status CODE allows regardless of the reader's answers */
  codeFloor?: "guessed" | "vague";
  /** absolute code-side refusal — validate-in-code wins over everything */
  parseError?: string;
};

export function daysInMonth(y: number, mo: number): number {
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const table = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return table[mo - 1];
}

export function isValidDate(y: number, mo: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(mo) || !Number.isInteger(d)) {
    return false;
  }
  if (mo < 1 || mo > 12) return false;
  if (y < 1000 || y > 9999) return false;
  return d >= 1 && d <= daysInMonth(y, mo);
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isoFromParts(y: number, mo: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(
    d,
  ).padStart(2, "0")}`;
}

export function parseAnchor(anchor: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(anchor.trim());
  if (!m || !isValidDate(Number(m[1]), Number(m[2]), Number(m[3]))) {
    throw new Error("extract: anchor is not a valid ISO date (YYYY-MM-DD)");
  }
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function addMonthsClamped(
  base: Date,
  months: number,
): { date: Date; clamped: boolean } {
  const y = base.getUTCFullYear();
  const mo = base.getUTCMonth();
  const d = base.getUTCDate();
  const target = mo + months;
  const ny = y + Math.floor(target / 12);
  const nmo = ((target % 12) + 12) % 12;
  const maxD = daysInMonth(ny, nmo + 1);
  const clamped = d > maxD;
  return { date: new Date(Date.UTC(ny, nmo, clamped ? maxD : d)), clamped };
}

/** Normalize one detected token against an optional anchor date. */
export function normalizeDetected(det: Detected, anchor?: string): Normalized {
  const s = det.shape;

  if (s.shape === "iso") {
    if (!isValidDate(s.y, s.mo, s.d)) {
      return { value: null, parseError: `${det.token} is not a real calendar date` };
    }
    let value = isoFromParts(s.y, s.mo, s.d);
    let note: string | undefined;
    if (s.hh !== undefined && s.mi !== undefined) {
      value += `T${s.hh}:${s.mi}${s.ss ? `:${s.ss}` : ""}`;
      if (s.tz) value += s.tz;
      else note = "time given without a timezone — emitted as written, no offset applied";
    }
    return { value, ...(note ? { note } : {}) };
  }

  if (s.shape === "numeric") {
    const y = s.twoDigitYear ? (s.y < 70 ? 2000 + s.y : 1900 + s.y) : s.y;
    const yearNote = s.twoDigitYear
      ? `two-digit year '${s.y}' expanded to ${y}`
      : undefined;
    if (s.a > 12 && s.b > 12) {
      return {
        value: null,
        parseError: `${det.token} has no valid month in either day/month order`,
      };
    }
    let mo: number;
    let d: number;
    let convention: string | undefined;
    if (s.a > 12) {
      mo = s.b;
      d = s.a;
      // forced day-first by validity — no ambiguity remains
    } else if (s.b > 12) {
      mo = s.a;
      d = s.b;
      // forced month-first by validity — no ambiguity remains
    } else {
      mo = s.a;
      d = s.b;
      convention = "both components ≤ 12 — MM/DD/YYYY convention chosen";
    }
    if (!isValidDate(y, mo, d)) {
      return {
        value: null,
        parseError: `${det.token} is not a real calendar date in any valid order`,
      };
    }
    const note = [yearNote, convention].filter(Boolean).join("; ");
    return {
      value: isoFromParts(y, mo, d),
      ...(note ? { note } : {}),
      ...(convention ? { codeFloor: "guessed" as const } : {}),
    };
  }

  if (s.shape === "monthname") {
    if (!isValidDate(s.y, s.mo, s.d)) {
      return { value: null, parseError: `${det.token} is not a real calendar date` };
    }
    return { value: isoFromParts(s.y, s.mo, s.d) };
  }

  if (s.shape === "relative") {
    if (!anchor) {
      return {
        value: null,
        note: "relative expression with no reference date supplied — cannot be pinned",
        codeFloor: "vague",
      };
    }
    const a = parseAnchor(anchor);
    const day = (deltaDays: number) =>
      isoDay(new Date(a.getTime() + deltaDays * 86_400_000));
    switch (s.rel) {
      case "today":
        return { value: isoDay(a), note: "date-level reading: the day of the anchor" };
      case "tonight":
        return {
          value: isoDay(a),
          note: "evening of the anchor day — the time of day was never written",
        };
      case "tomorrow":
        return { value: day(1) };
      case "next-weekday": {
        const target = s.weekday ?? 0;
        const offset = ((target - a.getUTCDay() + 7) % 7) || 7;
        return {
          value: day(offset),
          note: `next ${WEEKDAYS[target]} = the first ${WEEKDAYS[target]} strictly after the anchor`,
        };
      }
      case "next-week":
        return {
          value: day(7),
          note: "'next week' interpreted as its start day, 7 days from the anchor",
          codeFloor: "guessed",
        };
      case "next-month": {
        const { date, clamped } = addMonthsClamped(a, 1);
        return {
          value: isoDay(date),
          note: clamped
            ? "'next month' lands past the end of a shorter month — clamped to its last day"
            : "'next month' interpreted as the same day of the next month",
          codeFloor: "guessed",
        };
      }
      case "in-days":
        return { value: day(s.n ?? 0) };
      case "in-weeks":
        return { value: day(7 * (s.n ?? 0)) };
      case "in-months": {
        const { date, clamped } = addMonthsClamped(a, s.n ?? 0);
        if (clamped) {
          return {
            value: isoDay(date),
            note: `adding ${s.n} months overshoots a shorter month — clamped to its last day`,
            codeFloor: "guessed",
          };
        }
        return { value: isoDay(date), note: `anchor + ${s.n} months` };
      }
    }
    return { value: null, parseError: `unhandled relative form ${det.token}` };
  }

  // money
  if (!Number.isFinite(s.amount) || s.amount < 0) {
    return { value: null, parseError: `${det.token} is not a well-formed amount` };
  }
  const note = s.multiplier
    ? `magnitude shorthand '${s.multiplier}' applied (×${MULTIPLIER[s.multiplier]})`
    : undefined;
  return {
    value: `${s.currency} ${s.amount.toFixed(2)}`,
    ...(note ? { note } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Pure in-code status ladder.
 * ------------------------------------------------------------------ */

export type ExtractionDecision = {
  status: ExtractStatus;
  /** canonical value — emitted only for resolved/guessed, never otherwise */
  value: string | null;
  reasons: string[];
};

/**
 * resolved / guessed / vague / rejected decided IN CODE. Rule order is
 * the safety story: validate-in-code floor (absolute) → precision
 * ladder → code-chosen-convention floor → kind-agreement floor →
 * ambiguity floor → confidence demotion (toward guessed, never past it).
 */
export function decideExtractionVerdict(
  signals: ExtractSignals,
  norm: Normalized,
  codeKind: DetectedKind,
  gates: ExtractGates = DEFAULT_GATES,
): ExtractionDecision {
  const reasons: string[] = [];

  // Validate-in-code is absolute — a Feb 30 never ships a value, however
  // confident the reader says it is.
  if (norm.parseError) {
    reasons.push(`validate-in-code: ${norm.parseError} — refused`);
    reasons.push(`extraction verdict: rejected (${STATUS_NOTE.rejected})`);
    return { status: "rejected", value: null, reasons };
  }

  // Precision ladder — the base rung.
  let rank: number;
  if (signals.precision >= gates.resolveAt) {
    rank = STATUS_RANK.resolved;
    reasons.push(
      `precision ${signals.precision.toFixed(1)} ≥ resolve gate ${gates.resolveAt} — sharp as written`,
    );
  } else {
    rank = STATUS_RANK.vague;
    reasons.push(
      `precision ${signals.precision.toFixed(1)} below resolve gate ${gates.resolveAt} — too coarse or unanchored to pin`,
    );
  }

  // Code's own floor — chosen conventions and unanchorable relatives set a
  // minimum status the reader can never talk down.
  if (norm.codeFloor) {
    const floorRank = STATUS_RANK[norm.codeFloor];
    if (floorRank > rank) {
      rank = floorRank;
      reasons.push(
        `code floor ${norm.codeFloor} — ${norm.note ?? "a convention governs this normalization"}, never shipped clean`,
      );
    }
  }

  // Kind agreement — if the reader says this token is not the kind of
  // value the grammar found, a resolved never ships unflagged.
  if (signals.kind !== codeKind && rank < STATUS_RANK.guessed) {
    rank = STATUS_RANK.guessed;
    reasons.push(
      `kind disagreement — grammar reads '${codeKind}', reader says '${signals.kind}'; flagged, never silent`,
    );
  }

  // Ambiguity floor — more than one plausible reading caps resolved to
  // guessed; vague/rejected bases are left alone (a cap cannot rescue
  // what was never resolved, and never escalates toward rejected).
  if (signals.ambiguous >= gates.ambiguousFloor && rank === STATUS_RANK.resolved) {
    rank = STATUS_RANK.guessed;
    reasons.push(
      `ambiguity ${signals.ambiguous.toFixed(2)} ≥ floor ${gates.ambiguousFloor.toFixed(2)} — more than one reading survives, resolved capped to guessed`,
    );
  }

  // Confidence demotion — an uncertain resolved goes to guessed, NEVER
  // worse. Doubt never destroys a value; it only flags it.
  if (signals.confidence < gates.lowConfBump && rank === STATUS_RANK.resolved) {
    rank = STATUS_RANK.guessed;
    reasons.push(
      `precision confidence ${signals.confidence.toFixed(2)} below ${gates.lowConfBump.toFixed(2)} — an uncertain normalization ships flagged, never silently`,
    );
  }

  const status = clampStatus(rank);
  const value =
    status === "resolved" || status === "guessed" ? norm.value : null;

  if (norm.note && rank !== STATUS_RANK.vague && rank !== STATUS_RANK.rejected) {
    if (!reasons.join(" ").includes(norm.note)) {
      reasons.push(`convention: ${norm.note}`);
    }
  }
  reasons.push(`extraction verdict: ${status} (${STATUS_NOTE[status]})`);
  return { status, value, reasons };
}

/* ------------------------------------------------------------------ *
 * Live single text: detect in code, classify per candidate, decide in
 * code. Dev view wires through the shared ?dev=1 trace contract.
 * ------------------------------------------------------------------ */

export function extractState(context: string, token: string): string {
  return `TEXT:\n${context.trim()}\n\nCANDIDATE:\n${token.trim()}`;
}

export type CandidateResult = {
  token: string;
  kindDetected: DetectedKind;
  normalized: Normalized;
  signals?: ExtractSignals;
  status: ExtractStatus;
  value: string | null;
  reasons: string[];
  usage?: Usage;
};

export type ExtractedText = {
  text: string;
  anchor: string;
  results: CandidateResult[];
  gates: ExtractGates;
  model: string;
  provider: Provider;
  usage: Usage;
  trace?: unknown;
};

export type ExtractTextOptions = {
  classifyFn?: typeof classify;
  gates?: Partial<ExtractGates>;
  anchor?: string;
  trace?: boolean;
};

export async function extractText(
  text: string,
  opts: ExtractTextOptions = {},
): Promise<ExtractedText> {
  const run = opts.classifyFn ?? classify;
  const gates = normalizeGates(opts.gates);
  const anchor = opts.anchor ?? todayIso();
  if (opts.anchor) parseAnchor(opts.anchor); // fail fast on a bad anchor

  const detections = detectCandidates(text);
  const results: CandidateResult[] = [];
  const usage: Usage = { input_tokens: 0, output_tokens: 0 };
  let model = "";
  let provider: Provider = "gateway";
  let trace: unknown;

  for (const det of detections) {
    const normalized = normalizeDetected(det, anchor);
    const res: ClassifyResult = await run(
      { state: extractState(text, det.token), questions: extractQuestions() },
      opts.trace ? { trace: true } : {},
    );
    const signals = signalsFrom(res.answers);
    const decision = decideExtractionVerdict(signals, normalized, det.kind, gates);
    usage.input_tokens += res.usage.input_tokens;
    usage.output_tokens += res.usage.output_tokens;
    model = res.model;
    provider = res.provider;
    if (opts.trace && res.trace && trace === undefined) trace = res.trace;
    results.push({
      token: det.token,
      kindDetected: det.kind,
      normalized,
      signals,
      status: decision.status,
      value: decision.value,
      reasons: decision.reasons,
      usage: res.usage,
    });
  }

  return {
    text,
    anchor,
    results,
    gates,
    model,
    provider,
    usage,
    ...(opts.trace && trace !== undefined ? { trace } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Batched extraction with the lane's 5 → 10 → All discipline. The unit
 * of the ladder is the messy SNIPPET; every candidate inside it gets
 * its own in-code verdict. 11-19 row (UC#8 date/value extraction).
 * ------------------------------------------------------------------ */

export type ExtractionSnippetIn = { id: string; text: string };

export type ExtractionBatchItem = {
  id: string;
  text: string;
  results?: CandidateResult[];
  usage?: Usage;
  error?: string;
};

export type ExtractionTotals = {
  snippets: number;
  candidates: number;
  errors: number;
  statuses: Record<ExtractStatus, number>;
  usage: Usage;
};

export type ExtractionBatchReport = {
  items: ExtractionBatchItem[];
  totals: ExtractionTotals;
  anchor: string;
  gates: ExtractGates;
  model: string;
  provider: Provider;
};

export type RunExtractBatchOptions = {
  classifyFn?: typeof classify;
  gates?: Partial<ExtractGates>;
  anchor?: string;
  /** Cap on snippets processed; null = All. Default 5 (first ladder rung). */
  limit?: number | null;
  concurrency?: number;
};

/**
 * Extract a corpus of messy snippets. A failure on one snippet is
 * isolated to that snippet's report and never aborts the batch — same
 * contract as the memory and citations batches. Verdicts stay code-side
 * per candidate; the ladder is identical to the live single-text path.
 */
export async function runExtractBatch(
  snippets: ExtractionSnippetIn[],
  opts: RunExtractBatchOptions = {},
): Promise<ExtractionBatchReport> {
  const run = opts.classifyFn ?? classify;
  const gates = normalizeGates(opts.gates);
  const anchor = opts.anchor ?? todayIso();
  const limit =
    opts.limit === null ? snippets.length : (opts.limit ?? BATCH_LADDER[0]);
  const scoped = snippets.slice(
    0,
    Math.max(0, Math.min(limit, snippets.length)),
  );
  const concurrency = Math.min(
    Math.max(1, opts.concurrency ?? 3),
    scoped.length || 1,
  );

  const reports: (ExtractionBatchItem | undefined)[] = new Array(scoped.length);
  let cursor = 0;
  let classifierModel = "";
  let classifierProvider: Provider = "gateway";

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= scoped.length) return;
      const sn = scoped[i];
      const report: ExtractionBatchItem = { id: sn.id, text: sn.text };
      try {
        const out = await extractText(sn.text, {
          classifyFn: run,
          gates,
          anchor,
        });
        report.results = out.results;
        report.usage = out.usage;
        classifierModel = out.model;
        classifierProvider = out.provider;
      } catch (err) {
        report.error =
          err instanceof Error ? err.message : "extraction failed";
      }
      reports[i] = report;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const statuses: Record<ExtractStatus, number> = {
    resolved: 0,
    guessed: 0,
    vague: 0,
    rejected: 0,
  };
  const totals: ExtractionTotals = {
    snippets: scoped.length,
    candidates: 0,
    errors: 0,
    statuses,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  for (const r of reports.filter((x): x is ExtractionBatchItem => !!x)) {
    if (r.error) {
      totals.errors += 1;
      continue;
    }
    for (const c of r.results ?? []) {
      totals.candidates += 1;
      totals.statuses[c.status] += 1;
    }
    if (r.usage) {
      totals.usage.input_tokens += r.usage.input_tokens;
      totals.usage.output_tokens += r.usage.output_tokens;
    }
  }

  return {
    items: reports.filter((x): x is ExtractionBatchItem => !!x),
    totals,
    anchor,
    gates,
    model: classifierModel,
    provider: classifierProvider,
  };
}
