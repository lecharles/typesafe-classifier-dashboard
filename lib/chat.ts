import { classify } from "@/lib/classify";
import { BATCH_LADDER } from "@/lib/dispatch";
import { chatMessages, type ChatMessage } from "@/data/chat-corpus";
import type { ClassifyResult, Provider, Question, Usage } from "@/lib/schema";

/**
 * UC#9 (11-21 on the calendar, shipped 11-20 one day ahead): Twitch-style
 * chat filter — ROADMAP-V2 Track C item 9, "insults/spam/spoilers with
 * per-message batched questions".
 *
 * A live stream mod does three jobs at once: let the good chat flow, squash
 * the attacks and the bot spam, and hide the spoilers for people still
 * watching the thing live. This lane has always decided verdicts IN CODE —
 * the classifier only ever answers typed questions. UC#9 rides the UC#7
 * detector family ladder over one message at a time:
 *
 *   toxicity → Score  five rungs, friendly chatter → targeted harassment
 *   promo    → Noul   unsolicited promotion / bot spam / scam link drops
 *   spoiler  → Noul   reveals an outcome the stream has not shown yet
 *
 * Rule order mirrors the BS/memory ladders: toxicity ladder → promo floor
 * (absolute — a friendly-voiced scam link is still spam whatever the tone
 * says) → spoiler cap (a spoiler is NEVER silently waved through; it goes
 * to the hold lane where a mod decides, because spoiling is not attacking
 * — the cap only softens the lane, never the punishment) → confidence
 * demotion (an uncertain ALLOW queues for a human; doubt never escalates
 * a message into a block, same inversion as memory and BS).
 *
 * Batch discipline holds: 5 → 10 → All over the 28-message stream corpus,
 * with a per-user offender rollup so "timeout candidates" get answered in
 * data, not vibes — mods act on USERS, so the handle rides the state.
 */

/* ------------------------------------------------------------------ *
 * Actions.
 * ------------------------------------------------------------------ */

export const CHAT_ACTIONS = ["allow", "hold", "block"] as const;
export type ChatAction = (typeof CHAT_ACTIONS)[number];

export const CHAT_RANK: Record<ChatAction, number> = {
  allow: 0,
  hold: 1,
  block: 2,
};

export const CHAT_NOTE: Record<ChatAction, string> = {
  allow: "reads like a real viewer — let it through",
  hold: "worth a mod's eye — hidden until a human approves it",
  block: "flagged chat — squashed and logged",
};

export function chatBadgeClass(a: ChatAction): "good" | "warn" | "bad" {
  return a === "allow" ? "good" : a === "hold" ? "warn" : "bad";
}

function clampRank(v: number): ChatAction {
  return CHAT_ACTIONS[Math.min(Math.max(0, v), CHAT_ACTIONS.length - 1)];
}

/* ------------------------------------------------------------------ *
 * The typed questions — one set, every message.
 * ------------------------------------------------------------------ */

/** 0 friendly chatter … 4 targeted harassment — the five-rung toxicity ladder. */
export const CHAT_LEVELS = [
  "friendly chatter",
  "mild tease",
  "crude but harmless",
  "personal attack",
  "targeted harassment",
];

export function chatQuestions(): Record<string, Question> {
  return {
    toxicity: {
      type: "score",
      instructions:
        "How toxic is this live-chat message — from friendly chatter and hype, through a mild tease and crude-but-harmless griping, to a personal attack on a player or viewer, to targeted harassment meant to drive someone out?",
      criteria: CHAT_LEVELS,
    },
    promo: {
      type: "noul",
      instructions:
        "Is this message unsolicited promotion or bot spam — a follow-for-follow scheme, a 'free stuff' link drop, a giveaway scam, or a copy-pasta ad farming clicks or logins? True = spam promo, false = a real human here for the stream.",
      criteria: { true: "spam or scam promo", false: "a genuine viewer" },
    },
    spoiler: {
      type: "noul",
      instructions:
        "Does this message reveal an outcome the stream has NOT shown yet — a final score, a plot twist, a boss location, a leak — in a way that would ruin it for someone watching live? True = spoiler, false = safe.",
      criteria: { true: "spoils an unseen outcome", false: "no spoiler" },
    },
  };
}

/* ------------------------------------------------------------------ *
 * Signals + gates.
 * ------------------------------------------------------------------ */

export type ChatSignals = {
  /** toxicity level index (fractional values allowed, as Jev scores) */
  toxicity: number;
  /** probability of unsolicited promotion / bot spam */
  promo: number;
  /** probability the message spoils an unseen outcome */
  spoiler: number;
  /** classification confidence (the toxicity Score's confidence) */
  confidence: number;
};

export type ChatGates = {
  /** toxicity at or above which the message is BLOCKED outright. */
  blockAt: number;
  /** toxicity at or below which the message can be ALLOWED. */
  allowAt: number;
  /** promo probability at or above which the message is blocked, whatever the ladder says. */
  promoBlockAt: number;
  /** spoiler probability at or above which an ALLOW is capped to HOLD. */
  spoilerFloor: number;
  /** confidence below which an ALLOW is demoted to HOLD (never silently through). */
  lowConfBump: number;
};

export const DEFAULT_GATES: ChatGates = {
  blockAt: 3.5,
  allowAt: 1.0,
  promoBlockAt: 0.6,
  spoilerFloor: 0.5,
  lowConfBump: 0.6,
};

/** Merge partial slider values over the shipped gate defaults. */
export function normalizeGates(partial?: Partial<ChatGates>): ChatGates {
  return { ...DEFAULT_GATES, ...(partial ?? {}) };
}

export type ChatDecision = {
  action: ChatAction;
  reasons: string[];
};

/* ------------------------------------------------------------------ *
 * Answer validation — dispatcher discipline: anything outside the
 * declared level set or a non-probability Noul is a hard error.
 * ------------------------------------------------------------------ */

export function signalsFrom(answers: Record<string, unknown>): ChatSignals {
  const toxicity = answers.toxicity as
    | { type?: string; score?: number; confidence?: number }
    | undefined;
  if (
    toxicity?.type !== "score" ||
    typeof toxicity.score !== "number" ||
    !Number.isFinite(toxicity.score) ||
    toxicity.score < 0 ||
    toxicity.score >= CHAT_LEVELS.length
  ) {
    throw new Error("chat: toxicity score is outside the declared levels");
  }
  const promo = answers.promo as { type?: string; noul?: number } | undefined;
  if (
    promo?.type !== "noul" ||
    typeof promo.noul !== "number" ||
    !Number.isFinite(promo.noul) ||
    promo.noul < 0 ||
    promo.noul > 1
  ) {
    throw new Error("chat: promo answer missing or not a probability");
  }
  const spoiler = answers.spoiler as { type?: string; noul?: number } | undefined;
  if (
    spoiler?.type !== "noul" ||
    typeof spoiler.noul !== "number" ||
    !Number.isFinite(spoiler.noul) ||
    spoiler.noul < 0 ||
    spoiler.noul > 1
  ) {
    throw new Error("chat: spoiler answer missing or not a probability");
  }
  return {
    toxicity: toxicity.score,
    promo: promo.noul,
    spoiler: spoiler.noul,
    confidence: toxicity.confidence ?? 0,
  };
}

/* ------------------------------------------------------------------ *
 * Pure in-code verdict ladder.
 * ------------------------------------------------------------------ */

/**
 * allow / hold / block decided in code. Rule order is the safety story:
 * toxicity ladder → promo floor (absolute) → spoiler cap → confidence
 * demotion. Uncertainty and spoilers only ever route a message toward
 * HOLD (the human lane) — doubt never escalates a message into a block.
 */
export function decideChatAction(
  s: ChatSignals,
  gates: ChatGates = DEFAULT_GATES,
): ChatDecision {
  const reasons: string[] = [];

  // Toxicity ladder — the base rung.
  let rank: number;
  if (s.toxicity >= gates.blockAt) {
    rank = CHAT_RANK.block;
    reasons.push(
      `toxicity ${s.toxicity.toFixed(1)} ≥ block gate ${gates.blockAt} — this is an attack, not chat`,
    );
  } else if (s.toxicity <= gates.allowAt) {
    rank = CHAT_RANK.allow;
    reasons.push(
      `toxicity ${s.toxicity.toFixed(1)} ≤ allow gate ${gates.allowAt} — reads like a real viewer`,
    );
  } else {
    rank = CHAT_RANK.hold;
    reasons.push(
      `toxicity ${s.toxicity.toFixed(1)} between allow ${gates.allowAt} and block ${gates.blockAt} — crude-but-harmless lane, worth a mod's eye`,
    );
  }

  // Promo floor is absolute — a scam link is spam whatever the tone says.
  if (s.promo >= gates.promoBlockAt) {
    reasons.push(
      `promo probability ${s.promo.toFixed(2)} ≥ floor ${gates.promoBlockAt.toFixed(2)} — a friendly-voiced link that lies to you is spam whatever the toxicity ladder says`,
    );
    rank = Math.max(rank, CHAT_RANK.block);
  }

  // Spoiler cap — a spoiler is never silently waved through. The HOLD lane
  // hides it for a human; spoiling is not attacking, so the cap routes,
  // it never punishes: a block base is left alone, already squashed.
  if (s.spoiler >= gates.spoilerFloor && rank === CHAT_RANK.allow) {
    rank = CHAT_RANK.hold;
    reasons.push(
      `spoiler probability ${s.spoiler.toFixed(2)} ≥ floor ${gates.spoilerFloor.toFixed(2)} — a spoiler never passes silently; the hold lane hides it for a mod, it does not punish it`,
    );
  }

  // Confidence demotion — an uncertain ALLOW queues for a human look.
  // It demotes toward hold, never escalates toward block.
  if (s.confidence < gates.lowConfBump && rank === CHAT_RANK.allow) {
    rank = CHAT_RANK.hold;
    reasons.push(
      `toxicity confidence ${s.confidence.toFixed(2)} below ${gates.lowConfBump.toFixed(2)} — uncertain allows never pass silently`,
    );
  }

  const action = clampRank(rank);
  reasons.push(`chat action: ${action} (${CHAT_NOTE[action]})`);
  return { action, reasons };
}

/* ------------------------------------------------------------------ *
 * State composition — the handle rides the message, because mods
 * act on USERS, and a bot handle next to a link is half the signal.
 * ------------------------------------------------------------------ */

export function chatState(user: string, message: string): string {
  return `${user.trim()}: ${message.trim()}`;
}

/* ------------------------------------------------------------------ *
 * Live single message: one classify call, action decided in code.
 * ------------------------------------------------------------------ */

export type ChatModerated = {
  user: string;
  message: string;
  state: string;
  signals: ChatSignals;
  decision: ChatDecision;
  gates: ChatGates;
  model: string;
  provider: Provider;
  usage: Usage;
  trace?: unknown;
};

export type ModerateOptions = {
  classifyFn?: typeof classify;
  gates?: ChatGates;
  trace?: boolean;
};

/**
 * Moderate one live chat message as it would hit the stream. `user` is
 * display + signal context; `message` is the body. The verdict is the
 * identical code ladder the batch path walks.
 */
export async function moderateChatMessage(
  message: string,
  user = "viewer",
  opts: ModerateOptions = {},
): Promise<ChatModerated> {
  const run = opts.classifyFn ?? classify;
  const gates = opts.gates ?? DEFAULT_GATES;
  const state = chatState(user, message);

  const res: ClassifyResult = await run(
    { state, questions: chatQuestions() },
    opts.trace ? { trace: true } : {},
  );

  const signals = signalsFrom(res.answers);
  const decision = decideChatAction(signals, gates);

  return {
    user: user.trim(),
    message: message.trim(),
    state,
    signals,
    decision,
    gates,
    model: res.model,
    provider: res.provider,
    usage: res.usage,
    ...(opts.trace && res.trace ? { trace: res.trace } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * The shipped corpus: one scroll of synthetic live chat.
 * ------------------------------------------------------------------ */

export type ChatItem = {
  id: string;
  user: string;
  message: string;
  /** the full state handed to the classifier */
  state: string;
};

/** Build the chat stream: every corpus message, handle riding its body. */
export function buildChatCorpus(messages: ChatMessage[] = chatMessages): ChatItem[] {
  return messages.map((m) => ({
    id: m.id,
    user: m.user,
    message: m.message,
    state: chatState(m.user, m.message),
  }));
}

/* ------------------------------------------------------------------ *
 * Batched moderation with the lane's 5 → 10 → All discipline, plus
 * the per-user offender rollup that makes timeout candidates visible.
 * ------------------------------------------------------------------ */

export type ChatBatchItemIn = {
  id: string;
  user?: string;
  /** the message body; `state` is composed from user + message */
  message: string;
};

export type ChatBatchItem = {
  id: string;
  user: string;
  message: string;
  signals?: ChatSignals;
  action?: ChatAction;
  reasons?: string[];
  usage?: Usage;
  error?: string;
};

export type ChatTally = Record<ChatAction, number>;

export type ChatOffenderRow = {
  user: string;
  /** only users with at least one hold or block appear here — the rollup mods act on */
  holds: number;
  blocks: number;
  /** blocks dominate holds — same band-dominance construction as the BS leaderboard */
  score: number;
};

export type ChatTotals = {
  moderated: number;
  errors: number;
  actions: ChatTally;
  usage: Usage;
};

export type ChatBatchReport = {
  items: ChatBatchItem[];
  totals: ChatTotals;
  offenders: ChatOffenderRow[];
  gates: ChatGates;
  model: string;
  provider: Provider;
};

export type RunChatBatchOptions = {
  classifyFn?: typeof classify;
  gates?: Partial<ChatGates>;
  /** Cap on messages processed; null = All. Default 5 (first ladder rung). */
  limit?: number | null;
  concurrency?: number;
};

function emptyTally(): ChatTally {
  return { allow: 0, hold: 0, block: 0 };
}

/**
 * Roll the batch items up PER USER — mods act on users, not messages.
 * Only users with at least one hold or block appear (a clean chatgoer
 * is not an offender). Ordering is deterministic and total: blocks
 * dominate holds (score = blocks × 10 + holds, so two blocks can never
 * be outranked by nine holds), then holds desc, then user asc as the
 * final tiebreaker. Errored items are excluded from the rollup but
 * COUNTED in totals.errors — never silently dropped.
 */
export function chatOffenders(items: ChatBatchItem[]): ChatOffenderRow[] {
  const byUser = new Map<string, { holds: number; blocks: number }>();
  for (const it of items) {
    if (it.error || !it.action) continue;
    if (it.action === "allow") continue;
    const row = byUser.get(it.user) ?? { holds: 0, blocks: 0 };
    if (it.action === "hold") row.holds += 1;
    if (it.action === "block") row.blocks += 1;
    byUser.set(it.user, row);
  }
  return [...byUser.entries()]
    .map(([user, r]) => ({ user, holds: r.holds, blocks: r.blocks, score: r.blocks * 10 + r.holds }))
    .sort((a, b) => b.score - a.score || b.holds - a.holds || a.user.localeCompare(b.user));
}

/**
 * Moderate a stream scroll (default: the shipped 28-message corpus). A
 * failure on one message is isolated to that message's report and never
 * aborts the batch — same contract as the bs/memory/citations batches.
 * Actions stay code-side per message; the ladder is identical to the
 * live single-moderate path.
 */
export async function runChatBatch(
  corpus: ChatBatchItemIn[] = buildChatCorpus(),
  opts: RunChatBatchOptions = {},
): Promise<ChatBatchReport> {
  const run = opts.classifyFn ?? classify;
  const gates = normalizeGates(opts.gates);
  const limit =
    opts.limit === null ? corpus.length : (opts.limit ?? BATCH_LADDER[0]);
  const scoped = corpus.slice(
    0,
    Math.max(0, Math.min(limit, corpus.length)),
  );
  const concurrency = Math.min(
    Math.max(1, opts.concurrency ?? 3),
    scoped.length || 1,
  );

  const reports: (ChatBatchItem | undefined)[] = new Array(scoped.length);
  let cursor = 0;
  let classifierModel = "";
  let classifierProvider: Provider = "gateway";

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= scoped.length) return;
      const c = scoped[i];
      const user = c.user ?? "viewer";
      const report: ChatBatchItem = {
        id: c.id,
        user,
        message: c.message,
      };
      try {
        const mod = await moderateChatMessage(c.message, user, {
          classifyFn: run,
          gates,
        });
        report.action = mod.decision.action;
        report.reasons = mod.decision.reasons;
        report.signals = mod.signals;
        report.usage = mod.usage;
        classifierModel = mod.model;
        classifierProvider = mod.provider;
      } catch (err) {
        report.error = err instanceof Error ? err.message : "chat moderation failed";
      }
      reports[i] = report;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const totals: ChatTotals = {
    moderated: scoped.length,
    errors: 0,
    actions: emptyTally(),
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  for (const r of reports.filter((x): x is ChatBatchItem => !!x)) {
    if (r.error) {
      totals.errors += 1;
      continue;
    }
    if (r.action) totals.actions[r.action] += 1;
    if (r.usage) {
      totals.usage.input_tokens += r.usage.input_tokens;
      totals.usage.output_tokens += r.usage.output_tokens;
    }
  }

  const items = reports.filter((x): x is ChatBatchItem => !!x);
  return {
    items,
    totals,
    offenders: chatOffenders(items),
    gates,
    model: classifierModel,
    provider: classifierProvider,
  };
}
