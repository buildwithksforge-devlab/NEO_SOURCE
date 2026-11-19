import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@tanstack/react-start', () => ({ createServerFn: () => {
  const chain: any = { middleware: () => chain, inputValidator: () => chain, handler: (fn: any) => fn };
  return chain;
} }));
vi.mock('@/integrations/supabase/auth-middleware', () => ({ requireSupabaseAuth: {} }));
const admin = vi.hoisted(() => ({ updateUserById: vi.fn(), from: vi.fn() }));
vi.mock('@/integrations/supabase/client.server', () => ({ supabaseAdmin: { auth: { admin: { updateUserById: admin.updateUserById } }, from: admin.from } }));
const { resetStaffPassword } = await import('../users.functions');
describe('staff password reset partial outcomes', () => {
  let profileError: any, auditError: any, rpc: any, eq: any;
  beforeEach(() => {
    profileError = null; auditError = null;
    admin.updateUserById.mockReset().mockResolvedValue({ error: null });
    eq = vi.fn();
    const update: any = { eq: (...args: any[]) => { eq(...args); return update; }, then: (resolve: any) => Promise.resolve({ error: profileError }).then(resolve) };
    admin.from.mockReset().mockImplementation((table: string) => table === 'profiles' ? { update: () => update } : { insert: async () => ({ error: auditError }) });
    rpc = vi.fn().mockResolvedValue({ data: true });
  });
  const run = () => (resetStaffPassword as any)({ data: { user_id: 'target', password: 'test-only-password' }, context: { userId: 'actor', supabase: { rpc, from: () => {
    const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { organization_id: 'org' } }) }; return q;
  } } } });
  it('reports complete success and scopes the profile update', async () => {
    expect(await run()).toMatchObject({ password_changed: true, password_change_required: true, warning: null });
    expect(eq).toHaveBeenCalledWith('organization_id', 'org');
  });
  it('does not claim forced change when the profile update fails after Auth succeeds', async () => {
    profileError = { message: 'write failed' };
    expect(await run()).toMatchObject({ password_changed: true, password_change_required: false, warning: expect.stringContaining('could not be saved') });
    expect(admin.updateUserById).toHaveBeenCalledOnce();
  });
  it('reports an audit failure without inviting another password reset', async () => {
    auditError = { message: 'audit failed' };
    expect(await run()).toMatchObject({ password_changed: true, password_change_required: true, warning: expect.stringContaining('audit record') });
  });
  it('stops before profile/history writes when Auth rejects the reset', async () => {
    admin.updateUserById.mockResolvedValue({ error: { message: 'Invalid API key' } });
    await expect(run()).rejects.toThrow('Invalid API key'); expect(admin.from).not.toHaveBeenCalled();
  });
  it('does not change a password without capability or owner authority', async () => {
    rpc.mockResolvedValue({ data: false }); await expect(run()).rejects.toThrow('Forbidden');
    expect(admin.updateUserById).not.toHaveBeenCalled();
  });
});
