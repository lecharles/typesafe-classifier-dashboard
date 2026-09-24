import { z } from "zod";

/* ------------------------------------------------------------------ *
 * Questions (what we ask the model) — modeled on typesafe.ai's
 * three primitives: Choice, Score, Noul.
 * ------------------------------------------------------------------ */

export const choiceQuestion = z.object({
  type: z.literal("choice"),
  instructions: z.string(),
  // option key -> human description
  criteria: z.record(z.string()),
});

export const scoreQuestion = z.object({
  type: z.literal("score"),
  instructions: z.string(),
  // ordered levels, lowest first (2-10 levels)
  criteria: z.array(z.string()).min(2).max(10),
});

export const noulQuestion = z.object({
  type: z.literal("noul"),
  instructions: z.string(),
  criteria: z.object({ true: z.string(), false: z.string() }).optional(),
});

export const question = z.discriminatedUnion("type", [
  choiceQuestion,
  scoreQuestion,
  noulQuestion,
]);

export type ChoiceQuestion = z.infer<typeof choiceQuestion>;
export type ScoreQuestion = z.infer<typeof scoreQuestion>;
export type NoulQuestion = z.infer<typeof noulQuestion>;
export type Question = z.infer<typeof question>;

/* ------------------------------------------------------------------ *
 * Answers (what the model returns) — validated with zod.
 * ------------------------------------------------------------------ */

export const choiceAnswer = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.number()),
  confidence: z.number().min(0).max(1),
});

export const scoreAnswer = z.object({
  type: z.literal("score"),
  score: z.number(),
  probabilities: z.record(z.number()),
  confidence: z.number().min(0).max(1),
});

export const noulAnswer = z.object({
  type: z.literal("noul"),
  noul: z.number().min(0).max(1),
});

export const answer = z.discriminatedUnion("type", [
  choiceAnswer,
  scoreAnswer,
  noulAnswer,
]);

export type ChoiceAnswer = z.infer<typeof choiceAnswer>;
export type ScoreAnswer = z.infer<typeof scoreAnswer>;
export type NoulAnswer = z.infer<typeof noulAnswer>;
export type Answer = z.infer<typeof answer>;

/** Return the zod schema for the answer that a given question expects. */
export function answerSchemaFor(q: Question) {
  switch (q.type) {
    case "choice":
      return choiceAnswer;
    case "score":
      return scoreAnswer;
    case "noul":
      return noulAnswer;
  }
}

/* ------------------------------------------------------------------ *
 * Request / result envelopes.
 * ------------------------------------------------------------------ */

export const classifyRequest = z.object({
  state: z.string().min(1),
  questions: z.record(question).refine((q) => Object.keys(q).length > 0, {
    message: "at least one question is required",
  }),
});
export type ClassifyRequest = z.infer<typeof classifyRequest>;

export type Usage = { input_tokens: number; output_tokens: number };

export type ClassifyResult = {
  answers: Record<string, Answer>;
  usage: Usage;
  model: string;
};
