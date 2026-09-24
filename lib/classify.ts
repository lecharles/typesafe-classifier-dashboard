import { chat, type ChatMessage } from "@/lib/gateway";
import {
  answerSchemaFor,
  type Answer,
  type ClassifyRequest,
  type ClassifyResult,
  type Question,
  type Usage,
} from "@/lib/schema";

/** Describe the required answer shape for one question, for the prompt. */
function describeQuestion(id: string, q: Question): string {
  switch (q.type) {
    case "choice": {
      const opts = Object.entries(q.criteria)
        .map(([k, v]) => `      - "${k}": ${v}`)
        .join("\n");
      return [
        `- "${id}" (choice): ${q.instructions}`,
        `    options:`,
        opts,
        `    answer: {"type":"choice","choice":<one option key>,"probabilities":{<option key>:<0..1>,...},"confidence":<0..1>}`,
      ].join("\n");
    }
    case "score": {
      const levels = q.criteria.map((c, i) => `      - ${i}: ${c}`).join("\n");
      return [
        `- "${id}" (score): ${q.instructions}`,
        `    levels (index: meaning):`,
        levels,
        `    answer: {"type":"score","score":<level index 0..${q.criteria.length - 1}>,"probabilities":{"0":<0..1>,...},"confidence":<0..1>}`,
      ].join("\n");
    }
    case "noul": {
      const crit = q.criteria
        ? ` (true = ${q.criteria.true}; false = ${q.criteria.false})`
        : "";
      return [
        `- "${id}" (noul): ${q.instructions}${crit}`,
        `    answer: {"type":"noul","noul":<probability 0..1 that the answer is yes>}`,
      ].join("\n");
    }
  }
}

export function buildPrompt(req: ClassifyRequest, strict = false): ChatMessage[] {
  const questionBlock = Object.entries(req.questions)
    .map(([id, q]) => describeQuestion(id, q))
    .join("\n");

  const system = [
    "You are a precise structured-classification engine.",
    "Evaluate the STATE against each QUESTION independently.",
    "Return ONLY a single JSON object mapping each question id to its answer object.",
    "Do not include any prose, explanation, or markdown fences.",
    strict ? "Your previous output was invalid. Return ONLY valid JSON, nothing else." : "",
  ]
    .filter(Boolean)
    .join(" ");

  const user = [
    "STATE:",
    req.state,
    "",
    "QUESTIONS:",
    questionBlock,
    "",
    'Respond with JSON shaped like: {"<question id>": <answer object>, ...}',
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** Pull the first JSON object out of a model response (tolerating fences/prose). */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("no JSON object found in model response");
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

function validateAnswers(
  raw: unknown,
  questions: ClassifyRequest["questions"],
): Record<string, Answer> {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("model response is not an object");
  }
  const obj = raw as Record<string, unknown>;
  const answers: Record<string, Answer> = {};
  for (const [id, q] of Object.entries(questions)) {
    const parsed = answerSchemaFor(q).safeParse(obj[id]);
    if (!parsed.success) {
      throw new Error(`invalid answer for "${id}": ${parsed.error.message}`);
    }
    answers[id] = parsed.data;
  }
  return answers;
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
  };
}

/**
 * Classify a state against a set of typed questions. On invalid/malformed
 * JSON, retries once with a stricter instruction before giving up.
 */
export async function classify(req: ClassifyRequest): Promise<ClassifyResult> {
  let usage: Usage = { input_tokens: 0, output_tokens: 0 };
  let model = "";
  let lastErr: unknown;

  for (let attempt = 0; attempt < 2; attempt++) {
    const messages = buildPrompt(req, attempt > 0);
    const res = await chat(messages, { maxTokens: 1024 });
    usage = addUsage(usage, res.usage);
    model = res.model;
    try {
      const answers = validateAnswers(extractJson(res.text), req.questions);
      return { answers, usage, model };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("classification failed");
}
