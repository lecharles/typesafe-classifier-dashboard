import type { Usage } from "@/lib/schema";

const BASE_URL = "https://ai-gateway.vercel.sh/v1";
const PRIMARY_MODEL = process.env.CLASSIFIER_MODEL || "anthropic/claude-3-haiku";
const FALLBACK_MODEL = "amazon/nova-micro";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type ChatResult = { text: string; usage: Usage; model: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class GatewayError extends Error {
  status: number;
  retryAfterMs?: number;
  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Pull a retry delay (ms) from the Retry-After header or a "Retry after Ns" message. */
function parseRetryAfter(headerValue: string | null, message: string): number | undefined {
  if (headerValue) {
    const secs = Number(headerValue);
    if (Number.isFinite(secs)) return secs * 1000;
  }
  const m = message.match(/retry after (\d+)\s*s/i);
  if (m) return Number(m[1]) * 1000;
  return undefined;
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
    const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), detail);
    throw new GatewayError(detail, res.status, retryAfterMs);
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
  opts: { model?: string; maxTokens?: number; maxRetries?: number } = {},
): Promise<ChatResult> {
  const maxTokens = opts.maxTokens ?? 1024;
  const models = opts.model ? [opts.model] : [PRIMARY_MODEL, FALLBACK_MODEL];
  const maxRetries = opts.maxRetries ?? 4;
  // Cap how long we're willing to wait on a single 429 so a request can't hang forever.
  const maxWaitMs = 65_000;

  let lastErr: unknown;
  for (const model of models) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await callOnce(model, messages, maxTokens);
      } catch (err) {
        lastErr = err;
        const status = err instanceof GatewayError ? err.status : 0;
        const retryable = status === 429 || (status >= 500 && status < 600);
        if (!retryable) break; // move to next model (or throw)
        if (attempt < maxRetries) {
          // Honor the server's Retry-After when present; otherwise exponential backoff.
          const suggested = err instanceof GatewayError ? err.retryAfterMs : undefined;
          const wait = Math.min(suggested ?? 500 * 2 ** attempt, maxWaitMs);
          await sleep(wait);
        }
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("gateway call failed");
}

export { GatewayError };
