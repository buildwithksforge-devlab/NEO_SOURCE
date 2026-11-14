import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), call: vi.fn() }));
vi.mock("@/lib/ai-provider.server", () => ({
  resolveAiProvider: mocks.resolve,
  callProvider: mocks.call,
}));
import { generateNarrative } from "@/lib/ai-assistant.server";
const input = {
  question: "Explain occupancy",
  intentId: "occupancy",
  period: { from: "2026-11-01", to: "2026-11-06" },
  metrics: [{ label: "Occupied rooms", value: "17" }],
};
const config = {
  provider: "lovable",
  model: "configured-model",
  baseUrl: "https://example.invalid",
  apiKey: "test-key",
  enabled: true,
  source: "platform",
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolve.mockResolvedValue(config);
});
describe("local metric summaries and explicit external opt-in", () => {
  it.each(["platform", "none"])("uses no external call for %s fallback", async (source) => {
    mocks.resolve.mockResolvedValue({ ...config, source });
    const result = await generateNarrative(input, "org-a");
    expect(result).toMatchObject({ provider: "local", model: null, status: "ok" });
    expect(result.text).toContain("Occupied rooms: 17");
    expect(result.text).toContain("2026-11-01 to 2026-11-06");
    expect(mocks.call).not.toHaveBeenCalled();
  });
  it("reports unavailable values without inventing metrics", async () => {
    const result = await generateNarrative({ ...input, metrics: [] });
    expect(result.text).toContain("No authorised metric values");
    expect(result.text).not.toContain("Occupied rooms");
    expect(mocks.call).not.toHaveBeenCalled();
  });
  it("honours the workspace disabled switch", async () => {
    mocks.resolve.mockResolvedValue({ ...config, source: "workspace", enabled: false });
    expect(await generateNarrative(input)).toMatchObject({ status: "disabled", text: null });
    expect(mocks.call).not.toHaveBeenCalled();
  });
  it("retains an explicitly configured external provider and its errors", async () => {
    mocks.resolve.mockResolvedValue({ ...config, source: "workspace" });
    mocks.call.mockResolvedValue({
      text: null,
      status: "quota",
      detail: "Provider quota exhausted",
    });
    const result = await generateNarrative(input, "org-a");
    expect(mocks.resolve).toHaveBeenCalledWith("org-a");
    expect(mocks.call).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      provider: "lovable",
      status: "quota",
      detail: "Provider quota exhausted",
    });
  });
});
