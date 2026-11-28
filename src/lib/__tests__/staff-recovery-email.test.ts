import {beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('@tanstack/react-start',()=>({createServerFn:()=>{const chain:any={middleware:()=>chain,inputValidator:()=>chain,handler:(fn:any)=>fn};return chain;}}));
vi.mock('@/integrations/supabase/auth-middleware',()=>({requireSupabaseAuth:{}}));
const {resendStaffInvitation}=await import('../users.functions');
describe('staff setup email delivery',()=>{
 let reset:any,rpc:any,from:any,query:any;
 beforeEach(()=>{reset=vi.fn().mockResolvedValue({error:null});rpc=vi.fn().mockResolvedValue({data:true});
 query={select:()=>query,eq:()=>query,maybeSingle:async()=>({data:{organization_id:'org',email:'staff@example.test'}}),update:()=>query,insert:async()=>({error:null}),then:(resolve:any)=>Promise.resolve({error:null}).then(resolve)};from=vi.fn(()=>query);
 });
 const run=(redirect='https://neo-preview.neo-hospitality.workers.dev/auth')=>(resendStaffInvitation as any)({data:{user_id:'staff',redirect_to:redirect},context:{userId:'admin',supabase:{rpc,from,auth:{resetPasswordForEmail:reset}}}});
 it('requests an actual recovery email with the reset page and no returned secret link',async()=>{
  const result=await run();expect(reset).toHaveBeenCalledWith('staff@example.test',{redirectTo:'https://neo-preview.neo-hospitality.workers.dev/auth/reset-password'});expect(result).toMatchObject({ok:true,email_requested:true});expect(result).not.toHaveProperty('action_link');
 });
 it('does not send without administration authority',async()=>{rpc.mockResolvedValue({data:false});await expect(run()).rejects.toThrow('Forbidden');expect(reset).not.toHaveBeenCalled();});
 it('does not send to an arbitrary redirect origin',async()=>{await expect(run('https://foreign.invalid/auth')).rejects.toThrow('approved');expect(reset).not.toHaveBeenCalled();});
 it('does not report success when Auth rejects delivery',async()=>{reset.mockResolvedValue({error:{message:'rate limited'}});await expect(run()).rejects.toThrow('rate limited');});
});
