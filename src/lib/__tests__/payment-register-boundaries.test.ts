import {invalidatePaymentViews} from '@/lib/payment-view-refresh';
import {useRecordDeposit} from '@/lib/deposits';
import {describe,it,expect,vi,beforeEach} from 'vitest';
const m=vi.hoisted(()=>({rpc:vi.fn(),invalidate:vi.fn(),auth:{organizationId:'org',user:{id:'worker'},phase:'ready',permissions:new Set(['finance.view']),permissionsLoaded:true,accessLoaded:true,access:{accessScope:'branch',branchIds:['branch'],departmentIds:[],stationIds:[],roleIds:[]}}}));
vi.mock('@/lib/auth',()=>({useAuth:()=>m.auth}));vi.mock('@/lib/rpc-guard',()=>({guardedRpc:m.rpc}));vi.mock('@/integrations/supabase/client',()=>({supabase:{}}));vi.mock('@tanstack/react-query',()=>({useQuery:(x:unknown)=>x,useMutation:(x:unknown)=>x,useQueryClient:()=>({invalidateQueries:m.invalidate})}));vi.mock('sonner',()=>({toast:{success:vi.fn(),warning:vi.fn(),error:vi.fn()}}));
import {parsePaymentRegister,paymentEvidenceLabel,canVerifyRegisterRow} from '@/lib/payment-register-contract';
import {usePaymentRegister,summarisePaymentRegister,type PaymentAttempt} from '@/lib/payment-register';
const row:PaymentAttempt={id:'deposit',branch_id:'branch',source_module:'deposit',source_record_id:'reservation',payment_table:'reservation_deposits',payment_id:'deposit',method:'cash',provider_code:null,environment:null,amount:100,currency:'KES',tendered:null,change_due:null,reference:'D-1',state:'confirmed',state_detail:'Recorded deposit',manual_tender:true,verified_at:null,posted_journal_id:null,requested_at:'2026-11-09T09:00:00Z',confirmed_at:'2026-11-09T09:00:00Z'};
beforeEach(()=>{vi.clearAllMocks();m.rpc.mockResolvedValue({data:[row],error:null});m.auth.organizationId='org';m.auth.user.id='worker';m.auth.phase='ready';m.auth.permissionsLoaded=true;m.auth.accessLoaded=true;m.auth.permissions=new Set(['finance.view']);m.auth.access.branchIds=['branch'];});
describe('payment register contracts',()=>{
 it('retains an actual deposit without inventing tender/change or journal proof',()=>expect(parsePaymentRegister([row])[0]).toEqual(row));
 it.each([null,{},'error',false])('rejects a broken response instead of showing zero payments: %s',value=>expect(()=>parsePaymentRegister(value)).toThrow(/could not be verified/));
 it.each([NaN,Infinity,-Infinity,null,undefined,'not-money',0,-1])('rejects invalid received amount %s',amount=>expect(()=>parsePaymentRegister([{...row,amount}])).toThrow());
 it('accepts the documented numeric representation',()=>expect(parsePaymentRegister([{...row,amount:'100.50'}])[0]?.amount).toBe(100.5));
 it('rejects duplicate collection identity before computing totals',()=>expect(()=>parsePaymentRegister([row,{...row,id:'alias'}])).toThrow());
 it('accepts a genuine second collection with its own identity',()=>expect(summarisePaymentRegister(parsePaymentRegister([row,{...row,id:'second',payment_id:'second',amount:50}])).received).toBe(150));
 it('pending and refunded money do not settle a reservation balance',()=>{const totals=summarisePaymentRegister(parsePaymentRegister([{...row,state:'pending'},{...row,id:'refund',payment_id:'refund',state:'refunded'}]));expect(totals.received).toBe(0);expect(totals.awaiting).toBe(100)});
 it('a received deposit is not automatically revenue or ledger-posted',()=>expect(summarisePaymentRegister([row]).posted).toBe(0));
 it('leaves independent manual verification outstanding',()=>expect(summarisePaymentRegister([row]).unverified).toBe(1));
 it('does not send a source-only deposit ID to the attempt verification command',()=>expect(canVerifyRegisterRow(row)).toBe(false));
 it('retains verification for a real unverified payment attempt',()=>expect(canVerifyRegisterRow({...row,payment_table:'payments'})).toBe(true));
 it('never labels a manual deposit as provider-confirmed',()=>expect(paymentEvidenceLabel(row)).toBe('Deposit recorded'));
 it('never labels cash as provider-confirmed',()=>expect(paymentEvidenceLabel({...row,payment_table:'pos_payments',manual_tender:false})).toBe('Cash collection'));
 it('does not turn a timestamp error into a valid collection',()=>expect(()=>parsePaymentRegister([{...row,requested_at:'bad'}])).toThrow());
});
type Q={queryKey:unknown[];enabled:boolean;queryFn:()=>Promise<unknown>};const query=()=>usePaymentRegister({branchId:'branch'}) as unknown as Q;
describe('payment register identity boundaries',()=>{
 it.each(['signed-out','authenticating','resolving-account','resolving-access','suspended','denied','reauth-required','error'])('waits during %s',phase=>{m.auth.phase=phase;expect(query().enabled).toBe(false)});
 it('waits for resolved permissions and scope',()=>{m.auth.permissionsLoaded=false;expect(query().enabled).toBe(false);m.auth.permissionsLoaded=true;m.auth.accessLoaded=false;expect(query().enabled).toBe(false)});
 it('requires the worker and organization',()=>{m.auth.organizationId='';expect(query().enabled).toBe(false);m.auth.organizationId='org';m.auth.user.id='';expect(query().enabled).toBe(false)});
 it('separates organizations',()=>{const a=query().queryKey;m.auth.organizationId='other';expect(query().queryKey).not.toEqual(a)});
 it('separates workers',()=>{const a=query().queryKey;m.auth.user.id='other';expect(query().queryKey).not.toEqual(a)});
 it('separates effective property access',()=>{const a=query().queryKey;m.auth.access.branchIds=['other'];expect(query().queryKey).not.toEqual(a)});
 it('separates changed authority',()=>{const a=query().queryKey;m.auth.permissions=new Set(['finance.edit']);expect(query().queryKey).not.toEqual(a)});
 it('returns the verified source response',async()=>expect(await query().queryFn()).toEqual([row]));
 it('rejects null success instead of a false empty register',async()=>{m.rpc.mockResolvedValue({data:null,error:null});await expect(query().queryFn()).rejects.toThrow(/could not be verified/)});
 it('propagates a server refusal',async()=>{m.rpc.mockResolvedValue({data:null,error:{message:'Property denied'}});await expect(query().queryFn()).rejects.toThrow('Property denied')});
});

describe('one payment refreshes every balance view',()=>{
 it('refreshes reservation, ledger, register, folio, lifecycle and till caches together',()=>{invalidatePaymentViews({invalidateQueries:m.invalidate});for(const key of ['pms','finance','payment-register','folio-projection','payment-lifecycle','payment-audit-trail','cash'])expect(m.invalidate).toHaveBeenCalledWith({queryKey:[key]});});
 it('recording a persisted deposit refreshes the register and folio balance',()=>{const hook=useRecordDeposit() as unknown as {onSuccess:(r:unknown)=>void};hook.onSuccess({deposit_id:'deposit',finance:{ok:true}});expect(m.invalidate).toHaveBeenCalledWith({queryKey:['payment-register']});expect(m.invalidate).toHaveBeenCalledWith({queryKey:['folio-projection']});});
});

