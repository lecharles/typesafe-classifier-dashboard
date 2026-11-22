import { classify } from "@/lib/classify";
import { BATCH_LADDER } from "@/lib/dispatch";
import { entityPairs, type EntityPair, type EntityRecord } from "@/data/entity-corpus";
import type { ExportRow } from "@/lib/export";
import type { ClassifyResult, Provider, Question, Usage } from "@/lib/schema";

/** Re-exported for API/UI consumers — a node in the alignment graph. */
export type { EntityRecord, EntityPair } from "@/data/entity-corpus";

/**
 * UC#10 (11-23 on the calendar, shipped 11-22 one day ahead): entity
 * alignment / dedup — ROADMAP-V2 Track C item 10, "are these two records
 * the same product? (Score + Nouls)".
 *
 * A marketplace that grew without identity management has the same
 * product under a dozen listings — and its neighbor, a SIBLING MODEL
 * that looks almost identical and is NOT the same thing. A free-model
 * "just merge the dupes" answer is how records get destroyed, so this
 * lane keeps every verdict IN CODE from typed classifier answers:
 *
 *   similarity   → Score  five rungs, clearly different … same listing
 *   conflict     → Noul   explicitly contradictory identifiers (model,
 *                        capacity, quantity, edition, format, year)
 *   genericName  → Noul   the match rests on a generic name — no
 *                        distinctive identifier either side to lean on
 *
 * Verdicts are distinct / review / merge, ranked by how much the CODE
 * commits: distinct claims "not the same record", review claims nothing
 * and queues a human, merge is the destructive lane — it rewrites
 * records — so it wears the alert badge, exactly like memory's forget.
 * Rule order mirrors the family ladder with one inversion the data
 * steward needs: the CONFIRMED floor pushes toward the SAFE lane.
 *
 *   similarity ladder → conflict floor (absolute — records that openly
 *   disagree are different products no matter how alike their names
 *   sound; separation destroys nothing, so the floor talks and doubt
 *   doesn't) → generic-name cap (a name-only match never merges on its
 *   own — it ROUTES to the human lane, it never separates: weak
 *   evidence of same is not evidence of different) → confidence
 *   demotion (an uncertain join never happens silently; doubt routes
 *   toward review and can NEVER lift a pair into the destructive merge
 *   lane and never pushes one into a definitive split).
 *
 * The alignment half: merge edges then fold into clusters — union over
 * the strongest evidence first, transitive but NEVER contradicting a
 * separation the code already called. A refused join is logged, never
 * silently folded. Batch discipline holds lane-wide: 5 → 10 → All over
 * the 25-pair market audit (data/entity-corpus.ts), per-pair error
 * isolation, offender-grade exports through the D8 pipeline.
 */

/* ------------------------------------------------------------------ *
 * Verdicts (alignment dispositions).
 * ------------------------------------------------------------------ */

export const ENTITY_VERDICTS = ["distinct", "review", "merge"] as const;
export type EntityVerdict = (typeof ENTITY_VERDICTS)[number];

/**
 * Rank orders how much the code COMMITS to an answer: distinct separates,
 * review defers, merge rewrites. merge sits on top because it is the
 * destructive lane — the only verdict that can destroy information —
 * and it is therefore the hardest to earn: floors and caps only ever
 * move a pair OUT of merge, never in.
 */
export const ENTITY_RANK: Record<EntityVerdict, number> = {
  distinct: 0,
  review: 1,
  merge: 2,
};

export const ENTITY_NOTE: Record<EntityVerdict, string> = {
  distinct: "kept apart — nothing merged, nothing lost",
  review: "held for a human — the evidence never reached the join lane",
  merge: "same entity — records fold together; the destructive lane, earned only by clean strong evidence",
};

/** merge wears the alert color on purpose: it is where a wrong call costs data. */
export function entityBadgeClass(v: EntityVerdict): "good" | "warn" | "bad" {
  return v === "distinct" ? "good" : v === "review" ? "warn" : "bad";
}

function clampRank(v: number): EntityVerdict {
  return ENTITY_VERDICTS[Math.min(Math.max(0, v), ENTITY_VERDICTS.length - 1)];
}

/* ------------------------------------------------------------------ *
 * The typed questions — one set, every pair.
 * ------------------------------------------------------------------ */

/** 0 clearly different … 4 same listing — the five-rung similarity ladder. */
export const SIMILARITY_LEVELS = [
  "clearly different",
  "same category",
  "plausible twin",
  "strong match",
  "same listing",
];

export function entityQuestions(): Record<string, Question> {
  return {
    similarity: {
      type: "score",
      instructions:
        "How similar are these two marketplace records as PRODUCT IDENTITIES — from clearly different things, through the same category, a plausible twin, a strong match, to plainly the same listing written twice?",
      criteria: SIMILARITY_LEVELS,
    },
    conflict: {
      type: "noul",
      instructions:
        "Do the two records state EXPLICITLY contradictory identity identifiers — model number, edition, capacity, quantity, format, or year — that cannot both be true of one product (a 12 and a 12 Pro, a single and a 2-pack, a paperback and a hardcover)? Cosmetic wording, condition, and price differences are NOT conflicts. True = hard contradiction, false = compatible.",
      criteria: { true: "identifiers openly disagree", false: "identifiers are compatible" },
    },
    genericName: {
      type: "noul",
      instructions:
        "Does any apparent match rest ONLY on a generic name — a bare category phrase like 'wireless earbuds' with no distinctive model number or SKU on either side that pins down WHICH product it is? True = generic-name collision, false = a distinctive identifier anchors the match.",
      criteria: { true: "name is generic", false: "distinctive identifiers present" },
    },
  };
}

/* ------------------------------------------------------------------ *
 * Signals + gates.
 * ------------------------------------------------------------------ */

export type EntitySignals = {
  /** similarity level index (fractional values allowed, as Jev scores) */
  similarity: number;
  /** probability of an explicit identifier contradiction */
  conflict: number;
  /** probability the match rests on a generic name alone */
  genericName: number;
  /** classification confidence (the similarity Score's confidence) */
  confidence: number;
};

export type EntityGates = {
  /** similarity at or above which a clean pair may MERGE. */
  mergeAt: number;
  /** similarity at or below which the pair is DISTINGUISHED as different. */
  distinctAt: number;
  /** conflict probability at or above which the pair FORCES distinct, whatever the ladder says. */
  conflictFloor: number;
  /** genericName probability at or above which a MERGE is capped to REVIEW. */
  collisionCap: number;
  /** confidence below which a MERGE is demoted to REVIEW (never silently joined). */
  lowConfBump: number;
};

export const DEFAULT_GATES: EntityGates = {
  mergeAt: 3.5,
  distinctAt: 1.0,
  conflictFloor: 0.6,
  collisionCap: 0.6,
  lowConfBump: 0.6,
};

/** Merge partial slider values over the shipped gate defaults. */
export function normalizeGates(partial?: Partial<EntityGates>): EntityGates {
  return { ...DEFAULT_GATES, ...(partial ?? {}) };
}

export type EntityDecision = {
  verdict: EntityVerdict;
  reasons: string[];
};

/* ------------------------------------------------------------------ *
 * Answer validation — dispatcher discipline: anything outside the
 * declared level set or a non-probability Noul is a hard error.
 * ------------------------------------------------------------------ */

export function signalsFrom(answers: Record<string, unknown>): EntitySignals {
  const similarity = answers.similarity as
    | { type?: string; score?: number; confidence?: number }
    | undefined;
  if (
    similarity?.type !== "score" ||
    typeof similarity.score !== "number" ||
    !Number.isFinite(similarity.score) ||
    similarity.score < 0 ||
    similarity.score >= SIMILARITY_LEVELS.length
  ) {
    throw new Error("entities: similarity score is outside the declared levels");
  }
  const conflict = answers.conflict as { type?: string; noul?: number } | undefined;
  if (
    conflict?.type !== "noul" ||
    typeof conflict.noul !== "number" ||
    !Number.isFinite(conflict.noul) ||
    conflict.noul < 0 ||
    conflict.noul > 1
  ) {
    throw new Error("entities: conflict answer missing or not a probability");
  }
  const genericName = answers.genericName as { type?: string; noul?: number } | undefined;
  if (
    genericName?.type !== "noul" ||
    typeof genericName.noul !== "number" ||
    !Number.isFinite(genericName.noul) ||
    genericName.noul < 0 ||
    genericName.noul > 1
  ) {
    throw new Error("entities: genericName answer missing or not a probability");
  }
  return {
    similarity: similarity.score,
    conflict: conflict.noul,
    genericName: genericName.noul,
    confidence: similarity.confidence ?? 0,
  };
}

/* ------------------------------------------------------------------ *
 * Pure in-code verdict ladder.
 * ------------------------------------------------------------------ */

/**
 * distinct / review / merge decided in code. Rule order is the safety
 * story: similarity ladder → conflict floor (absolute) → generic-name
 * cap → confidence demotion. The destructive lane (merge) is the only
 * lane NO floor, cap, or doubt can ever lift a pair INTO — only the
 * clean ladder can reach it, and every escape hatch routes toward the
 * human lane or the safe lane, never past either.
 */
export function decideEntityVerdict(
  s: EntitySignals,
  gates: EntityGates = DEFAULT_GATES,
): EntityDecision {
  const reasons: string[] = [];

  // Similarity ladder — the base rung.
  let rank: number;
  if (s.similarity >= gates.mergeAt) {
    rank = ENTITY_RANK.merge;
    reasons.push(
      `similarity ${s.similarity.toFixed(1)} ≥ merge gate ${gates.mergeAt} — the ladder puts this pair in the join lane`,
    );
  } else if (s.similarity <= gates.distinctAt) {
    rank = ENTITY_RANK.distinct;
    reasons.push(
      `similarity ${s.similarity.toFixed(1)} ≤ distinct gate ${gates.distinctAt} — these are not the same record`,
    );
  } else {
    rank = ENTITY_RANK.review;
    reasons.push(
      `similarity ${s.similarity.toFixed(1)} between distinct ${gates.distinctAt} and merge ${gates.mergeAt} — plausible-but-unproven, the human lane`,
    );
  }

  // Conflict floor is absolute — and it points at the SAFE lane. Records
  // that openly disagree on identity are different products whatever the
  // name says; separation destroys nothing, so hard EVIDENCE is allowed
  // to talk all the way down to distinct. Doubt never gets that power.
  if (s.conflict >= gates.conflictFloor) {
    rank = Math.min(rank, ENTITY_RANK.distinct);
    reasons.push(
      `conflict probability ${s.conflict.toFixed(2)} ≥ floor ${gates.conflictFloor.toFixed(2)} — identifiers openly disagree (a 12 and a 12 Pro are two products); the pair is FORCED apart, whatever the similarity ladder says, and separation costs nothing`,
    );
  }

  // Generic-name cap — a name-only match never merges on its own. The
  // cap ROUTES to the human lane; it never separates: weak evidence of
  // same is not evidence of different. A review/distinct base is left
  // alone — same routing-not-double-counting discipline as the spoiler cap.
  if (s.genericName >= gates.collisionCap && rank === ENTITY_RANK.merge) {
    rank = ENTITY_RANK.review;
    reasons.push(
      `generic-name probability ${s.genericName.toFixed(2)} ≥ cap ${gates.collisionCap.toFixed(2)} — a bare category name is weak evidence of same, not evidence of different; the join is capped to review, a human decides`,
    );
  }

  // Confidence demotion — an uncertain join never happens silently.
  // Doubt routes toward review; it can never lift a pair INTO the
  // destructive merge lane and never pushes one into a definitive split.
  if (s.confidence < gates.lowConfBump && rank === ENTITY_RANK.merge) {
    rank = ENTITY_RANK.review;
    reasons.push(
      `similarity confidence ${s.confidence.toFixed(2)} below ${gates.lowConfBump.toFixed(2)} — an uncertain merge never happens silently; doubt routes to the human, never into the join lane and never into a forced split`,
    );
  }

  const verdict = clampRank(rank);
  reasons.push(`entity verdict: ${verdict} (${ENTITY_NOTE[verdict]})`);
  return { verdict, reasons };
}

/* ------------------------------------------------------------------ *
 * State composition — the classifier sees BOTH records, serialized.
 * ------------------------------------------------------------------ */

/** Serialize one marketplace record into a compact identity line. */
export function recordText(r: EntityRecord): string {
  return [
    r.name.trim(),
    r.brand?.trim() ? `brand: ${r.brand.trim()}` : "",
    r.model?.trim() ? `model: ${r.model.trim()}` : "",
    r.detail?.trim() ? `detail: ${r.detail.trim()}` : "",
  ]
    .filter(Boolean)
    .join("; ");
}

/** Wire-state handed to the classifier: record A beside record B. */
export function pairState(a: EntityRecord, b: EntityRecord): string {
  return `RECORD A (${a.id.trim()}): ${recordText(a)}\nRECORD B (${b.id.trim()}): ${recordText(b)}`;
}

/* ------------------------------------------------------------------ *
 * Live single pair: one classify call, verdict decided in code.
 * ------------------------------------------------------------------ */

export type AlignedPair = {
  a: EntityRecord;
  b: EntityRecord;
  state: string;
  signals: EntitySignals;
  decision: EntityDecision;
  gates: EntityGates;
  model: string;
  provider: Provider;
  usage: Usage;
  trace?: unknown;
};

export type AlignOptions = {
  classifyFn?: typeof classify;
  gates?: EntityGates;
  trace?: boolean;
};

/**
 * Align two pasted records. The verdict is the identical code ladder
 * the batch path walks — nothing about merging is asked of the model.
 */
export async function alignEntityPair(
  a: EntityRecord,
  b: EntityRecord,
  opts: AlignOptions = {},
): Promise<AlignedPair> {
  const run = opts.classifyFn ?? classify;
  const gates = opts.gates ?? DEFAULT_GATES;
  const state = pairState(a, b);

  const res: ClassifyResult = await run(
    { state, questions: entityQuestions() },
    opts.trace ? { trace: true } : {},
  );

  const signals = signalsFrom(res.answers);
  const decision = decideEntityVerdict(signals, gates);

  return {
    a,
    b,
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
 * The shipped corpus: one market audit of candidate pairs.
 * ------------------------------------------------------------------ */

export type EntityCorpusItem = {
  id: string;
  a: EntityRecord;
  b: EntityRecord;
  state: string;
};

/** Build the audit: every shipped pair, both records riding their state. */
export function buildEntityCorpus(pairs: EntityPair[] = entityPairs): EntityCorpusItem[] {
  return pairs.map((p) => ({
    id: p.id,
    a: p.a,
    b: p.b,
    state: pairState(p.a, p.b),
  }));
}

/* ------------------------------------------------------------------ *
 * Cluster folding — the ALIGNMENT half, decided in code.
 *
 * Merge edges are transitive: if A=B and B=C both earned the join lane,
 * A/B/C are one entity. But a chain NEVER overrules a separation the
 * code already called: if any cross-cluster pair was judged distinct,
 * the join is REFUSED and logged — a refused edge is a data bug in the
 * classifier's inputs or an interesting human question, never something
 * to silently fold. Edges are processed strongest-evidence-first
 * (similarity desc, pair id asc) so the order is total and the result
 * deterministic under any input order. Only merge edges ever join;
 * review edges defer, distinct edges separate, errored items are
 * excluded and COUNTED elsewhere (totals.errors).
 * ------------------------------------------------------------------ */

export type EntityCluster = {
  /** lowest member record id — stable, deterministic */
  canonical: string;
  members: string[];
  /** pair ids that folded into this cluster, sorted */
  edges: string[];
};

export type BlockedJoin = {
  pairId: string;
  a: string;
  b: string;
  reason: string;
};

export type EntityFold = {
  clusters: EntityCluster[];
  blocked: BlockedJoin[];
};

function edgeKey(x: string, y: string): string {
  return x < y ? `${x}\u0000${y}` : `${y}\u0000${x}`;
}

/**
 * Fold merge-verdict items into clusters with contradiction refusal.
 * Pure — inputs are never mutated.
 */
export function foldEntityClusters(items: EntityBatchItem[]): EntityFold {
  const decided = items.filter((i) => !i.error && i.verdict && i.aId && i.bId);
  const merges = decided
    .filter((i) => i.verdict === "merge")
    .sort(
      (x, y) =>
        (y.signals?.similarity ?? 0) - (x.signals?.similarity ?? 0) ||
        x.id.localeCompare(y.id),
    );
  const separations = new Set(
    decided.filter((i) => i.verdict === "distinct").map((i) => edgeKey(i.aId!, i.bId!)),
  );

  // Union-find over member sets keyed by root id.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = parent.get(x) ?? x;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
    parent.set(x, root);
    return root;
  };

  const clusters = new Map<string, { members: Set<string>; edges: string[] }>();
  const blocked: BlockedJoin[] = [];

  for (const m of merges) {
    const ra = find(m.aId!);
    const rb = find(m.bId!);
    if (ra === rb) {
      // already the same cluster: a redundant edge rides along; a
      // self-pair (aId === bId) joins nothing to nothing and is skipped.
      const home = clusters.get(ra);
      if (home) home.edges.push(m.id);
      continue;
    }
    const setA = clusters.get(ra)?.members ?? new Set([ra]);
    const setB = clusters.get(rb)?.members ?? new Set([rb]);
    // Contradiction check across the FULL prospective cluster: a chain
    // that would park two separately-judged records together is refused.
    let contradicted: { x: string; y: string } | null = null;
    for (const x of [...setA].sort()) {
      for (const y of [...setB].sort()) {
        if (separations.has(edgeKey(x, y))) {
          contradicted = { x, y };
          break;
        }
      }
      if (contradicted) break;
    }
    if (contradicted) {
      blocked.push({
        pairId: m.id,
        a: m.aId!,
        b: m.bId!,
        reason: `join refused — the code already separated ${contradicted.x} from ${contradicted.y}; a transitive chain never overrules a called separation, so this merge is logged for a human instead of folded`,
      });
      continue;
    }
    // Union: lower id becomes the root so the tree is canonical; members
    // and edges from BOTH sides always ride along (singleton included).
    const root = ra < rb ? ra : rb;
    const other = ra === root ? rb : ra;
    parent.set(other, root);
    const acc = {
      members: new Set<string>([...setA, ...setB, root]),
      edges: [...(clusters.get(ra)?.edges ?? []), ...(clusters.get(rb)?.edges ?? []), m.id],
    };
    clusters.delete(ra);
    clusters.delete(rb);
    clusters.set(root, acc);
  }

  const out: EntityCluster[] = [];
  for (const c of clusters.values()) {
    if (c.members.size < 2) continue; // a singleton is not a duplicate
    const sortedMembers = [...c.members].sort();
    out.push({ canonical: sortedMembers[0], members: sortedMembers, edges: [...c.edges].sort() });
  }
  out.sort((x, y) => x.canonical.localeCompare(y.canonical));
  blocked.sort((x, y) => x.pairId.localeCompare(y.pairId));
  return { clusters: out, blocked };
}

/* ------------------------------------------------------------------ *
 * Batched alignment with the lane's 5 → 10 → All discipline.
 * ------------------------------------------------------------------ */

export type EntityBatchItemIn = {
  id: string;
  a: EntityRecord;
  b: EntityRecord;
};

export type EntityBatchItem = {
  id: string;
  a: EntityRecord;
  b: EntityRecord;
  /** node ids the cluster fold joins — ride the item for the export too */
  aId: string;
  bId: string;
  signals?: EntitySignals;
  verdict?: EntityVerdict;
  reasons?: string[];
  usage?: Usage;
  error?: string;
};

export type EntityTally = Record<EntityVerdict, number>;

export type EntityTotals = {
  compared: number;
  errors: number;
  verdicts: EntityTally;
  usage: Usage;
};

export type EntityBatchReport = {
  items: EntityBatchItem[];
  totals: EntityTotals;
  clusters: EntityCluster[];
  blocked: BlockedJoin[];
  gates: EntityGates;
  model: string;
  provider: Provider;
};

export type RunEntityBatchOptions = {
  classifyFn?: typeof classify;
  gates?: Partial<EntityGates>;
  /** Cap on pairs processed; null = All. Default 5 (first ladder rung). */
  limit?: number | null;
  concurrency?: number;
};

function emptyTally(): EntityTally {
  return { distinct: 0, review: 0, merge: 0 };
}

/**
 * Align a corpus of candidate pairs (default: the shipped 25-pair
 * market audit). A failure on one pair is isolated to that pair's
 * report and never aborts the batch — same contract as every other
 * dashboard. Verdicts stay code-side per pair, and the cluster fold
 * walks ONLY this rung's decided items, so climbing the ladder widens
 * the alignment with it.
 */
export async function runEntityBatch(
  corpus: EntityBatchItemIn[] = buildEntityCorpus(),
  opts: RunEntityBatchOptions = {},
): Promise<EntityBatchReport> {
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

  const reports: (EntityBatchItem | undefined)[] = new Array(scoped.length);
  let cursor = 0;
  let classifierModel = "";
  let classifierProvider: Provider = "gateway";

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= scoped.length) return;
      const c = scoped[i];
      const report: EntityBatchItem = {
        id: c.id,
        a: c.a,
        b: c.b,
        aId: c.a.id,
        bId: c.b.id,
      };
      try {
        const al = await alignEntityPair(c.a, c.b, { classifyFn: run, gates });
        report.verdict = al.decision.verdict;
        report.reasons = al.decision.reasons;
        report.signals = al.signals;
        report.usage = al.usage;
        classifierModel = al.model;
        classifierProvider = al.provider;
      } catch (err) {
        report.error = err instanceof Error ? err.message : "entity alignment failed";
      }
      reports[i] = report;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const totals: EntityTotals = {
    compared: scoped.length,
    errors: 0,
    verdicts: emptyTally(),
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  for (const r of reports.filter((x): x is EntityBatchItem => !!x)) {
    if (r.error) {
      totals.errors += 1;
      continue;
    }
    if (r.verdict) totals.verdicts[r.verdict] += 1;
    if (r.usage) {
      totals.usage.input_tokens += r.usage.input_tokens;
      totals.usage.output_tokens += r.usage.output_tokens;
    }
  }

  const items = reports.filter((x): x is EntityBatchItem => !!x);
  const fold = foldEntityClusters(items);
  return {
    items,
    totals,
    clusters: fold.clusters,
    blocked: fold.blocked,
    gates,
    model: classifierModel,
    provider: classifierProvider,
  };
}

/* ------------------------------------------------------------------ *
 * D8 export surfaces — stable column order, rank rides the order.
 * ------------------------------------------------------------------ */

/** Flatten pair verdicts for the D8 export pipeline (stable column order). */
export function entityPairExportRows(items: EntityBatchItem[]): ExportRow[] {
  return items.map((r, i) => ({
    rank: i + 1,
    pair: r.id,
    a: r.aId,
    nameA: r.a.name,
    b: r.bId,
    nameB: r.b.name,
    similarity: r.signals ? Number(r.signals.similarity.toFixed(3)) : "",
    conflict: r.signals ? Number(r.signals.conflict.toFixed(3)) : "",
    generic: r.signals ? Number(r.signals.genericName.toFixed(3)) : "",
    confidence: r.signals ? Number(r.signals.confidence.toFixed(3)) : "",
    verdict: r.error ? "error" : (r.verdict ?? ""),
  }));
}

/** Flatten folded clusters for the D8 export pipeline (stable column order). */
export function entityClusterExportRows(clusters: EntityCluster[]): ExportRow[] {
  return clusters.map((c, i) => ({
    rank: i + 1,
    canonical: c.canonical,
    size: c.members.length,
    members: c.members.join("|"),
    edges: c.edges.join("|"),
  }));
}
