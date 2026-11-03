import type { Question, Usage } from "@/lib/schema";

/**
 * Client for the real TypeSafe (Jev) System One API.
 *
 * Docs: https://docs.typesafe.ai/api/system-one
 *   POST https://api.typesafe.ai/v1/systemone   — answer typed questions about a state
 *   GET  https://api.typesafe.ai/v1/models      — list models/aliases for this key
 * Auth: `Authorization: Bearer <TYPESAFE_API_KEY>`.
 *
 * The request/response shapes here match lib/schema.ts exactly: the app was
 * built to emulate Jev's Choice/Score/Noul primitives, so the swap is a
 * transport change, not a model change.
 */

const BASE_URL = "https://api.typesafe.ai";
export const JEV_MODEL_DEFAULT = "jev-latest";

export type SystemOneRequest = {
  model: string;
  state: string;
  questions: Record<string, Question>;
};

export type SystemOneResponse = {
  model: string;
  answers: Record<string, unknown>;
  usage: Usage;
};

export type ModelInfo = { name: string; description?: string; release_date?: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class JevError extends Error {
  status: number;
  retryAfterMs?: number;
  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.name = "JevError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Pull a retry delay (ms) from the Retry-After header or a "retry after Ns" message. */
function parseRetryAfter(headerValue: string | null, message: string): number | undefined {
  if (headerValue) {
    const secs = Number(headerValue);
    if (Number.isFinite(secs)) return secs * 1000;
  }
  const m = message.match(/retry after (\d+)\s*s/i);
  if (m) return Number(m[1]) * 1000;
  return undefined;
}

/** Build a readable error message from TypeSafe's { detail } error bodies. */
function errorDetail(body: unknown, status: number, statusText: string): string {
  if (body && typeof body === "object") {
    const detail = (body as { detail?: unknown }).detail;
    if (typeof detail === "string" && detail) return detail;
    if (Array.isArray(detail) && detail.length > 0) {
      const first = detail[0] as { loc?: unknown[]; msg?: string };
      const where = Array.isArray(first?.loc) ? first.loc.slice(1).join(".") : "";
      return `${status} at ${where || "body"}: ${first?.msg ?? "validation failed"}`;
    }
    if (detail && typeof detail === "object") {
      const msg = (detail as { message?: string }).message;
      if (msg) return msg;
    }
  }
  return `${status} ${statusText}`;
}

/**
 * Call POST /v1/systemone with retry on 429 / 529 / 5xx (and connection
 * errors): exponential backoff, honoring Retry-After, capped at 65s per wait.
 * Non-retryable statuses (400/401/413/415/422) throw immediately.
 */
export async function systemOne(
  request: SystemOneRequest,
  opts: { maxRetries?: number } = {},
): Promise<SystemOneResponse> {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new JevError("TYPESAFE_API_KEY is not set", 401);
  const maxRetries = opts.maxRetries ?? 4;
  const maxWaitMs = 65_000;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/v1/systemone`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
      });
    } catch (err) {
      // Network failure: retryable like a 5xx.
      lastErr = new JevError(
        `connection error: ${err instanceof Error ? err.message : String(err)}`,
        0,
      );
      if (attempt < maxRetries) await sleep(Math.min(500 * 2 ** attempt, maxWaitMs));
      continue;
      }

    if (res.ok) {
      const body = await res.json();
      const u = body?.usage ?? {};
      return {
        model: body?.model ?? request.model,
        answers: body?.answers ?? {},
        usage: {
          input_tokens: u.input_tokens ?? 0,
          output_tokens: u.output_tokens ?? 0,
        },
      };
    }

    let detail = `${res.status} ${res.statusText}`;
    try {
      detail = errorDetail(await res.json(), res.status, res.statusText);
    } catch {
      /* ignore parse error */
    }
    const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), detail);
    lastErr = new JevError(detail, res.status, retryAfterMs);

    const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
    if (!retryable) throw lastErr;
    if (attempt < maxRetries) {
      await sleep(Math.min(retryAfterMs ?? 500 * 2 ** attempt, maxWaitMs));
    }
  }
  throw lastErr instanceof Error ? lastErr : new JevError("Jev request failed", 0);
}

/** GET /v1/models — connectivity/credential check; lists names and aliases. */
export async function listModels(): Promise<ModelInfo[]> {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new JevError("TYPESAFE_API_KEY is not set", 401);
  const res = await fetch(`${BASE_URL}/v1/models`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      detail = errorDetail(await res.json(), res.status, res.statusText);
    } catch {
      /* ignore parse error */
    }
    throw new JevError(detail, res.status);
  }
  const body = await res.json();
  return (body?.models ?? []) as ModelInfo[];
}

export { JevError };
