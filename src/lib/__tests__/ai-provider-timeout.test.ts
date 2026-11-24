import { afterEach, describe, expect, it, vi } from "vitest";
import { callProvider, type AiProviderConfig } from "@/lib/ai-provider.server";

const config: AiProviderConfig = {
  provider: "test",
  model: "test-model",
  baseUrl: "https://provider.invalid/v1",
  apiKey: "disposable-test-key",
  enabled: true,
  source: "workspace",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("AI provider request deadline", () => {
  it("aborts a stalled provider and returns a recoverable status", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, options: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = callProvider(config, [{ role: "user", content: "Test only" }]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await pending).toMatchObject({ ok: false, status: "unavailable", text: null, detail: expect.stringContaining("timed out") });
    expect(fetchMock.mock.calls[0]?.[1].signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the deadline after an immediate response", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "ready" } }] }),
    }));

    expect(await callProvider(config, [{ role: "user", content: "Test only" }])).toMatchObject({ ok: true, status: "ok", text: "ready" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
