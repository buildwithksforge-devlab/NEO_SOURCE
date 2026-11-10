import {beforeEach,describe,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({rpc:vi.fn(),success:vi.fn(),error:vi.fn(),invalidate:vi.fn(),org:'org'}));
vi.mock('@/lib/rpc-guard',()=>({guardedRpc:m.rpc}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{}}));
vi.mock('@/lib/auth',()=>({useAuth:()=>({organizationId:m.org,user:{id:'cashier'}})}));
vi.mock('@tanstack/react-query',()=>({useMutation:(o:unknown)=>o,useQuery:(o:unknown)=>o,useQueryClient:()=>({invalidateQueries:m.invalidate})}));
vi.mock('sonner',()=>({toast:{success:m.success,error:m.error}}));
import {requireCashCommandResult,validateCashCommandInput} from '@/lib/cash-command-result';
import {useConfirmCashReceipt,useRequestCashPayment,useDecideCashRefund,useConfirmCashTransfer} from '@/lib/cash-routing';
type Case={name:string;args:Record<string,unknown>;result:Record<string,unknown>};
const cases:Case[]=[
 {name:'neo_cash_request_payment',args:{_folio:'folio',_amount:50},result:{status:'pending',request_id:'request'}},
 {name:'neo_cash_request_pos_payment',args:{_order:'order',_amount:50},result:{status:'confirmed',request_id:'request',payment_id:'payment',receipt_number:'RCPT'}},
 {name:'neo_cash_confirm_receipt',args:{_request:'request'},result:{status:'confirmed',request_id:'request',payment_id:'payment',receipt_number:'RCPT'}},
 {name:'neo_cash_cancel_request',args:{_request:'request',_reason:'Not received'},result:{status:'cancelled',request_id:'request'}},
 {name:'neo_cash_transfer_send',args:{_amount:50},result:{status:'in_transit',transfer_id:'transfer',transfer_number:'TR-1'}},
 {name:'neo_cash_transfer_confirm',args:{_transfer:'transfer'},result:{status:'received',transfer_id:'transfer',transfer_number:'TR-1'}},
 {name:'neo_cash_transfer_cancel',args:{_transfer:'transfer',_reason:'Returned'},result:{status:'cancelled',transfer_id:'transfer'}},
 {name:'neo_cash_refund_request',args:{_payment:'payment',_amount:50,_reason:'Refund'},result:{status:'pending_approval',refund_id:'refund',threshold:20}},
 {name:'neo_cash_refund_decide',args:{_refund:'refund',_approve:true},result:{status:'approved',refund_id:'refund'}},
 {name:'neo_cash_refund_settle',args:{_refund:'refund'},result:{status:'settled',refund_id:'refund',payment_id:'payment',refund_receipt_number:'RF-1'}}
];
beforeEach(()=>vi.clearAllMocks());
describe('cash durable result contracts',()=>{
 for(const c of cases){
  it('retains the installed valid '+c.name+' contract',()=>{expect(()=>validateCashCommandInput(c.name,c.args)).not.toThrow();expect(requireCashCommandResult(c.name,c.args,c.result)).toEqual(c.result)});
  it.each([null,{},[],{ok:false,detail:'Cash action refused'}])('refuses unconfirmed '+c.name+' result %j',value=>{expect(()=>requireCashCommandResult(c.name,c.args,value)).toThrow()});
 }
 it('requires the matching cash request, payment and receipt before confirming',()=>{const c=cases[2]!;for(const patch of [{request_id:'other'},{payment_id:null},{receipt_number:' undefined '},{status:'pending'}])expect(()=>requireCashCommandResult(c.name,c.args,{...c.result,...patch})).toThrow()});
 it('preserves the installed no-till response without inventing payment evidence',()=>expect(requireCashCommandResult(cases[0]!.name,cases[0]!.args,{status:'no_till',message:'Open till'})).toMatchObject({status:'no_till'}));
 it('does not call a cancelled cash request a routed payment',()=>expect(()=>requireCashCommandResult(cases[0]!.name,cases[0]!.args,{status:'cancelled',request_id:'request'})).toThrow());
 it('accepts the installed transfer replay without a repeated transfer number',()=>expect(requireCashCommandResult(cases[5]!.name,cases[5]!.args,{status:'received',transfer_id:'transfer',idempotent:true})).toMatchObject({idempotent:true}));
 it('refuses wrong transfer identity on replay',()=>expect(()=>requireCashCommandResult(cases[5]!.name,cases[5]!.args,{status:'received',transfer_id:'other',idempotent:true})).toThrow());
 it('does not label an old approval as a newly requested rejection',()=>expect(()=>requireCashCommandResult(cases[8]!.name,{_refund:'refund',_approve:false},cases[8]!.result)).toThrow(/decision differs/));
 it.each([0,-1,NaN,Infinity,-Infinity,'50',null])('refuses invalid amount %s before a cash request',amount=>expect(()=>validateCashCommandInput(cases[0]!.name,{_folio:'folio',_amount:amount})).toThrow(/finite/));
 it('requires saved source identity and written cancellation reason',()=>{expect(()=>validateCashCommandInput('neo_cash_confirm_receipt',{_request:' '})).toThrow();expect(()=>validateCashCommandInput('neo_cash_cancel_request',{_request:'r',_reason:' '})).toThrow()});
});
type Mutation={mutationFn:(input:unknown)=>Promise<unknown>;onSuccess:(r:unknown)=>void};
const run=async(mutation:unknown,input:unknown)=>{const c=mutation as Mutation;const result=await c.mutationFn(input);c.onSuccess(result);return result};
describe('cash hooks preserve transport and success boundaries',()=>{
 it('does not toast or invalidate for an unconfirmed cash receipt',async()=>{m.rpc.mockResolvedValue({data:{status:'pending',request_id:'request'},error:null});await expect(run(useConfirmCashReceipt(),'request')).rejects.toThrow();expect(m.success).not.toHaveBeenCalled();expect(m.invalidate).not.toHaveBeenCalled()});
 it('retains the original confirmed cash RPC and receipt',async()=>{m.rpc.mockResolvedValue({data:cases[2]!.result,error:null});await run(useConfirmCashReceipt(),'request');expect(m.rpc).toHaveBeenCalledWith({},'neo_cash_confirm_receipt',{_request:'request'});expect(m.success).toHaveBeenCalledWith('Cash confirmed — receipt RCPT')});
 it('never dispatches a nonfinite amount',async()=>{await expect(run(useRequestCashPayment(),{folio:'folio',amount:Infinity})).rejects.toThrow(/finite/);expect(m.rpc).not.toHaveBeenCalled()});
 it('preserves permission denial details',async()=>{m.rpc.mockResolvedValue({data:null,error:{message:'Not your till'}});await expect(run(useConfirmCashReceipt(),'request')).rejects.toThrow('Not your till');expect(m.success).not.toHaveBeenCalled()});
 it('rejects a mismatched saved refund decision without a success toast',async()=>{m.rpc.mockResolvedValue({data:{status:'approved',refund_id:'refund',idempotent:true},error:null});await expect(run(useDecideCashRefund(),{refund:'refund',approve:false})).rejects.toThrow();expect(m.success).not.toHaveBeenCalled()});
 it('keeps valid transfer replay receipt-free and does not display undefined',async()=>{m.rpc.mockResolvedValue({data:{status:'received',transfer_id:'transfer',idempotent:true},error:null});await run(useConfirmCashTransfer(),'transfer');expect(String(m.success.mock.calls[0]?.[0])).not.toContain('undefined')});
});
