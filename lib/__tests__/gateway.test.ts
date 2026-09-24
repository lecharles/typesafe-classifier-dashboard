import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chat } from "@/lib/gateway";

function okResponse(content: string) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({
      model: "anthropic/claude-3-haiku",
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
  };
}

function errResponse(status: number) {
  return {
    ok: false,
    status,
    statusText: "ERR",
    json: async () => ({ error: { message: `boom ${status}` } }),
  };
}

describe("gateway.chat", () => {
  beforeEach(() => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
    vi.restoreAllMocks();
  });
  afterEach(() => vi.restoreAllMocks());

  it("posts to the gateway with a bearer header and parses text + usage", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse("hello"));
    vi.stubGlobal("fetch", fetchMock);

    const res = await chat([{ role: "user", content: "hi" }], { model: "m" });

    expect(res.text).toBe("hello");
    expect(res.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
  });

  it("retries on 429 then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errResponse(429))
      .mockResolvedValueOnce(errResponse(429))
      .mockResolvedValueOnce(okResponse("recovered"));
    vi.stubGlobal("fetch", fetchMock);

    const res = await chat([{ role: "user", content: "hi" }], { model: "m" });
    expect(res.text).toBe("recovered");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry on a 4xx that is not 429", async () => {
    const fetchMock = vi.fn().mockResolvedValue(errResponse(403));
    vi.stubGlobal("fetch", fetchMock);

    await expect(chat([{ role: "user", content: "hi" }], { model: "m" })).rejects.toThrow(/boom 403/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
