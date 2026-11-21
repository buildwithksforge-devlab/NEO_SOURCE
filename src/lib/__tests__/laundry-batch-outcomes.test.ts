import {beforeEach,describe,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({rpc:vi.fn(),invalidate:vi.fn(),success:vi.fn()}));
vi.mock('@tanstack/react-query',()=>({useQuery:vi.fn(),useMutation:(options:unknown)=>options,useQueryClient:()=>({invalidateQueries:m.invalidate})}));
vi.mock('@/lib/rpc-guard',()=>({guardedRpc:m.rpc}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{}}));
vi.mock('@/lib/auth',()=>({useAuth:()=>({organizationId:'org'})}));
vi.mock('sonner',()=>({toast:{success:m.success,error:vi.fn()}}));
import {useAdvanceLaundryBatch} from '@/lib/laundry-department';
type Mutation={mutationFn:(input:{batchId:string;status:string})=>Promise<string>;onSuccess:(status:string)=>void};
const run=async()=>{const mutation=useAdvanceLaundryBatch() as unknown as Mutation;const result=await mutation.mutationFn({batchId:'batch',status:'drying'});mutation.onSuccess(result);return result};
beforeEach(()=>vi.clearAllMocks());
describe('batch stage confirmation and guest view refresh',()=>{
 it.each([null,{}, {ok:true,status:'washing'}])('refuses an unconfirmed batch stage %j',async data=>{m.rpc.mockResolvedValue({data,error:null});await expect(run()).rejects.toThrow(/confirm/);expect(m.success).not.toHaveBeenCalled();expect(m.invalidate).not.toHaveBeenCalled()});
 it('preserves a server failure detail without success feedback',async()=>{m.rpc.mockResolvedValue({data:{ok:false,detail:'Batch is assigned to somebody else'},error:null});await expect(run()).rejects.toThrow(/somebody else/);expect(m.success).not.toHaveBeenCalled()});
 it('uses the original stage RPC and returns the confirmed status',async()=>{m.rpc.mockResolvedValue({data:{ok:true,status:'drying'},error:null});await expect(run()).resolves.toBe('drying');expect(m.rpc).toHaveBeenCalledWith({},'neo_laundry_batch_advance',{_batch:'batch',_status:'drying'})});
 it('refreshes guest status in the current workspace alongside staff views',async()=>{m.rpc.mockResolvedValue({data:{ok:true,status:'drying'},error:null});await run();expect(m.invalidate).toHaveBeenCalledWith({queryKey:['guest-laundry-mine','org']});expect(m.invalidate).toHaveBeenCalledWith({queryKey:['ops']});expect(m.success).toHaveBeenCalledTimes(1)});
});
