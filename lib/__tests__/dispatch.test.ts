import { describe, it, expect } from "vitest";
import { REGISTRY, questionsFor, planDispatch, type ToolFunction } from "@/lib/dispatch";
import type { Answer, ClassifyResult } from "@/lib/schema";

function fakeResult(answers: Record<string, Answer>): ClassifyResult {
  return {
    answers,
    usage: { input_tokens: 10, output_tokens: 5 },
    model: "jev-test",
    provider: "gateway",
  };
}

const noul = (p: number): Answer => ({ type: "noul", noul: p });
const choice = (c: string, conf = 0.8): Answer => ({
  type: "choice",
  choice: c,
  probabilities: { [c]: conf },
  confidence: conf,
});

describe("UC#1 registry", () => {
  it("has exactly 5 uniquely-named functions with well-formed args", () => {
    expect(REGISTRY.length).toBe(5);
    const names = new Set(REGISTRY.map((f) => f.name));
    expect(names.size).toBe(5);
    for (const fn of REGISTRY) {
      expect(fn.description.length).toBeGreaterThan(0);
      expect(Object.keys(fn.args).length).toBeGreaterThanOrEqual(1);
      for (const [arg, spec] of Object.entries(fn.args)) {
        expect(spec.options.length).toBeGreaterThanOrEqual(2);
        for (const o of spec.options) expect(typeof o).toBe("string");
        expect(typeof arg).toBe("string");
      }
    }
  });

  it("questionsFor builds a noul gate + one Choice per arg with the exact options", () => {
    const fn = REGISTRY.find((f) => f.name === "send_reply")!;
    const qs = questionsFor(fn);
    expect(qs.should_call.type).toBe("noul");
    expect(Object.keys(qs).length).toBe(1 + Object.keys(fn.args).length);
    for (const [arg, spec] of Object.entries(fn.args)) {
      const q = qs[arg];
      expect(q.type).toBe("choice");
      if (q.type === "choice") {
        expect(Object.keys(q.criteria).sort()).toEqual([...spec.options].sort());
      }
    }
  });
});

describe("UC#1 planDispatch", () => {
  it("plans calls that clear the gate, sorted by confidence, usage summed", async () => {
    const classifyFn = (async (req: { questions: Record<string, unknown> }) => {
      const isTag = "label" in req.questions;
      const isPri = "level" in req.questions;
      if (isTag) return fakeResult({ should_call: noul(0.9), label: choice("bug", 0.85) });
      if (isPri) return fakeResult({ should_call: noul(0.95), level: choice("critical", 0.6) });
      return fakeResult({ should_call: noul(0.1) });
    }) as never;

    const plan = await planDispatch("the checkout page keeps erroring!", { classifyFn });
    expect(plan.calls.map((c) => c.fn)).toEqual(["tag_email", "set_priority"]); // 0.85 > 0.6
    expect(plan.calls[0].args).toEqual({ label: "bug" });
    // All 5 registry functions are asked (even the 3 that get gated out), each
    // returning 10/5 usage in the fake — so 5 × (10, 5).
    expect(plan.usage).toEqual({ input_tokens: 50, output_tokens: 25 });
  });

  it("drops functions below the gate", async () => {
    const classifyFn = (async () =>
      fakeResult({ should_call: noul(0.2), label: choice("spam") })) as never;
    const plan = await planDispatch("hello", { classifyFn, registry: [REGISTRY[0]] });
    expect(plan.calls).toEqual([]);
  });

  it("multi-arg functions take the minimum arg confidence", async () => {
    const fn: ToolFunction = REGISTRY.find((f) => f.name === "send_reply")!;
    const classifyFn = (async () =>
      fakeResult({ should_call: noul(0.9), template: choice("refund", 0.9), tone: choice("apologetic", 0.4) })) as never;
    const plan = await planDispatch("refund me now", { classifyFn, registry: [fn] });
    expect(plan.calls[0].confidence).toBe(0.4);
    expect(plan.calls[0].args).toEqual({ template: "refund", tone: "apologetic" });
  });

  it("rejects a choice outside the declared option set", async () => {
    const fn: ToolFunction = REGISTRY.find((f) => f.name === "tag_email")!;
    const classifyFn = (async () =>
      fakeResult({ should_call: noul(0.9), label: choice("delete_everything") })) as never;
    await expect(planDispatch("x", { classifyFn, registry: [fn] })).rejects.toThrow(
      /outside the declared set/,
    );
  });
});
