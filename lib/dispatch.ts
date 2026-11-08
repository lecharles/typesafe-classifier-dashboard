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
 * is executed (that lands in UC#1-live, 11-10).
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
