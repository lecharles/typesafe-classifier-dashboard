import { chat, type ChatMessage } from "@/lib/gateway";
import { systemOne, defaultJevModel, jevAvailable, type JevTrace } from "@/lib/jev";
import {
  answerSchemaFor,
  type Answer,
  type ClassifyRequest,
  type ClassifyResult,
  type Provider,
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
 * Default backend: the real TypeSafe/Jev API when a key is configured,
 * otherwise the primitives emulated through the Vercel AI Gateway.
 * Override with the CLASSIFIER_PROVIDER env var ("jev" | "gateway"),
 * or per request with the `provider` field.
 */
export function defaultProvider(): Provider {
  const env = (process.env.CLASSIFIER_PROVIDER || "").toLowerCase();
  if (env === "jev" || env === "gateway") return env;
  return jevAvailable() ? "jev" : "gateway";
}

export type ClassifyOptions = {
  provider?: Provider;
  /** Record raw request/response + attempt log on the result (D7 dev view). */
  trace?: boolean;
  /** If the jev path fails outright, fall back to the gateway instead of erroring. */
  fallback?: boolean;
};

/**
 * Classify a state against a set of typed questions using the chosen backend.
 */
export async function classify(
  req: ClassifyRequest,
  opts: ClassifyOptions = {},
): Promise<ClassifyResult> {
  const provider = opts.provider ?? req.provider ?? defaultProvider();
  if (provider !== "jev") return classifyWithGateway(req, opts);
  try {
    return await classifyWithJev(req, opts);
  } catch (err) {
    if (!opts.fallback) throw err;
    const result = await classifyWithGateway(req, opts);
    if (result.trace) {
      result.trace.fallback_from = "jev";
      result.trace.fallback_reason = err instanceof Error ? err.message : String(err);
    }
    return result;
  }
}

/** The real Jev API: one native System One request answers every question. */
async function classifyWithJev(req: ClassifyRequest, opts: ClassifyOptions): Promise<ClassifyResult> {
  const model = process.env.JEV_MODEL || defaultJevModel();
  const jevTrace: JevTrace | undefined = opts.trace
    ? { endpoint: "", request: { model, state: req.state, questions: req.questions }, attempts: [] }
    : undefined;
  const res = await systemOne({ model, state: req.state, questions: req.questions }, { trace: jevTrace });
  const answers = validateAnswers(res.answers, req.questions);
  const result: ClassifyResult = { answers, usage: res.usage, model: res.model, provider: "jev" };
  if (jevTrace) {
    result.trace = {
      provider_used: "jev",
      endpoint: jevTrace.endpoint,
      request: jevTrace.request,
      response: jevTrace.response,
      attempts: jevTrace.attempts,
      retries: Math.max(0, jevTrace.attempts.length - 1),
    };
  }
  return result;
}

/**
 * Emulated path (Vercel AI Gateway). On invalid/malformed JSON, retries once
 * with a stricter instruction before giving up.
 */
async function classifyWithGateway(req: ClassifyRequest, opts: ClassifyOptions): Promise<ClassifyResult> {
  let usage: Usage = { input_tokens: 0, output_tokens: 0 };
  let model = "";
  let lastErr: unknown;
  const attempts: { status: number; error?: string }[] = [];
  let lastMessages: ChatMessage[] = [];
  let lastText = "";

  for (let attempt = 0; attempt < 2; attempt++) {
    const messages = buildPrompt(req, attempt > 0);
    lastMessages = messages;
    const res = await chat(messages, { maxTokens: 1024 });
    lastText = res.text;
    usage = addUsage(usage, res.usage);
    model = res.model;
    try {
      const answers = validateAnswers(extractJson(res.text), req.questions);
      attempts.push({ status: 200 });
      const result: ClassifyResult = { answers, usage, model, provider: "gateway" };
      if (opts.trace) {
        result.trace = {
          provider_used: "gateway",
          endpoint: "https://ai-gateway.vercel.sh/v1/chat/completions (emulated)",
          request: lastMessages,
          response: lastText,
          attempts,
          retries: attempts.length - 1,
        };
      }
      return result;
    } catch (err) {
      attempts.push({ status: 0, error: err instanceof Error ? err.message : String(err) });
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("classification failed");
}
