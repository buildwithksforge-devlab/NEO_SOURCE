import {beforeEach,describe,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({rpc:vi.fn(),invalidate:vi.fn(),success:vi.fn(),error:vi.fn()}));
vi.mock('@tanstack/react-query',()=>({useQuery:vi.fn(),useMutation:(options:unknown)=>options,useQueryClient:()=>({invalidateQueries:mocks.invalidate})}));
vi.mock('@/lib/rpc-guard',()=>({guardedRpc:mocks.rpc}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{}}));
vi.mock('sonner',()=>({toast:{success:mocks.success,error:mocks.error}}));
import {useRemoveDraftOrder} from '@/lib/pos-data';
import {RPC_MANIFEST} from '@/lib/rpc-manifest';
type Options={mutationFn:(input:{orderId:string;reason:string})=>Promise<unknown>;onSuccess:()=>void;onError:(e:Error)=>void};
const hook=()=>useRemoveDraftOrder() as unknown as Options;
beforeEach(()=>vi.clearAllMocks());
describe('draft order removal uses durable authenticated server outcome',()=>{
 it('registers authenticated RPC and sends the existing order ID and reason',async()=>{
  mocks.rpc.mockResolvedValue({data:{ok:true,removed:true,order_id:'draft',status:'cancelled'},error:null});
  await hook().mutationFn({orderId:'draft',reason:' duplicate '});
  expect(RPC_MANIFEST['neo_pos_remove_draft']).toBe('authenticated');
  expect(mocks.rpc).toHaveBeenCalledWith({},'neo_pos_remove_draft',{_order:'draft',_reason:'duplicate'});
 });
 it('rejects empty, mismatched and unconfirmed replies',async()=>{
  for(const data of [null,{}, {ok:true,removed:true,order_id:'other',status:'cancelled'},{ok:true,removed:true,order_id:'draft',status:'draft'}]){
   mocks.rpc.mockResolvedValue({data,error:null});await expect(hook().mutationFn({orderId:'draft',reason:'duplicate'})).rejects.toThrow(/not confirmed/);
  }
 });
 it('preserves server denial instead of reporting removal',async()=>{
  mocks.rpc.mockResolvedValue({data:null,error:new Error('Payment history blocks removal')});await expect(hook().mutationFn({orderId:'draft',reason:'duplicate'})).rejects.toThrow(/Payment history/);expect(mocks.success).not.toHaveBeenCalled();
 });
 it('invalidates POS lists only after confirmed success',()=>{hook().onSuccess();expect(mocks.invalidate).toHaveBeenCalledWith({queryKey:['pos']});expect(mocks.success).toHaveBeenCalledWith(expect.stringContaining('Audit history retained'))});
});

