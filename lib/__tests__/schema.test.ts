import { describe, it, expect } from "vitest";
import { answerSchemaFor, classifyRequest } from "@/lib/schema";
import type { Question } from "@/lib/schema";

describe("answerSchemaFor", () => {
  it("accepts a valid choice answer", () => {
    const q: Question = { type: "choice", instructions: "pick", criteria: { a: "A", b: "B" } };
    const parsed = answerSchemaFor(q).safeParse({
      type: "choice",
      choice: "a",
      probabilities: { a: 0.9, b: 0.1 },
      confidence: 0.9,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a choice answer missing the choice field", () => {
    const q: Question = { type: "choice", instructions: "pick", criteria: { a: "A" } };
    const parsed = answerSchemaFor(q).safeParse({
      type: "choice",
      probabilities: { a: 1 },
      confidence: 0.5,
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts a valid noul answer and rejects out-of-range", () => {
    const q: Question = { type: "noul", instructions: "urgent?" };
    expect(answerSchemaFor(q).safeParse({ type: "noul", noul: 0.7 }).success).toBe(true);
    expect(answerSchemaFor(q).safeParse({ type: "noul", noul: 2 }).success).toBe(false);
  });
});

describe("classifyRequest", () => {
  it("requires at least one question", () => {
    expect(classifyRequest.safeParse({ state: "hi", questions: {} }).success).toBe(false);
    expect(
      classifyRequest.safeParse({
        state: "hi",
        questions: { t: { type: "noul", instructions: "q" } },
      }).success,
    ).toBe(true);
  });
});
