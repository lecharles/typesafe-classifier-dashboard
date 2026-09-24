import type { Usage } from "@/lib/schema";

const BASE_URL = "https://ai-gateway.vercel.sh/v1";
const PRIMARY_MODEL = process.env.CLASSIFIER_MODEL || "anthropic/claude-3-haiku";
const FALLBACK_MODEL = "amazon/nova-micro";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type ChatResult = { text: string; usage: Usage; model: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class GatewayError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function callOnce(model: string, messages: ChatMessage[], maxTokens: number): Promise<ChatResult> {
  const key = process.env.AI_GATEWAY_API_KEY;
  if (!key) throw new GatewayError("AI_GATEWAY_API_KEY is not set", 401);

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0 }),
  });

  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      detail = body?.error?.message || JSON.stringify(body);
    } catch {
      /* ignore parse error */
    }
    throw new GatewayError(detail, res.status);
  }

  const body = await res.json();
  const text: string = body?.choices?.[0]?.message?.content ?? "";
  const u = body?.usage ?? {};
  return {
    text,
    model: body?.model ?? model,
    usage: {
      input_tokens: u.prompt_tokens ?? u.input_tokens ?? 0,
      output_tokens: u.completion_tokens ?? u.output_tokens ?? 0,
    },
  };
}

/**
 * Call the gateway with retry on 429/5xx (2 retries, exponential backoff),
 * then fall back to a secondary model once if the primary keeps failing.
 */
export async function chat(
  messages: ChatMessage[],
  opts: { model?: string; maxTokens?: number } = {},
): Promise<ChatResult> {
  const maxTokens = opts.maxTokens ?? 1024;
  const models = opts.model ? [opts.model] : [PRIMARY_MODEL, FALLBACK_MODEL];

  let lastErr: unknown;
  for (const model of models) {
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        return await callOnce(model, messages, maxTokens);
      } catch (err) {
        lastErr = err;
        const status = err instanceof GatewayError ? err.status : 0;
        const retryable = status === 429 || (status >= 500 && status < 600);
        if (!retryable) break; // move to next model (or throw)
        if (attempt < 2) await sleep(300 * 2 ** attempt);
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("gateway call failed");
}

export { GatewayError };
