import type { Question, Usage } from "@/lib/schema";

/**
 * Client for the real TypeSafe (Jev) System One API — either directly at
 * api.typesafe.ai or through the Vercel AI Gateway's TypeSafe-compatible
 * surface (https://ai-gateway.vercel.sh/typesafe, billed via the gateway key).
 *
 * Docs: https://docs.typesafe.ai/api/system-one
 *       https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe
 *   POST {base}/v1/systemone   — answer typed questions about a state
 *   GET  {base}/v1/models      — list models/aliases available
 * Auth: `Authorization: Bearer <TYPESAFE_API_KEY or AI_GATEWAY_API_KEY>`.
 *
 * The request/response shapes here match lib/schema.ts exactly: the app was
 * built to emulate Jev's Choice/Score/Noul primitives, so the swap is a
 * transport change, not a model change.
 */

/** Direct TypeSafe API by default; set TYPESAFE_API_BASE to route through the
 *  Vercel AI Gateway (https://ai-gateway.vercel.sh/typesafe). Read at call time
 *  so the deployed env, not the import-time env, decides the route. */
function baseUrl(): string {
  return process.env.TYPESAFE_API_BASE || "https://api.typesafe.ai";
}

function isGatewayRoute(): boolean {
  return baseUrl().includes("ai-gateway.vercel.sh");
}

/** Model default differs per route: gateway lists `typesafe-ai/jev`, direct lists `jev-latest`. */
export const JEV_MODEL_DEFAULT = "jev-latest";
export const JEV_MODEL_DEFAULT_GATEWAY = "jev";

export function defaultJevModel(): string {
  return isGatewayRoute() ? JEV_MODEL_DEFAULT_GATEWAY : JEV_MODEL_DEFAULT;
}

/** Resolve the bearer key: dedicated TypeSafe key first, else the AI Gateway key when routed through the gateway. */
export function jevKey(): string | undefined {
  return process.env.TYPESAFE_API_KEY || (isGatewayRoute() ? process.env.AI_GATEWAY_API_KEY : undefined);
}

/** True when a real Jev backend is reachable with the current env. */
export function jevAvailable(): boolean {
  return jevKey() !== undefined;
}

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

/** Mutable trace sink filled in by systemOne when the caller wants dev diagnostics (D7). */
export type JevTrace = {
  endpoint: string;
  request: SystemOneRequest;
  response?: unknown;
  attempts: { status: number; error?: string; waited_ms?: number }[];
};

/**
 * Call POST /v1/systemone with retry on 429 / 529 / 5xx (and connection
 * errors): exponential backoff, honoring Retry-After, capped at 65s per wait.
 * Non-retryable statuses (400/401/413/415/422) throw immediately.
 * Pass `trace` to record the raw wire request/response and per-attempt log.
 */
export async function systemOne(
  request: SystemOneRequest,
  opts: { maxRetries?: number; trace?: JevTrace } = {},
): Promise<SystemOneResponse> {
  const key = jevKey();
  if (!key) throw new JevError("TYPESAFE_API_KEY (or AI_GATEWAY_API_KEY with the gateway route) is not set", 401);
  const maxRetries = opts.maxRetries ?? 4;
  const maxWaitMs = 65_000;

  const trace = opts.trace;
  if (trace) {
    trace.endpoint = `${baseUrl()}/v1/systemone`;
    trace.request = request;
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${baseUrl()}/v1/systemone`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
      });
    } catch (err) {
      // Network failure: retryable like a 5xx.
      const connMsg = `connection error: ${err instanceof Error ? err.message : String(err)}`;
      lastErr = new JevError(connMsg, 0);
      const waitMs = attempt < maxRetries ? Math.min(500 * 2 ** attempt, maxWaitMs) : undefined;
      if (trace) trace.attempts.push({ status: 0, error: connMsg, waited_ms: waitMs });
      if (waitMs !== undefined) await sleep(waitMs);
      continue;
      }

    if (res.ok) {
      const body = await res.json();
      if (trace) {
        trace.response = body;
        trace.attempts.push({ status: res.status });
      }
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
    const waitMs = retryable && attempt < maxRetries
      ? Math.min(retryAfterMs ?? 500 * 2 ** attempt, maxWaitMs)
      : undefined;
    if (trace) trace.attempts.push({ status: res.status, error: detail, waited_ms: waitMs });
    if (!retryable) throw lastErr;
    if (waitMs !== undefined) await sleep(waitMs);
  }
  throw lastErr instanceof Error ? lastErr : new JevError("Jev request failed", 0);
}

/** GET /v1/models — connectivity/credential check; lists names and aliases. */
export async function listModels(): Promise<ModelInfo[]> {
  const key = jevKey();
  if (!key) throw new JevError("TYPESAFE_API_KEY (or AI_GATEWAY_API_KEY with the gateway route) is not set", 401);
  const res = await fetch(`${baseUrl()}/v1/models`, {
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
