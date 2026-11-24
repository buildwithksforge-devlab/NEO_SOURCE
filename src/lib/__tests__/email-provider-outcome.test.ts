import { afterEach, describe, expect, it, vi } from "vitest";
import { sendEmail } from "../communication-providers.server";
const message = {
  channel: "email",
  recipient: "person@example.test",
  subject: "Test only",
  body: "Synthetic content",
  idempotencyKey: "communication/org/message",
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("email provider evidence and retry safety", () => {
  it("requires provider ID and preserves stable idempotency identity", async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: "email-123" }));
    vi.stubGlobal("fetch", f);
    expect(
      await sendEmail(message, { from_email: "sender@example.test" }, { api_key: "test-only" }),
    ).toMatchObject({ ok: true, reference: "email-123" });
    expect(new Headers(f.mock.calls[0]![1]!.headers).get("idempotency-key")).toBe(
      message.idempotencyKey,
    );
  });
  it("does not label a 200 without message ID as sent", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json({})));
    expect(
      await sendEmail(message, { from_email: "sender@example.test" }, { api_key: "test-only" }),
    ).toMatchObject({ ok: false, permanent: true, code: "email_outcome_unknown" });
  });
  it("holds a lost response for review instead of automatically sending again", async () => {
    const f = vi.fn<typeof fetch>().mockRejectedValue(new Error("private provider details"));
    vi.stubGlobal("fetch", f);
    const result = await sendEmail(
      message,
      { from_email: "sender@example.test" },
      { api_key: "test-only" },
    );
    expect(result).toMatchObject({ ok: false, permanent: true, code: "email_outcome_unknown" });
    expect(JSON.stringify(result)).not.toContain("private provider details");
    expect(f).toHaveBeenCalledOnce();
  });
  it("leaves a missing sender as configuration gap without contacting provider", async () => {
    const f = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", f);
    expect(await sendEmail(message, {}, { api_key: "test-only" })).toMatchObject({
      ok: false,
      code: "sender_not_configured",
    });
    expect(f).not.toHaveBeenCalled();
  });
});
