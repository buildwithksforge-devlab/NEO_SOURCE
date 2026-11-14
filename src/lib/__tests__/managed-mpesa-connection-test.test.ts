import { describe, expect, it, vi } from "vitest";
import { toCrossJSONAsync, fromJSON } from "seroval";
import { testManagedSavedMpesaConnection } from "../managed-mpesa-connection-test.server";
const request = () => new Request('https://neo-preview.neo-hospitality.workers.dev/_serverFn/local', {
  headers: { authorization: 'Bearer synthetic.payload.signature', cookie: 'do-not-forward', 'x-service-key': 'do-not-forward' },
});
const result = async (value: unknown) => Response.json(await toCrossJSONAsync(value, {}));
describe('shared Platform M-Pesa connection verification', () => {
  it('uses the existing managed command and caller session without exporting credentials', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(await result({ result: { authorised:true,ok:true,status:'ok',environment:'production',detail:'Daraja issued an access token.' },error:undefined,context:{} }));
    expect(await testManagedSavedMpesaConnection(request(),fetch)).toMatchObject({ ok:true,status:'ok' });
    expect(fetch).toHaveBeenCalledOnce(); const [url,init]=fetch.mock.calls[0]!;
    expect(url).toBe('https://horizon-prime-os.lovable.app/_serverFn/ad043ee140ba978f053a297c76e78345643b42f3bfd28eee8ad60f618cde9855');
    const headers=new Headers(init!.headers);expect(headers.get('authorization')).toBe('Bearer synthetic.payload.signature');expect(headers.get('cookie')).toBeNull();expect(headers.get('x-service-key')).toBeNull();
    expect(init!.redirect).toBe('manual');expect(fromJSON(JSON.parse(String(init!.body)), {})).toEqual({data:{}});
  });
  it('preserves a real failed connection without turning transport success into provider success', async () => {
    const fetch=vi.fn<typeof globalThis.fetch>().mockResolvedValue(await result({result:{authorised:true,ok:false,status:'incomplete',detail:'Missing credentials'}}));
    expect((await testManagedSavedMpesaConnection(request(),fetch)).ok).toBe(false);
  });
  it.each([Response.json({ok:true}),new Response(null,{status:302,headers:{location:'https://foreign.invalid'}}),new Response('no',{status:403})])('rejects invalid results, redirects and permission failures',async response=>{
    const fetch=vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    await expect(testManagedSavedMpesaConnection(request(),fetch)).rejects.toThrow();expect(fetch).toHaveBeenCalledOnce();
  });
  it('does not retry or fall back to local privileged credentials on network failure',async()=>{
    const fetch=vi.fn<typeof globalThis.fetch>().mockRejectedValue(Error('network'));
    await expect(testManagedSavedMpesaConnection(request(),fetch)).rejects.toThrow();expect(fetch).toHaveBeenCalledOnce();
  });
});
