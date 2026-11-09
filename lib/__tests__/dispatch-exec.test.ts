import { describe, it, expect } from "vitest";
import {
  REGISTRY,
  DEFAULT_EXEC_GATE,
  BATCH_LADDER,
  applyEffect,
  executePlan,
  runDispatchBatch,
  type DispatchPlan,
} from "@/lib/dispatch";
import type { Answer, ClassifyRequest, ClassifyResult } from "@/lib/schema";

function fakeResult(answers: Record<string, Answer>): ClassifyResult {
  return {
    answers,
    usage: { input_tokens: 10, output_tokens: 5 },
    model: "jev-test",
    provider: "gateway",
  };
}

const noul = (p: number): Answer => ({ type: "noul", noul: p });
const choice = (c: string, conf = 0.9): Answer => ({
  type: "choice",
  choice: c,
  probabilities: { [c]: conf },
  confidence: conf,
});

function plan(calls: { fn: string; args: Record<string, string>; confidence: number }[]): DispatchPlan {
  return { calls, model: "jev-test", provider: "gateway", usage: { input_tokens: 1, output_tokens: 1 } };
}

describe("UC#1-live constants", () => {
  it("execution gate is stricter than the 0.5 plan gate; ladder is 5 then 10", () => {
    expect(DEFAULT_EXEC_GATE).toBe(0.85);
    expect(DEFAULT_EXEC_GATE).toBeGreaterThan(0.5);
    expect([...BATCH_LADDER]).toEqual([5, 10]);
  });
});

describe("UC#1-live executePlan (confidence-gated execution in code)", () => {
  it("executes calls at or above the gate and holds the rest for a human", () => {
    const records = executePlan(
      plan([
        { fn: "tag_email", args: { label: "billing" }, confidence: 0.9 },
        { fn: "set_priority", args: { level: "high" }, confidence: 0.85 }, // exactly at gate
        { fn: "escalate", args: { queue: "eng" }, confidence: 0.6 }, // clears plan gate 0.5, not exec gate
      ]),
    );
    expect(records.map((r) => r.status)).toEqual(["executed", "executed", "held"]);
    const held = records.find((r) => r.fn === "escalate")!;
    expect(held.note).toMatch(/below exec gate/);
    expect(held.note).toMatch(/human review/);
  });

  it("executed records carry the simulated audit line, never real side effects", () => {
    const records = executePlan(plan([{ fn: "send_reply", args: { template: "refund", tone: "apologetic" }, confidence: 0.95 }]));
    expect(records[0].status).toBe("executed");
    expect(records[0].note).toBe(applyEffect({ fn: "send_reply", args: { template: "refund", tone: "apologetic" }, confidence: 0.95 }));
    expect(records[0].note).toBe("applied send_reply(template=refund, tone=apologetic)");
  });

  it("honors a custom execGate and emits executed records to the audit sink", () => {
    const audit: string[] = [];
    const records = executePlan(
      plan([{ fn: "tag_email", args: { label: "spam" }, confidence: 0.55 }]),
      { execGate: 0.5, onEffect: (r) => audit.push(r.fn) },
    );
    expect(records[0].status).toBe("executed");
    expect(audit).toEqual(["tag_email"]);
  });

  it("refuses to execute anything not declared in the registry (defense in depth)", () => {
    const bogus = plan([{ fn: "drop_all_tables", args: {}, confidence: 0.99 }]);
    expect(() => executePlan(bogus)).toThrow(/refusing to execute/);

    const wrongArg = plan([{ fn: "tag_email", args: { label: "delete_everything" }, confidence: 0.99 }]);
    expect(() => executePlan(wrongArg)).toThrow(/refusing to execute/);

    const missingArg = plan([{ fn: "send_reply", args: { template: "ack" }, confidence: 0.99 }]); // tone missing
    expect(() => executePlan(missingArg)).toThrow(/refusing to execute/);
  });

  it("an empty plan executes nothing", () => {
    expect(executePlan(plan([]))).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */

// A fake classifier that clears both gates for tag_email/set_priority on
// "urgent" states, clears the PLAN gate but not the EXEC gate on others.
function liveClassifier(confidence: number) {
  return async (req: ClassifyRequest): Promise<ClassifyResult> => {
    const isTag = "label" in req.questions;
    const isPri = "level" in req.questions;
    if (isTag) return fakeResult({ should_call: noul(0.9), label: choice("bug", confidence) });
    if (isPri) return fakeResult({ should_call: noul(0.9), level: choice("high", confidence) });
    return fakeResult({ should_call: noul(0.1) });
  };
}

const manyItems = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `e${String(i + 1).padStart(2, "0")}`, state: `state ${i}` }));

describe("UC#1-live runDispatchBatch (batch discipline 5 → 10 → All)", () => {
  it("defaults to the first ladder rung: 5 items even when 12 are offered", async () => {
    const report = await runDispatchBatch(manyItems(12), { classifyFn: liveClassifier(0.9) });
    expect(report.items.length).toBe(5);
    expect(report.totals.items).toBe(5);
    expect(report.items.map((r) => r.id)).toEqual(["e01", "e02", "e03", "e04", "e05"]);
  });

  it("expands to 10, then All when limit is null", async () => {
    const ten = await runDispatchBatch(manyItems(12), { classifyFn: liveClassifier(0.9), limit: 10 });
    expect(ten.items.length).toBe(10);
    const all = await runDispatchBatch(manyItems(12), { classifyFn: liveClassifier(0.9), limit: null });
    expect(all.items.length).toBe(12);
    expect(all.totals.items).toBe(12);
  });

  it("runs every planned call above the exec gate and holds the ones below", async () => {
    // confidence 0.6 clears the plan gate (0.5) but not the exec gate (0.85).
    const report = await runDispatchBatch(manyItems(2), { classifyFn: liveClassifier(0.6), limit: null });
    expect(report.totals.planned).toBe(4); // 2 items × 2 functions
    expect(report.totals.executed).toBe(0);
    expect(report.totals.held).toBe(4);
    expect(report.items[0].records.every((r) => r.status === "held")).toBe(true);

    const hot = await runDispatchBatch(manyItems(2), { classifyFn: liveClassifier(0.9), limit: null });
    expect(hot.totals.executed).toBe(4);
    expect(hot.totals.held).toBe(0);
    expect(hot.items[0].records[0].note).toMatch(/^applied /);
  });

  it("isolates a per-item failure without aborting the batch", async () => {
    const flaky = async (req: ClassifyRequest): Promise<ClassifyResult> => {
      if (req.state === "state 1" && "label" in req.questions) throw new Error("provider exploded");
      return liveClassifier(0.9)(req);
    };
    const report = await runDispatchBatch(manyItems(3), { classifyFn: flaky, limit: null, concurrency: 1 });
    expect(report.items.length).toBe(3);
    expect(report.totals.errors).toBe(1);
    const failed = report.items.find((r) => r.error)!;
    expect(failed.id).toBe("e02");
    expect(failed.error).toMatch(/provider exploded/);
    // the other two still executed both calls
    expect(report.totals.executed).toBe(4);
  });

  it("sums usage across the batch and reports the exec gate used", async () => {
    const report = await runDispatchBatch(manyItems(2), { classifyFn: liveClassifier(0.9), limit: null });
    expect(report.execGate).toBe(DEFAULT_EXEC_GATE);
    // 2 items × 5 registry functions × (10 in, 5 out) fake usage
    expect(report.totals.usage).toEqual({ input_tokens: 100, output_tokens: 50 });
    expect(report.model).toBe("jev-test");
    expect(report.provider).toBe("gateway");
  });

  it("limit larger than the corpus clamps to All without error", async () => {
    const report = await runDispatchBatch(manyItems(3), { classifyFn: liveClassifier(0.9), limit: 10 });
    expect(report.items.length).toBe(3);
  });
});
