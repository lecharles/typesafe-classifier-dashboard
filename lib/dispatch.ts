import { classify } from "@/lib/classify";
import type { ClassifyResult, Provider, Question, Usage } from "@/lib/schema";

/**
 * UC#1 (11-09): tool-call dispatcher scaffold.
 * A small registry of side-effect-free tool functions whose arguments are
 * each a Jev Choice — the model never free-writes a value, it picks one of
 * the declared options. 11-10 makes this live: batches + confidence-gated
 * execution in code.
 */

export type ToolArgSpec = { description: string; options: string[] };

export type ToolFunction = {
  name: string;
  description: string;
  args: Record<string, ToolArgSpec>;
};

/** The 5-function scaffold registry (email-triage flavored). */
export const REGISTRY: ToolFunction[] = [
  {
    name: "tag_email",
    description: "Attach a triage label to an email thread",
    args: {
      label: {
        description: "which triage label",
        options: ["billing", "bug", "feature", "spam", "praise"],
      },
    },
  },
  {
    name: "set_priority",
    description: "Set the queue priority of the item",
    args: {
      level: {
        description: "priority level",
        options: ["trivial", "low", "medium", "high", "critical"],
      },
    },
  },
  {
    name: "send_reply",
    description: "Send a canned reply to the customer",
    args: {
      template: {
        description: "reply template",
        options: ["ack", "eta", "fix", "refund", "no_reply"],
      },
      tone: {
        description: "reply tone",
        options: ["formal", "friendly", "apologetic"],
      },
    },
  },
  {
    name: "escalate",
    description: "Escalate the item to a human queue",
    args: {
      queue: {
        description: "target human queue",
        options: ["support", "eng", "billing_review", "legal"],
      },
    },
  },
  {
    name: "schedule_demo",
    description: "Book a product demo slot for the customer",
    args: {
      slot: {
        description: "demo length",
        options: ["15min", "30min", "60min"],
      },
    },
  },
];

/** Build the question set for one function: a call gate + Choice-per-arg. */
export function questionsFor(fn: ToolFunction): Record<string, Question> {
  const qs: Record<string, Question> = {
    should_call: {
      type: "noul",
      instructions: `Should the agent invoke ${fn.name}: ${fn.description}?`,
      criteria: { true: "yes, invoke", false: "no, leave it alone" },
    },
  };
  for (const [arg, spec] of Object.entries(fn.args)) {
    qs[arg] = {
      type: "choice",
      instructions: `For ${fn.name}, pick the value of the "${arg}" argument.`,
      criteria: Object.fromEntries(spec.options.map((o) => [o, `${o} — ${spec.description}`])),
    };
  }
  return qs;
}

export type DispatchCall = { fn: string; args: Record<string, string>; confidence: number };

export type DispatchPlan = {
  calls: DispatchCall[];
  model: string;
  provider: Provider;
  usage: Usage;
};

export type PlanOptions = {
  registry?: ToolFunction[];
  classifyFn?: typeof classify;
  /** Noul probability a function must reach to appear in the plan. */
  gate?: number;
  /** Dev mode: also collect the raw per-function classify traces. */
  trace?: boolean;
};

/**
 * Ask the registry, one function at a time, whether it applies to `state`
 * and — if so — which declared option each argument takes. Returns the
 * calls that cleared the gate, highest confidence first. Pure plan: nothing
 * is executed here — execution is gated separately in `executePlan`
 * (UC#1-live, 11-10).
 */
export async function planDispatch(
  state: string,
  opts: PlanOptions = {},
): Promise<DispatchPlan & { traces?: { fn: string; trace: unknown }[] }> {
  const registry = opts.registry ?? REGISTRY;
  const run = opts.classifyFn ?? classify;
  const gate = opts.gate ?? 0.5;
  const calls: DispatchCall[] = [];
  const traces: { fn: string; trace: unknown }[] = [];
  const usage: Usage = { input_tokens: 0, output_tokens: 0 };
  let model = "";
  let provider: Provider = "gateway";

  for (const fn of registry) {
    const res = await run(
      { state, questions: questionsFor(fn) },
      opts.trace ? { trace: true } : {},
    );
    usage.input_tokens += res.usage.input_tokens;
    usage.output_tokens += res.usage.output_tokens;
    model = res.model;
    provider = res.provider;
    if (opts.trace && res.trace) traces.push({ fn: fn.name, trace: res.trace });

    const should = res.answers.should_call;
    if (should?.type !== "noul" || should.noul < gate) continue;

    const args: Record<string, string> = {};
    let confidence = 1;
    for (const [arg, spec] of Object.entries(fn.args)) {
      const a = res.answers[arg];
      if (a?.type !== "choice" || !spec.options.includes(a.choice)) {
        throw new Error(
          `dispatcher: ${fn.name}.${arg} returned an option outside the declared set`,
        );
      }
      args[arg] = a.choice;
      confidence = Math.min(confidence, a.confidence);
    }
    calls.push({ fn: fn.name, args, confidence });
  }

  calls.sort((a, b) => b.confidence - a.confidence);
  const plan: DispatchPlan = { calls, model, provider, usage };
  if (opts.trace) {
    return { ...plan, traces };
  }
  return plan;
}

/* ------------------------------------------------------------------ *
 * UC#1-live (11-10): confidence-gated execution in code + batches 5→10.
 *
 * The plan step already gates at `gate` (0.5); execution applies its own,
 * stricter gate in CODE. A call below the exec gate is never run — it is
 * held for a human, with the reason recorded. The effect runner is
 * simulated (side-effect-free audit log) so the hub stays safe to demo;
 * swapping in real effect handlers only touches `applyEffect`.
 * ------------------------------------------------------------------ */

/** Probability a call must reach for CODE to actually run it. */
export const DEFAULT_EXEC_GATE = 0.85;

/** Batch discipline ladder from the lane's standing rule: 5 → 10 → All. */
export const BATCH_LADDER = [5, 10] as const;

export type ExecStatus = "executed" | "held";

export type ExecRecord = {
  fn: string;
  args: Record<string, string>;
  confidence: number;
  status: ExecStatus;
  /** Audit-log line when executed; hold reason when not. */
  note: string;
};

export type BatchItemReport = {
  id: string;
  state: string;
  plan?: DispatchPlan;
  records: ExecRecord[];
  executed: number;
  held: number;
  error?: string;
};

export type BatchReport = {
  items: BatchItemReport[];
  totals: {
    items: number;
    planned: number;
    executed: number;
    held: number;
    errors: number;
    usage: Usage;
  };
  execGate: number;
  model: string;
  provider: Provider;
};

export type ExecuteOptions = {
  /** In-code gate: calls under this confidence are held, never run. */
  execGate?: number;
  /** Audit sink for executed effects; defaults to an in-memory log. */
  onEffect?: (record: ExecRecord) => void;
};

/** Simulated side effect — deterministic audit line, touches nothing real. */
export function applyEffect(call: DispatchCall): string {
  const args = Object.entries(call.args)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  return `applied ${call.fn}(${args})`;
}

/**
 * Execute a plan IN CODE with its own confidence gate: `executed` only when
 * confidence ≥ execGate; otherwise `held` for human review. Defense in
 * depth: the call is re-checked against the registry before any effect is
 * applied, even though planDispatch already validated it.
 */
export function executePlan(
  plan: DispatchPlan,
  opts: ExecuteOptions = {},
): ExecRecord[] {
  const execGate = opts.execGate ?? DEFAULT_EXEC_GATE;
  const emit = opts.onEffect ?? (() => {});
  const records: ExecRecord[] = [];
  for (const call of plan.calls) {
    const fn = REGISTRY.find((f) => f.name === call.fn);
    const declaredArgs = fn ? Object.entries(fn.args) : [];
    const valid =
      !!fn &&
      Object.keys(call.args).length === declaredArgs.length &&
      declaredArgs.every(
        ([arg, spec]) => spec.options.includes(call.args[arg] ?? ""),
      );
    if (!valid) {
      throw new Error(
        `dispatcher: refusing to execute ${call.fn} — not a declared registry call`,
      );
    }
    if (call.confidence >= execGate) {
      const record: ExecRecord = {
        fn: call.fn,
        args: { ...call.args },
        confidence: call.confidence,
        status: "executed",
        note: applyEffect(call),
      };
      emit(record);
      records.push(record);
    } else {
      records.push({
        fn: call.fn,
        args: { ...call.args },
        confidence: call.confidence,
        status: "held",
        note: `confidence ${call.confidence.toFixed(2)} below exec gate ${execGate.toFixed(2)} — routed to human review`,
      });
    }
  }
  return records;
}

export type RunBatchOptions = PlanOptions &
  ExecuteOptions & {
    /** Cap on items processed; null = All. Default 5 (first ladder rung). */
    limit?: number | null;
    /** How many items to run concurrently. Default 3, bounded. */
    concurrency?: number;
  };

/**
 * Live batched dispatch: plan + execute many states with the lane's batch
 * discipline (5 → 10 → All via `limit`). A failure on one item is isolated
 * to that item's report and never aborts the batch.
 */
export async function runDispatchBatch(
  items: BatchItemLike[],
  opts: RunBatchOptions = {},
): Promise<BatchReport> {
  const run = opts.classifyFn ?? classify;
  const limit = opts.limit === null ? items.length : (opts.limit ?? BATCH_LADDER[0]);
  const scoped = items.slice(0, Math.max(0, Math.min(limit, items.length)));
  const concurrency = Math.min(Math.max(1, opts.concurrency ?? 3), scoped.length || 1);

  const reports: (BatchItemReport | undefined)[] = new Array(scoped.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= scoped.length) return;
      const item = scoped[i];
      const report: BatchItemReport = {
        id: item.id,
        state: item.state,
        records: [],
        executed: 0,
        held: 0,
      };
      try {
        const plan = await planDispatch(item.state, { ...opts, classifyFn: run });
        report.plan = {
          calls: plan.calls,
          model: plan.model,
          provider: plan.provider,
          usage: plan.usage,
        };
        report.records = executePlan(plan, opts);
        report.executed = report.records.filter((r) => r.status === "executed").length;
        report.held = report.records.filter((r) => r.status === "held").length;
      } catch (err) {
        report.error = err instanceof Error ? err.message : "dispatch failed";
      }
      reports[i] = report;
    }
  }
  await Promise.all(
    Array.from({ length: concurrency }, () => worker()),
  );

  const totals = {
    items: scoped.length,
    planned: 0,
    executed: 0,
    held: 0,
    errors: 0,
    usage: { input_tokens: 0, output_tokens: 0 } as Usage,
  };
  let model = "";
  let provider: Provider = "gateway";
  for (const r of reports.filter((x): x is BatchItemReport => !!x)) {
    totals.planned += r.plan?.calls.length ?? 0;
    totals.executed += r.executed;
    totals.held += r.held;
    if (r.error) totals.errors += 1;
    if (r.plan) {
      totals.usage.input_tokens += r.plan.usage.input_tokens;
      totals.usage.output_tokens += r.plan.usage.output_tokens;
      model = r.plan.model;
      provider = r.plan.provider;
    }
  }

  return {
    items: reports.filter((x): x is BatchItemReport => !!x),
    totals,
    execGate: opts.execGate ?? DEFAULT_EXEC_GATE,
    model,
    provider,
  };
}

type BatchItemLike = { id: string; state: string };
