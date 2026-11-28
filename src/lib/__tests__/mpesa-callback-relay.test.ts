import { describe, expect, it, vi } from "vitest";
import { forwardManagedMpesaCallback } from "../mpesa-callback-relay";

const path = "/api/public/mpesa/callback/" + "a".repeat(48);
const enabled = { NEO_LOVABLE_BRIDGE_ENABLED: "true", NEO_LOVABLE_BRIDGE_CALLBACKS_ENABLED: "true" };
const request = (suffix = "", init: RequestInit = {}) => new Request(`https://neo-preview.neo-hospitality.workers.dev${path}${suffix}`, {
  method: "POST", headers: { "content-type": "application/json", cookie: "private", authorization: "Bearer private" },
  body: '{"Body":{"stkCallback":{"CheckoutRequestID":"checkout"}}}', ...init,
});
const upstream = () => vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ResultCode: 0, ResultDesc: "Accepted" }));

describe("existing managed M-Pesa callback transport", () => {
  it("leaves local execution alone outside bridge mode or on the managed host", async () => {
    const fetch = upstream();
    expect(await forwardManagedMpesaCallback(request(), { NEO_LOVABLE_BRIDGE_ENABLED: "false" }, fetch)).toBeNull();
    expect(await forwardManagedMpesaCallback(new Request(`https://horizon-prime-os.lovable.app${path}`), enabled, fetch)).toBeNull();
    expect(await forwardManagedMpesaCallback(new Request('https://local.invalid/api/public/other'), enabled, fetch)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not fall through to an invalid local admin when callbacks are unconfigured", async () => {
    const fetch = upstream();
    expect((await forwardManagedMpesaCallback(request(), { NEO_LOVABLE_BRIDGE_ENABLED: "true" }, fetch))?.status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves token path and payload, forwards no browser credentials, and allows callbacks while initiation is paused", async () => {
    const fetch = upstream(); const req = request(); const original = await req.clone().text();
    const response = await forwardManagedMpesaCallback(req, { ...enabled, NEO_LOVABLE_BRIDGE_PAYMENTS_ENABLED: "false" }, fetch);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![0]).toBe(`https://horizon-prime-os.lovable.app${path}`);
    const init = fetch.mock.calls[0]![1]!; const headers = new Headers(init.headers);
    expect(headers.get('cookie')).toBeNull(); expect(headers.get('authorization')).toBeNull();
    expect(new TextDecoder().decode(init.body as Uint8Array)).toBe(original);
    expect(init.redirect).toBe('manual'); expect(response?.headers.get('cache-control')).toBe('private, no-store');
    expect(await response?.json()).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
  });
  it.each([401,403,500,503])("preserves backend failure %s without acknowledging or leaking details", async status => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('internal-secret', { status }));
    const response = await forwardManagedMpesaCallback(request(), enabled, fetch);
    expect(response?.status).toBe(status); expect(await response?.text()).not.toContain('internal-secret'); expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([
    new Response('<html>app shell</html>', { headers: { 'content-type': 'text/html' } }),
    Response.json({ ok: true }), Response.json({ ResultCode: 1 }), Response.json([]),
    new Response(null,{ status:302,headers:{ location:'https://foreign.invalid' } }),
  ])("does not acknowledge an unrelated response", async value => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(value);
    expect((await forwardManagedMpesaCallback(request(), enabled, fetch))?.status).toBe(502);
  });
  it("does not retry, fall back locally, or log a token after a lost upstream response", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('lost response'));
    expect((await forwardManagedMpesaCallback(request(), enabled, fetch))?.status).toBe(503);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([
    ['?url=https://foreign.invalid',{},400], ['/extra',{},400],
    ['',{ method:'GET',body:null },405], ['',{ headers:{'content-type':'text/plain'} },415],
    ['',{ body:'not json' },400], ['',{ body:'x'.repeat(32769) },413],
  ] as const)("rejects an invalid callback before forwarding", async (suffix,init,status) => {
    const fetch = upstream(); expect((await forwardManagedMpesaCallback(request(suffix,init),enabled,fetch))?.status).toBe(status);
    expect(fetch).not.toHaveBeenCalled();
  });
});
