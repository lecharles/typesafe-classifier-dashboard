import { describe, it, expect } from "vitest";
import {
  CHAT_ACTIONS,
  CHAT_LEVELS,
  CHAT_NOTE,
  CHAT_RANK,
  CHAT_STRIKE_NOTE,
  CHAT_STRIKE_RANK,
  CHAT_STRIKE_STATES,
  DEFAULT_GATES,
  DEFAULT_STRIKE_GATES,
  applyChatStrikes,
  buildChatCorpus,
  chatBadgeClass,
  chatOffenderExportRows,
  chatOffenders,
  chatQuestions,
  chatState,
  chatStrikeBadgeClass,
  chatStrikeExportRows,
  decideChatAction,
  moderateChatMessage,
  normalizeGates,
  normalizeStrikeGates,
  runChatBatch,
  signalsFrom,
  type ChatAction,
  type ChatBatchItem,
  type ChatGates,
  type ChatSignals,
  type ChatStrikeRow,
} from "@/lib/chat";
import { toCSV } from "@/lib/export";
import { chatMessages } from "@/data/chat-corpus";
import type { Answer, ClassifyResult } from "@/lib/schema";

const noul = (p: number): Answer => ({ type: "noul", noul: p });
const score = (s: number, conf = 0.9): Answer => ({
  type: "score",
  score: s,
  probabilities: { [String(Math.round(s))]: conf },
  confidence: conf,
});

function fakeResult(answers: Record<string, Answer>): ClassifyResult {
  return {
    answers,
    usage: { input_tokens: 10, output_tokens: 5 },
    model: "jev-test",
    provider: "gateway",
  };
}

const sig = (over: Partial<ChatSignals> = {}): ChatSignals => ({
  toxicity: 2.0,
  promo: 0.05,
  spoiler: 0.05,
  confidence: 0.9,
  ...over,
});

function chatAnswers(
  over: Partial<{ toxicity: Answer; promo: Answer; spoiler: Answer }> = {},
) {
  return {
    toxicity: score(2, 0.9),
    promo: noul(0.05),
    spoiler: noul(0.05),
    ...over,
  } as Record<string, Answer>;
}

/* ------------------------------------------------------------------ */

describe("UC#9 chat actions + questions", () => {
  it("action ladder is strictly ordered allow < hold < block", () => {
    expect(CHAT_ACTIONS).toEqual(["allow", "hold", "block"]);
    expect(CHAT_RANK.allow).toBeLessThan(CHAT_RANK.hold);
    expect(CHAT_RANK.hold).toBeLessThan(CHAT_RANK.block);
  });

  it("every action has a badge class and a note", () => {
    expect(chatBadgeClass("allow")).toBe("good");
    expect(chatBadgeClass("hold")).toBe("warn");
    expect(chatBadgeClass("block")).toBe("bad");
    for (const a of CHAT_ACTIONS) expect(CHAT_NOTE[a]).toMatch(/\w/);
  });

  it("questions declare ONE set: a toxicity Score (5 levels) + two Nouls", () => {
    const qs = chatQuestions();
    expect(Object.keys(qs).sort()).toEqual(["promo", "spoiler", "toxicity"]);
    expect(qs.toxicity.type).toBe("score");
    expect(qs.toxicity.type === "score" && qs.toxicity.criteria).toEqual(CHAT_LEVELS);
    expect(CHAT_LEVELS).toHaveLength(5);
    expect(qs.promo.type).toBe("noul");
    expect(qs.spoiler.type).toBe("noul");
    expect(qs.promo.type === "noul" && qs.promo.criteria?.true).toMatch(/spam/i);
    expect(qs.spoiler.type === "noul" && qs.spoiler.criteria?.true).toMatch(/spoils/i);
  });

  it("default gates order the ladder sanely: allowAt < blockAt, floors are probabilities", () => {
    expect(DEFAULT_GATES.allowAt).toBeLessThan(DEFAULT_GATES.blockAt);
    expect(DEFAULT_GATES.blockAt).toBeGreaterThan(0);
    expect(DEFAULT_GATES.promoBlockAt).toBeGreaterThanOrEqual(0.5);
    expect(DEFAULT_GATES.spoilerFloor).toBeGreaterThanOrEqual(0.5);
  });

  it("normalizeGates merges partial slider values over defaults", () => {
    expect(normalizeGates({ promoBlockAt: 0.9 })).toEqual({ ...DEFAULT_GATES, promoBlockAt: 0.9 });
    expect(normalizeGates()).toEqual(DEFAULT_GATES);
  });

  it("chatState rides the handle with the message, trimmed", () => {
    expect(chatState("  pokedash ", "  gg goated  ")).toBe("pokedash: gg goated");
  });
});

describe("UC#9 signalsFrom validation — declared-set discipline", () => {
  it("extracts signals from a full answer set", () => {
    const s = signalsFrom(chatAnswers({ toxicity: score(3, 0.85) }));
    expect(s).toEqual({ toxicity: 3, promo: 0.05, spoiler: 0.05, confidence: 0.85 });
  });

  it("accepts fractional toxicity inside the declared levels", () => {
    expect(signalsFrom(chatAnswers({ toxicity: score(2.5) })).toxicity).toBe(2.5);
  });

  it("throws on out-of-range or wrong-type toxicity", () => {
    expect(() => signalsFrom(chatAnswers({ toxicity: score(5) }))).toThrow(/outside the declared levels/);
    expect(() => signalsFrom(chatAnswers({ toxicity: score(-1) }))).toThrow(/outside the declared levels/);
    expect(() => signalsFrom(chatAnswers({ toxicity: score(Number.NaN) }))).toThrow(/outside the declared levels/);
    expect(() => signalsFrom(chatAnswers({ toxicity: noul(0.5) }))).toThrow(/outside the declared levels/);
    expect(() => signalsFrom({ ...chatAnswers(), toxicity: undefined })).toThrow(/outside the declared levels/);
  });

  it("throws on missing/non-probability nouls", () => {
    expect(() => signalsFrom(chatAnswers({ promo: score(1) }))).toThrow(/promo/);
    expect(() => signalsFrom(chatAnswers({ spoiler: score(1) }))).toThrow(/spoiler/);
    const bad = chatAnswers();
    delete bad.spoiler;
    expect(() => signalsFrom(bad)).toThrow(/spoiler/);
    expect(() => signalsFrom(chatAnswers({ promo: noul(1.5) }))).toThrow(/promo/);
  });

  it("defaults confidence to 0 when the score omits it — never silently trusted", () => {
    const noConf = { type: "score", score: 0.5 } as Answer;
    const s = signalsFrom(chatAnswers({ toxicity: noConf }));
    expect(s.confidence).toBe(0);
  });
});

describe("UC#9 in-code chat ladder", () => {
  it("friendly chatter → ALLOW", () => {
    const d = decideChatAction(sig({ toxicity: 0.5 }));
    expect(d.action).toBe("allow");
    expect(d.reasons[d.reasons.length - 1]).toContain("allow (reads like a real viewer");
  });

  it("toxicity at the exact blockAt boundary → BLOCK", () => {
    const d = decideChatAction(sig({ toxicity: DEFAULT_GATES.blockAt }));
    expect(d.action).toBe("block");
    expect(d.reasons.join(" ")).toMatch(/this is an attack, not chat/);
  });

  it("targeted harassment rung 4 → BLOCK", () => {
    expect(decideChatAction(sig({ toxicity: 4 })).action).toBe("block");
  });

  it("mid toxicity → HOLD (crude-but-harmless, worth a mod's eye)", () => {
    const d = decideChatAction(sig({ toxicity: 2.0 }));
    expect(d.action).toBe("hold");
    expect(d.reasons.join(" ")).toMatch(/crude-but-harmless lane/);
  });

  it("allow at the exact allowAt boundary stays ALLOW", () => {
    expect(decideChatAction(sig({ toxicity: DEFAULT_GATES.allowAt })).action).toBe("allow");
  });

  it("promo floor is ABSOLUTE — BLOCK even at friendly-tone toxicity", () => {
    const d = decideChatAction(sig({ toxicity: 0.2, promo: 0.9 }));
    expect(d.action).toBe("block");
    expect(d.reasons.join(" ")).toMatch(/friendly-voiced link that lies to you is spam/);
  });

  it("promo exactly at the floor trips the block", () => {
    expect(decideChatAction(sig({ toxicity: 0.5, promo: DEFAULT_GATES.promoBlockAt })).action).toBe("block");
  });

  it("spoiler caps an ALLOW to HOLD — hidden for a mod, never punished", () => {
    const d = decideChatAction(sig({ toxicity: 0.5, spoiler: 0.8 }));
    expect(d.action).toBe("hold");
    expect(d.reasons.join(" ")).toMatch(/spoiler never passes silently/);
    expect(d.reasons.join(" ")).toMatch(/does not punish it/);
  });

  it("spoiler exactly at the floor caps the allow", () => {
    expect(decideChatAction(sig({ toxicity: 0, spoiler: DEFAULT_GATES.spoilerFloor })).action).toBe("hold");
  });

  it("spoiler cap never touches a block base — already squashed", () => {
    const d = decideChatAction(sig({ toxicity: 4, spoiler: 0.95 }));
    expect(d.action).toBe("block");
    expect(d.reasons.join(" ")).not.toMatch(/spoiler probability/);
  });

  it("spoiler leaves a HOLD base alone — routing, not double-counting", () => {
    expect(decideChatAction(sig({ toxicity: 2, spoiler: 0.9 })).action).toBe("hold");
  });

  it("low confidence demotes ALLOW to HOLD, NEVER to BLOCK", () => {
    const d = decideChatAction(sig({ toxicity: 0.5, confidence: 0.3 }));
    expect(d.action).toBe("hold");
    expect(d.reasons.join(" ")).toMatch(/uncertain allows never pass silently/);
    // a hold base and a block base are untouched by doubt
    expect(decideChatAction(sig({ toxicity: 2, confidence: 0.1 })).action).toBe("hold");
    expect(decideChatAction(sig({ toxicity: 4, confidence: 0.1 })).action).toBe("block");
  });

  it("sliders are honored: lowering blockAt catches an attack, raising the promo floor spares a link", () => {
    const strict: ChatGates = { ...DEFAULT_GATES, blockAt: 1.5 };
    expect(decideChatAction(sig({ toxicity: 2.0 }), strict).action).toBe("block");
    const generous: ChatGates = { ...DEFAULT_GATES, promoBlockAt: 0.95 };
    expect(decideChatAction(sig({ toxicity: 0.5, promo: 0.9 }), generous).action).toBe("allow");
  });

  it("the full ladder story: ladder → promo floor → spoiler cap → confidence demotion, in order", () => {
    const d = decideChatAction(sig({ toxicity: 0.5, promo: 0.2, spoiler: 0.9, confidence: 0.99 }));
    expect(d.action).toBe("hold");
    const idxLadder = d.reasons.findIndex((r) => r.startsWith("toxicity"));
    const idxSpoiler = d.reasons.findIndex((r) => r.startsWith("spoiler"));
    expect(idxLadder).toBeLessThan(idxSpoiler);
  });
});

describe("UC#9 live single moderate (moderateChatMessage)", () => {
  it("moderates one pasted message end-to-end with the injected classifier", async () => {
    let asked: Record<string, unknown> | undefined;
    const classifyFn = (async (req: { state: string; questions: Record<string, unknown> }) => {
      asked = req.questions;
      return fakeResult(chatAnswers({ toxicity: score(4, 0.95) }));
    }) as never;

    const out = await moderateChatMessage("you're the worst, uninstall forever", "seethebot", {
      classifyFn,
    });
    expect(out.decision.action).toBe("block");
    expect(out.signals.toxicity).toBe(4);
    expect(out.model).toBe("jev-test");
    expect(out.provider).toBe("gateway");
    expect(out.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    expect(out.user).toBe("seethebot");
    expect(out.state).toBe("seethebot: you're the worst, uninstall forever");
    expect(Object.keys(asked ?? {}).sort()).toEqual(["promo", "spoiler", "toxicity"]);
  });

  it("promo floor BLOCKs a friendly-voiced scam link live", async () => {
    const classifyFn = (async () =>
      fakeResult(chatAnswers({ toxicity: score(0.2, 0.95), promo: noul(0.95) }))) as never;
    const out = await moderateChatMessage("free gifts for everyone, click here!", "kindbot", {
      classifyFn,
    });
    expect(out.decision.action).toBe("block");
  });

  it("spoiler routes a wholesome leak to HOLD live", async () => {
    const classifyFn = (async () =>
      fakeResult(chatAnswers({ toxicity: score(0.3, 0.95), spoiler: noul(0.9) }))) as never;
    const out = await moderateChatMessage("fun fact: the coach wins game 5 lol", "wikirunner", {
      classifyFn,
    });
    expect(out.decision.action).toBe("hold");
  });

  it("passes gates through and reports the effective set", async () => {
    const classifyFn = (async () => fakeResult(chatAnswers())) as never;
    const gates = normalizeGates({ blockAt: 1.5 });
    const out = await moderateChatMessage("anything", "x", { classifyFn, gates });
    expect(out.gates).toEqual(gates);
    expect(out.decision.action).toBe("block"); // toxicity 2 ≥ lowered blockAt 1.5
  });

  it("attaches the dev trace when asked, and omits it otherwise", async () => {
    const traceResult = (answers: Record<string, Answer>): ClassifyResult => ({
      ...fakeResult(answers),
      trace: { provider_used: "gateway", endpoint: "x", request: {}, attempts: [], retries: 0 },
    });
    const classifyFn = (async () => traceResult(chatAnswers())) as never;
    const dev = await moderateChatMessage("q", "a", { classifyFn, trace: true });
    expect(dev.trace).toBeDefined();
    const plain = await moderateChatMessage("q", "a", { classifyFn });
    expect(plain.trace).toBeUndefined();
  });

  it("propagates classifier errors and validator hard-fails — no silent allows", async () => {
    const boom = (async () => {
      throw new Error("gateway down");
    }) as never;
    await expect(moderateChatMessage("q", "a", { classifyFn: boom })).rejects.toThrow(/gateway down/);

    const bad = (async () => fakeResult({ toxicity: noul(0.5) })) as never;
    await expect(moderateChatMessage("q", "a", { classifyFn: bad })).rejects.toThrow(/outside the declared levels/);
  });
});

describe("UC#9 shipped corpus — one scroll of synthetic chat", () => {
  it("carries every corpus message with unique ids and non-empty parts", () => {
    const corpus = buildChatCorpus();
    expect(corpus.length).toBe(chatMessages.length);
    expect(corpus.length).toBe(28);
    const ids = corpus.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of corpus) {
      expect(c.user.trim().length).toBeGreaterThan(0);
      expect(c.message.trim().length).toBeGreaterThan(0);
      expect(c.state).toBe(`${c.user}: ${c.message}`);
    }
  });

  it("covers every species the filter must catch — hype, attacks, spam, spoilers", () => {
    const all = buildChatCorpus();
    const has = (re: RegExp) => all.some((c) => re.test(c.message));
    expect(has(/\bgg\b|POG|love the vibes/i)).toBe(true); // friendly hype
    expect(has(/follow for follow|FREE FOLLOWERS|dm 'CASH'/i)).toBe(true); // spam bots
    expect(has(/closed it out 3-1|waterfall door|wins the revote/i)).toBe(true); // spoilers
    expect(has(/uninstall forever|incompetent/i)).toBe(true); // attacks
    // the whole point of the corpus: one stream, all four jobs at once
  });

  it("every handle is synthetic — no real channel or link in the scroll", () => {
    for (const c of buildChatCorpus()) {
      expect(c.message).not.toMatch(/https?:\/\//);
      expect(c.message).not.toMatch(/twitch\.tv|kick\.com|youtube\.com/);
    }
  });
});

describe("UC#9 per-user offender rollup", () => {
  const item = (user: string, action?: ChatAction, error?: string): ChatBatchItem => ({
    id: `${user}-${Math.random()}`,
    user,
    message: "m",
    ...(action ? { action } : {}),
    ...(error ? { error } : {}),
  });

  it("only non-allow users appear; blocks dominate holds; total order on ties", () => {
    const rows = chatOffenders([
      item("goodvibes", "allow"),
      item("botnet", "block"),
      item("botnet", "block"),
      item("meanone", "block"),
      item("meanone", "block"),
      item("twistcat", "hold"),
      item("twistcat", "hold"),
      item("quiet", "hold"),
      item("grumbler", "hold"),
    ]);
    expect(rows.map((r) => r.user)).toEqual(["botnet", "meanone", "twistcat", "grumbler", "quiet"]);
    expect(rows[0]).toEqual({ user: "botnet", holds: 0, blocks: 2, score: 20 });
    expect(rows.find((r) => r.user === "goodvibes")).toBeUndefined();
    // band dominance BY CONSTRUCTION: 2 holds (score 2) can never outrank 2 blocks (score 20)
    expect(rows[2].score).toBeLessThan(rows[0].score);
  });

  it("one block outranks nine holds — the band ALWAYS dominates", () => {
    const many = [item("spammy", "block"), ...Array.from({ length: 9 }, () => item("whiny", "hold"))];
    expect(chatOffenders(many)[0].user).toBe("spammy");
  });

  it("errored items never enter the rollup — counted elsewhere, never punished", () => {
    const rows = chatOffenders([item("crashy", undefined, "gateway down")]);
    expect(rows).toEqual([]);
  });

  it("a clean stream has no offenders", () => {
    expect(chatOffenders([item("a", "allow"), item("b", "allow")])).toEqual([]);
  });
});

describe("UC#9 runChatBatch (ladder 5 → 10 → All + tallies + rollup)", () => {
  // 15 synthetic messages exercising every rung of the shipped ladder.
  const corpus = [
    { id: "t01", user: "hype_a", message: "gg so hyped" },
    { id: "t02", user: "botnet", message: "PROMO free followers click" },
    { id: "t03", user: "twistcat", message: "SPOIL the match ends 3-1" },
    { id: "t04", user: "hype_b", message: "POG that ace" },
    { id: "t05", user: "meanone", message: "ATTACK you are trash uninstall" },
    { id: "t06", user: "quiet", message: "DOUBT nice play ig" },
    { id: "t07", user: "hype_a", message: "BOOM this one dies at the gateway" },
    { id: "t08", user: "hype_b", message: "what a read" },
    { id: "t09", user: "grumbler", message: "CRUDE map is trash change it" },
    { id: "t10", user: "hype_a", message: "love this crew" },
    { id: "t11", user: "botnet", message: "PROMO dm cash for the secret" },
    { id: "t12", user: "twistcat", message: "SPOIL final boss behind the door" },
    { id: "t13", user: "hype_b", message: "gg wp" },
    { id: "t14", user: "meanone", message: "ATTACK worst player alive" },
    { id: "t15", user: "hype_a", message: "great stream as always" },
  ];

  async function fakeClassify(req: { state: string }): Promise<ClassifyResult> {
    if (req.state.includes("BOOM")) throw new Error("gateway down for t07");
    if (req.state.includes("PROMO")) {
      return fakeResult(chatAnswers({ toxicity: score(0.2, 0.95), promo: noul(0.9) }));
    }
    if (req.state.includes("SPOIL")) {
      return fakeResult(chatAnswers({ toxicity: score(0.4, 0.95), spoiler: noul(0.85) }));
    }
    if (req.state.includes("ATTACK")) {
      return fakeResult(chatAnswers({ toxicity: score(4, 0.95) }));
    }
    if (req.state.includes("DOUBT")) {
      return fakeResult(chatAnswers({ toxicity: score(0.4, 0.2) }));
    }
    if (req.state.includes("CRUDE")) {
      return fakeResult(chatAnswers({ toxicity: score(2.2, 0.9) }));
    }
    return fakeResult(chatAnswers({ toxicity: score(0.3, 0.95) }));
  }
  const fakeFn = fakeClassify as never;

  it("processes the first ladder rung by default — exact tallies, no errors yet", async () => {
    const rep = await runChatBatch(corpus, { classifyFn: fakeFn });
    expect(rep.items.length).toBe(5);
    expect(rep.totals).toMatchObject({
      moderated: 5,
      errors: 0,
      actions: { allow: 2, hold: 1, block: 2 },
      usage: { input_tokens: 50, output_tokens: 25 },
    });
  });

  it("rung 10 isolates the boom to its own message and counts it", async () => {
    const rep = await runChatBatch(corpus, { classifyFn: fakeFn, limit: 10 });
    expect(rep.items.length).toBe(10);
    expect(rep.totals.moderated).toBe(10);
    expect(rep.totals.errors).toBe(1);
    expect(rep.totals.actions).toEqual({ allow: 4, hold: 3, block: 2 });
    const boom = rep.items.find((i) => i.id === "t07")!;
    expect(boom.error).toMatch(/gateway down/);
    expect(boom.action).toBeUndefined();
    // the rest of the stream keeps flowing while one message dies
    expect(rep.items.filter((i) => !i.error).length).toBe(9);
  });

  it("All walks the whole scroll with exact tallies, usage, and the offender rollup", async () => {
    const rep = await runChatBatch(corpus, { classifyFn: fakeFn, limit: null });
    expect(rep.items.length).toBe(15);
    expect(rep.totals.actions).toEqual({ allow: 6, hold: 4, block: 4 });
    expect(rep.totals.errors).toBe(1);
    expect(rep.totals.usage).toEqual({ input_tokens: 140, output_tokens: 70 });
    expect(rep.offenders.map((o) => o.user)).toEqual([
      "botnet",
      "meanone",
      "twistcat",
      "grumbler",
      "quiet",
    ]);
    expect(rep.offenders[0]).toEqual({ user: "botnet", holds: 0, blocks: 2, score: 20 });
    // clean chatgoers never appear in the rollup
    expect(rep.offenders.some((o) => o.user.startsWith("hype"))).toBe(false);
  });

  it("limits beyond the scroll clamp to All, and 0 moderates nothing", async () => {
    let calls = 0;
    const counting = (async (req: { state: string }) => {
      calls += 1;
      return fakeClassify(req);
    }) as never;
    const big = await runChatBatch(corpus, { classifyFn: counting, limit: 999 });
    expect(big.items.length).toBe(15);
    const zero = await runChatBatch(corpus, { classifyFn: counting, limit: 0 });
    expect(zero.items.length).toBe(0);
    expect(zero.totals).toMatchObject({ moderated: 0, errors: 0 });
    expect(zero.offenders).toEqual([]);
    expect(calls).toBe(15);
  });

  it("an empty scroll never calls the classifier and reports zeros", async () => {
    let calls = 0;
    const counting = (async () => {
      calls += 1;
      return fakeResult(chatAnswers());
    }) as never;
    const rep = await runChatBatch([], { classifyFn: counting });
    expect(calls).toBe(0);
    expect(rep.totals).toEqual({
      moderated: 0,
      errors: 0,
      actions: { allow: 0, hold: 0, block: 0 },
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  });

  it("gate sliders ride every message and echo back in the report", async () => {
    const rep = await runChatBatch(corpus, {
      classifyFn: fakeFn,
      limit: null,
      gates: { blockAt: 3.5, spoilerFloor: 0.95 },
    });
    expect(rep.gates).toEqual(normalizeGates({ blockAt: 3.5, spoilerFloor: 0.95 }));
    // spoilerFloor 0.95 > the fake 0.85 answers: both SPOIL messages now flow clean
    expect(rep.items.find((i) => i.id === "t03")!.action).toBe("allow");
    expect(rep.model).toBe("jev-test");
    expect(rep.provider).toBe("gateway");
  });

  it("users default to 'viewer' when the batch line omits a handle", async () => {
    const rep = await runChatBatch([{ id: "x1", message: "ATTACK hi" }], { classifyFn: fakeFn });
    expect(rep.items[0].user).toBe("viewer");
  });

  it("the shipped scroll walks the ladder: spam BLOCKs, spoilers HOLD, hype ALLOWs", async () => {
    const shippedFake = (async (req: { state: string }) => {
      if (/follow for follow|FREE FOLLOWERS|dm 'CASH'|giveaway|password|check my profile/i.test(req.state)) {
        return fakeResult(chatAnswers({ toxicity: score(0.5, 0.95), promo: noul(0.95) }));
      }
      if (/closed it out|waterfall door|wins the revote|throwing games/i.test(req.state)) {
        return fakeResult(chatAnswers({ toxicity: score(0.5, 0.95), spoiler: noul(0.9) }));
      }
      if (/uninstall forever|incompetent|cesspool/i.test(req.state)) {
        return fakeResult(chatAnswers({ toxicity: score(4, 0.95) }));
      }
      return fakeResult(chatAnswers({ toxicity: score(0.3, 0.95) }));
    }) as never;
    const rep = await runChatBatch(buildChatCorpus(), { classifyFn: shippedFake, limit: null });
    expect(rep.totals.moderated).toBe(28);
    expect(rep.totals.errors).toBe(0);
    const action = (id: string) => rep.items.find((i) => i.id === id)!.action;
    expect(action("c01")).toBe("allow"); // gg hype
    expect(action("c05")).toBe("block"); // free-followers bot, friendly-voiced link
    expect(action("c08")).toBe("hold"); // "closed it out 3-1" spoiler
    expect(action("c13")).toBe("block"); // personal attack at rung 4
    expect(action("c15")).toBe("block"); // f4f spam
    expect(action("c17")).toBe("hold"); // waterfall-door spoiler
    expect(action("c24")).toBe("allow"); // cheer hype
    // the rollup names the timeout candidates by handle
    expect(rep.offenders[0].blocks).toBeGreaterThanOrEqual(1);
  });
});

describe("UC#9 batch discipline deepening — repeat-offender strike ledger", () => {
  const item = (
    id: string,
    user: string,
    action?: ChatAction,
    error?: string,
  ): ChatBatchItem => ({
    id,
    user,
    message: "m",
    ...(action ? { action } : {}),
    ...(error ? { error } : {}),
  });

  it("strike ladder is strictly ordered watch < timeout < ban", () => {
    expect(CHAT_STRIKE_STATES).toEqual(["watch", "timeout", "ban"]);
    expect(CHAT_STRIKE_RANK.watch).toBeLessThan(CHAT_STRIKE_RANK.timeout);
    expect(CHAT_STRIKE_RANK.timeout).toBeLessThan(CHAT_STRIKE_RANK.ban);
    for (const s of CHAT_STRIKE_STATES) expect(CHAT_STRIKE_NOTE[s]).toMatch(/\w/);
  });

  it("badge classes: watch warns, timeout/ban are bad", () => {
    expect(chatStrikeBadgeClass("watch")).toBe("warn");
    expect(chatStrikeBadgeClass("timeout")).toBe("bad");
    expect(chatStrikeBadgeClass("ban")).toBe("bad");
  });

  it("normalizeStrikeGates merges partials over defaults", () => {
    expect(normalizeStrikeGates()).toEqual(DEFAULT_STRIKE_GATES);
    expect(normalizeStrikeGates({ banBlocks: 1 })).toEqual({
      ...DEFAULT_STRIKE_GATES,
      banBlocks: 1,
    });
    expect(DEFAULT_STRIKE_GATES.banBlocks).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_STRIKE_GATES.burstAt).toBeGreaterThanOrEqual(1);
  });

  it("first fold: one hold watches, one block times out, two blocks ban", () => {
    const watch = applyChatStrikes([], [item("s1", "grumbler", "hold")]);
    expect(watch.rows[0]).toMatchObject({ user: "grumbler", holds: 1, blocks: 0, state: "watch", score: 1 });
    const timeout = applyChatStrikes([], [item("s2", "meanone", "block")]);
    expect(timeout.rows[0]).toMatchObject({ blocks: 1, holds: 0, state: "timeout", score: 10 });
    const ban = applyChatStrikes(
      timeout.rows,
      [item("s3", "meanone", "block")],
    );
    expect(ban.rows[0]).toMatchObject({ blocks: 2, state: "ban" });
  });

  it("TEMPO ALONE NEVER BANS — burst holds can reach timeout but never the ban lane", () => {
    // three scrolls where one handle posts > burstAt messages, every
    // message individually ALLOWed: speed is suspicious, not attacking.
    let rows: ChatStrikeRow[] = [];
    for (let scroll = 0; scroll < 3; scroll += 1) {
      const burst = Array.from({ length: 5 }, (_, i) =>
        item(`f${scroll}-${i}`, "hypehydra", "allow"),
      );
      rows = applyChatStrikes(rows, burst).rows;
    }
    expect(rows).toHaveLength(1);
    const hydra = rows[0];
    expect(hydra.bursts).toBe(3);
    expect(hydra.holds).toBe(3); // each burst scroll feeds exactly one hold
    expect(hydra.blocks).toBe(0);
    expect(hydra.state).toBe("timeout"); // sustained tempo…
    expect(hydra.state).not.toBe("ban"); // …but a ban needs REAL blocks
    expect(hydra.reasons.some((r) => /burst scrolls 3/.test(r))).toBe(true);
  });

  it("sustained holds without a block cap out at timeout, never ban", () => {
    let rows: ChatStrikeRow[] = [];
    rows = applyChatStrikes(rows, [item("h1", "twistcat", "hold"), item("h2", "twistcat", "hold")]).rows;
    expect(rows[0].state).toBe("watch");
    rows = applyChatStrikes(rows, [item("h3", "twistcat", "hold")]).rows;
    expect(rows[0]).toMatchObject({ holds: 3, blocks: 0, state: "timeout" });
    rows = applyChatStrikes(rows, Array.from({ length: 9 }, (_, i) => item(`h4-${i}`, "twistcat", "hold"))).rows;
    expect(rows[0].state).toBe("timeout"); // twelve holds, zero blocks — still not a ban
  });

  it("escalation never de-escalates — a quiet fold never wipes an earned ban", () => {
    let rows: ChatStrikeRow[] = [];
    rows = applyChatStrikes(rows, [item("b1", "botnet", "block")]).rows;
    rows = applyChatStrikes(rows, [item("b2", "botnet", "block")]).rows;
    expect(rows[0].state).toBe("ban");
    const quiet = applyChatStrikes(rows, [item("b3", "botnet", "allow")]);
    expect(quiet.rows[0].state).toBe("ban"); // amnesty is an explicit mod call
    expect(quiet.rows[0].holds).toBe(0); // the clean message fed nothing punitive
    // the monotonic guard also survives a STRICTER gate applied later:
    // raising banBlocks to 3 would demote the recomputed ladder to
    // timeout — the prior state is kept and the reason says so.
    const stricter = applyChatStrikes(rows, [item("b4", "botnet", "allow")], { banBlocks: 3 });
    expect(stricter.rows[0].state).toBe("ban");
    expect(stricter.rows[0].reasons.some((r) => /prior state ban kept/.test(r))).toBe(true);
  });

  it("errored items are excluded and counted, never silently dropped", () => {
    const ledger = applyChatStrikes([], [
      item("e1", "crashy", undefined, "gateway down"),
      item("e2", "spammy", "block"),
      item("e3", "spammy", "hold"),
    ]);
    expect(ledger.errors).toBe(1);
    expect(ledger.folded).toBe(2);
    expect(ledger.rows.map((r) => r.user)).toEqual(["spammy"]);
    // errored messages never feed the burst counter either
    const burstOnly = applyChatStrikes([], Array.from({ length: 6 }, (_, i) =>
      item(`x${i}`, "flaky", undefined, "boom"),
    ));
    expect(burstOnly.errors).toBe(6);
    expect(burstOnly.rows).toEqual([]);
  });

  it("clean chatgoers never appear on the board", () => {
    const ledger = applyChatStrikes([], [item("g1", "goodvibes", "allow"), item("g2", "another", "allow")]);
    expect(ledger.rows).toEqual([]);
    expect(ledger.folded).toBe(2);
  });

  it("total order: score desc → holds desc → user asc; deterministic under input order", () => {
    const a = applyChatStrikes([], [
      item("o1", "botnet", "block"),
      item("o2", "botnet", "block"),
      item("o3", "grumbler", "hold"),
      item("o4", "quiet", "hold"),
      item("o5", "twistcat", "hold"),
      item("o6", "twistcat", "hold"),
    ]);
    expect(a.rows.map((r) => r.user)).toEqual(["botnet", "twistcat", "grumbler", "quiet"]);
    // determinism: same set, shuffled input
    const shuffled = applyChatStrikes([], [
      item("o3", "grumbler", "hold"),
      item("o6", "twistcat", "hold"),
      item("o1", "botnet", "block"),
      item("o5", "twistcat", "hold"),
      item("o4", "quiet", "hold"),
      item("o2", "botnet", "block"),
    ]);
    expect(shuffled.rows.map((r) => r.user)).toEqual(a.rows.map((r) => r.user));
  });

  it("gates are honored: a stricter ban gate bans on the first block", () => {
    const ledger = applyChatStrikes([], [item("c1", "meanone", "block")], { banBlocks: 1 });
    expect(ledger.rows[0].state).toBe("ban");
    // with a stricter burst limit the tempo discipline fires earlier
    const bursty = applyChatStrikes([], Array.from({ length: 2 }, (_, i) => item(`k${i}`, "hypehydra", "allow")), { burstAt: 1 });
    expect(bursty.rows[0].bursts).toBe(1);
    expect(bursty.rows[0].holds).toBe(1);
  });

  it("applyChatStrikes is pure — previous rows are never mutated", () => {
    const first = applyChatStrikes([], [item("p1", "spammy", "block")]);
    const frozen = JSON.parse(JSON.stringify(first.rows));
    applyChatStrikes(first.rows, [item("p2", "spammy", "block"), item("p3", "newbie", "hold")]);
    expect(first.rows).toEqual(frozen);
  });

  it("strike export rows: stable column order through the D8 pipeline", () => {
    const ledger = applyChatStrikes([], [
      item("d1", "botnet", "block"),
      item("d2", "botnet", "block"),
      item("d3", "grumbler", "hold"),
    ]);
    const rows = chatStrikeExportRows(ledger.rows);
    expect(Object.keys(rows[0])).toEqual(["rank", "user", "holds", "blocks", "bursts", "score", "state"]);
    expect(rows[0].rank).toBe(1);
    expect(rows[0].user).toBe("botnet");
    expect(rows[0].state).toBe("ban");
    expect(rows[1]).toMatchObject({ rank: 2, user: "grumbler", state: "watch" });
    const csv = toCSV(rows);
    expect(csv.split("\r\n")[0]).toBe("rank,user,holds,blocks,bursts,score,state");
    expect(csv).toContain("ban");
  });

  it("offender export rows: rank rides the rollup order through the D8 pipeline", () => {
    const rows = chatOffenderExportRows(chatOffenders([
      item("r1", "botnet", "block"),
      item("r2", "twistcat", "hold"),
    ]));
    expect(Object.keys(rows[0])).toEqual(["rank", "user", "holds", "blocks", "score"]);
    expect(rows[0]).toMatchObject({ rank: 1, user: "botnet", blocks: 1, score: 10 });
    expect(rows[1]).toMatchObject({ rank: 2, user: "twistcat", holds: 1, score: 1 });
    const csv = toCSV(rows);
    expect(csv.split("\r\n")[0]).toBe("rank,user,holds,blocks,score");
  });

  it("end-to-end: two ladder rungs folded in sequence escalate the bot net to a ban IN CODE", async () => {
    const fake = (req: { state: string }) =>
      req.state.includes("PROMO")
        ? fakeResult(chatAnswers({ promo: noul(0.95) }))
        : fakeResult(chatAnswers());
    // scroll one: bots and a spoiler
    const rep1 = await runChatBatch(
      [
        { id: "w1", user: "botnet", message: "PROMO free followers click" },
        { id: "w2", user: "botnet", message: "PROMO type your password" },
        { id: "w3", user: "twistcat", message: "the boss is behind the waterfall door" },
      ],
      { classifyFn: fake as never, limit: null },
    );
    expect(rep1.offenders.map((o) => o.user)).toEqual(["botnet", "twistcat"]);
    const ledger1 = applyChatStrikes([], rep1.items);
    expect(ledger1.rows.find((r) => r.user === "botnet")?.state).toBe("ban"); // 2 blocks already
    // scroll two: more noise, the ledger REMEMBERS — nothing de-escalates
    const rep2 = await runChatBatch(
      [
        { id: "w4", user: "twistcat", message: "PROMO f4f gang" },
        { id: "w5", user: "hype_llama", message: "POG" },
      ],
      { classifyFn: fake as never, limit: null },
    );
    const ledger2 = applyChatStrikes(ledger1.rows, rep2.items);
    expect(ledger2.rows.find((r) => r.user === "botnet")?.state).toBe("ban");
    expect(ledger2.rows.find((r) => r.user === "twistcat")?.blocks).toBe(1);
    expect(ledger2.rows[0].user).toBe("botnet"); // worst first, bands dominant
    expect(ledger2.folded).toBe(2);
    // export the whole board through D8
    const csv = toCSV(chatStrikeExportRows(ledger2.rows));
    expect(csv).toContain("state");
    expect(csv.split("\r\n")).toHaveLength(ledger2.rows.length + 1);
  });
});
