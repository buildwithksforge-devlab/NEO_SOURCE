import { beforeEach,describe,expect,it,vi } from 'vitest';
const m=vi.hoisted(()=>({rpc:vi.fn(),invalidate:vi.fn(),auth:{organizationId:'org',user:{id:'worker'},phase:'ready',permissionsLoaded:true,can:():boolean=>true},branch:{branchId:'property'}}));
vi.mock('@tanstack/react-query',()=>({useQuery:(q:any)=>q,useQueryClient:()=>({invalidateQueries:m.invalidate})}));
vi.mock('@/lib/auth',()=>({useAuth:()=>m.auth}));
vi.mock('@/lib/branch-filter',()=>({useActivePropertyFilter:()=>m.branch}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{}}));
vi.mock('@/lib/rpc-guard',()=>({guardedRpc:m.rpc}));
import {useAutomaticPlatformChecks} from '@/lib/platform-automatic-checks';
const query=()=>useAutomaticPlatformChecks() as any;
beforeEach(()=>{vi.clearAllMocks();m.auth={organizationId:'org',user:{id:'worker'},phase:'ready',permissionsLoaded:true,can:():boolean=>true};m.branch={branchId:'property'};m.rpc.mockResolvedValue({data:{run_id:'saved',finished_at:'2026-11-19T08:00:00Z'},error:null});});
describe('automatic platform checks',()=>{
 it('runs for the selected property and refreshes the existing Quality records',async()=>{await query().queryFn();expect(m.rpc).toHaveBeenCalledWith(expect.anything(),'neo_platform_run_checks',{_branch:'property'});expect(m.invalidate).toHaveBeenCalledWith({queryKey:['platform','defects']});expect(m.invalidate).toHaveBeenCalledWith({queryKey:['platform','test_runs']});});
 it('does not run for signed-out or unauthorized users or missing scope',()=>{m.auth.phase='signed-out';expect(query().enabled).toBe(false);m.auth.phase='ready';m.auth.can=()=>false;expect(query().enabled).toBe(false);m.auth.can=()=>true;m.branch.branchId='';expect(query().enabled).toBe(false);});
 it('isolates cached results across staff, organisation and property',()=>{const key=query().queryKey;m.auth.user.id='other';expect(query().queryKey).not.toEqual(key);m.auth.user.id='worker';m.auth.organizationId='other';expect(query().queryKey).not.toEqual(key);});
 it('uses a controlled interval without automatic retries or background browser writes',()=>{expect(query()).toMatchObject({refetchInterval:900000,refetchIntervalInBackground:false,retry:false});});
 it('cannot report success without saved evidence and preserves server errors',async()=>{m.rpc.mockResolvedValue({data:{},error:null});await expect(query().queryFn()).rejects.toThrow('not saved');m.rpc.mockResolvedValue({data:null,error:{message:'not installed',code:'PGRST202'}});await expect(query().queryFn()).rejects.toMatchObject({code:'PGRST202'});});
});
