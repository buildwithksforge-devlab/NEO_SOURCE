import {describe,it,expect,vi,beforeEach} from 'vitest';
const mocks=vi.hoisted(()=>({rpc:vi.fn(),invalidate:vi.fn()}));
vi.mock('@/lib/auth',()=>({useAuth:()=>({organizationId:'org',user:{id:'cashier'}})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{}}));
vi.mock('@/lib/rpc-guard',()=>({guardedRpc:mocks.rpc}));
vi.mock('sonner',()=>({toast:{success:vi.fn(),error:vi.fn()}}));
vi.mock('@tanstack/react-query',()=>({useMutation:(o:unknown)=>o,useQuery:(o:unknown)=>o,useQueryClient:()=>({invalidateQueries:mocks.invalidate})}));
import {cashTender,outstandingPaidBill,POS_OPEN_FILTER} from '@/lib/pos-payment-display';
import {useRequestPosCashPayment} from '@/lib/cash-routing';
beforeEach(()=>{vi.clearAllMocks();mocks.rpc.mockResolvedValue({data:{status:'confirmed',request_id:'request',payment_id:'payment',receipt_number:'receipt'},error:null});});
describe('cash tender screen and routed command',()=>{
 it('preserves 2000 tender and 146 change for a 1854 bill',()=>expect(cashTender(1854,'2000')).toEqual({tendered:2000,change:146,error:null}));
 it('blank explicitly means exact cash',()=>expect(cashTender(1854,' ')).toEqual({tendered:1854,change:0,error:null}));
 it.each(['0','-1','1853.99','NaN','Infinity','2000.001'])('blocks invalid tender %s before a command',raw=>expect(cashTender(1854,raw).error).toBeTruthy());
 it('rounds change to currency cents',()=>expect(cashTender(0.1,'0.3').change).toBe(0.2));
 const hook=()=>useRequestPosCashPayment() as unknown as {mutationFn:(i:Record<string,unknown>)=>Promise<unknown>;onSuccess:(r:Record<string,unknown>)=>void};
 it('sends actual tender and stable collection identity to the six-argument RPC',async()=>{await hook().mutationFn({order:'order',amount:1854,tendered:2000,idempotencyKey:'collection'});expect(mocks.rpc).toHaveBeenCalledWith({},'neo_cash_request_pos_payment',expect.objectContaining({_order:'order',_amount:1854,_tendered:2000,_idempotency_key:'collection'}));});
 it('legacy caller sends exact cash explicitly',async()=>{await hook().mutationFn({order:'order',amount:50,idempotencyKey:'collection'});expect(mocks.rpc).toHaveBeenCalledWith({},'neo_cash_request_pos_payment',expect.objectContaining({_tendered:50}));});
 it('rejects insufficient tender before any server call',async()=>{await expect(hook().mutationFn({order:'order',amount:50,tendered:49})).rejects.toThrow(/tendered/);expect(mocks.rpc).not.toHaveBeenCalled();});
 it('refreshes the separate payment register after confirmation',()=>{hook().onSuccess({status:'confirmed',receipt_number:'receipt'});expect(mocks.invalidate).toHaveBeenCalledWith({queryKey:['payment-register']});});
 it('does not manufacture a receipt when the server refuses collection',async()=>{mocks.rpc.mockResolvedValue({data:null,error:{message:'Till closed'}});await expect(hook().mutationFn({order:'order',amount:50})).rejects.toThrow('Till closed');});
});
describe('legacy paid status with outstanding money',()=>{
 it.each(['partial','partially_paid','unpaid','pending'])('labels paid/%s as outstanding',payment_status=>expect(outstandingPaidBill({status:'paid',payment_status})).toBe(true));
 it.each(['paid','settled',null])('does not falsely flag paid/%s',payment_status=>expect(outstandingPaidBill({status:'paid',payment_status})).toBe(false));
 it('does not change service state meaning',()=>expect(outstandingPaidBill({status:'served',payment_status:'partial'})).toBe(false));
 it('keeps ordinary open states and adds only outstanding paid-state bills',()=>{expect(POS_OPEN_FILTER).toContain('status.in.(draft,held');expect(POS_OPEN_FILTER).toContain('and(status.eq.paid,payment_status.in.(partial,partially_paid,unpaid,pending))');});
});

