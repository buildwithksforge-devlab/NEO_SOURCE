import {describe,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({invalidate:vi.fn(),rpc:vi.fn()}));
vi.mock('@/lib/auth',()=>({useAuth:()=>({organizationId:'org',user:{id:'cashier'}})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{}}));
vi.mock('@/lib/rpc-guard',()=>({guardedRpc:m.rpc}));
vi.mock('sonner',()=>({toast:{success:vi.fn(),error:vi.fn()}}));
vi.mock('@tanstack/react-query',()=>({useMutation:(o:unknown)=>o,useQuery:(o:unknown)=>o,useQueryClient:()=>({invalidateQueries:m.invalidate})}));
import {useSettleCashRefund,useDecideCashRefund,useConfirmCashReceipt,useRequestPosCashPayment} from '@/lib/cash-routing';
describe('saved cash actions await connected view refresh',()=>{
 it.each([['refund payout',useSettleCashRefund,{refund_receipt_number:'RF1'}],['refund decision',useDecideCashRefund,{status:'approved'}],['cash receipt',useConfirmCashReceipt,{receipt_number:'R1'}],['POS collection',useRequestPosCashPayment,{status:'confirmed',receipt_number:'R1'}]] as const)('%s keeps pending until refresh completes',async(_name,hook,result)=>{
  let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve});m.invalidate.mockReset().mockReturnValue(pending);
  const mutation=hook() as unknown as {onSuccess:(r:unknown)=>Promise<void>};let completed=false;
  const saved=mutation.onSuccess(result);expect(saved).toBeInstanceOf(Promise);saved.then(()=>{completed=true});await Promise.resolve();expect(completed).toBe(false);
  expect(m.invalidate).toHaveBeenCalledWith({queryKey:['cash']});expect(m.invalidate).toHaveBeenCalledWith({queryKey:['pos']});expect(m.invalidate).toHaveBeenCalledWith({queryKey:['payment-register']});
  release();await saved;expect(completed).toBe(true);
 });
});
