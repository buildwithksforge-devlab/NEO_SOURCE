// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { parseTillVerifiedAmount } from '@/lib/delivery-till-amount';
const m=vi.hoisted(()=>({rpc:vi.fn(),success:vi.fn(),error:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{}}));
vi.mock('@/lib/rpc-guard',()=>({guardedRpc:m.rpc}));
vi.mock('sonner',()=>({toast:{success:m.success,error:m.error}}));
vi.mock('@/components/payments/ReceivingAccountSelect',()=>({ReceivingAccountSelect:({onChange}:any)=><button onClick={()=>onChange('50000000-0000-4000-8000-000000000001')}>Choose fixture account</button>}));
import { DeliveryTillVerification } from '@/components/finance/DeliveryTillVerification';
afterEach(cleanup);
beforeEach(()=>{vi.clearAllMocks();m.rpc.mockImplementation(async(_client,name)=>({error:null,data:name==='neo_delivery_mpesa_till_claim_queue'?[{claim_id:'10000000-0000-4000-8000-000000000001',delivery_order_id:'20000000-0000-4000-8000-000000000001',order_number:'Fixture delivery',receipt_code:'ABC1234567',order_total:0.29,payment_status:'unpaid',claim_status:'submitted',submitted_at:'2026-11-06T00:00:00Z',branch_id:'30000000-0000-4000-8000-000000000001'}]:{ok:true,payment_result:{ok:true,receipt_number:'FIXTURE-ONLY',journal_number:'FIXTURE-JOURNAL'}}}));});
describe('verified Till decimal amount',()=>{
 it.each(['0.29','16.15','100','1.2','.29','0001.25',' 2.30 '])('accepts a positive exact two-decimal amount: %s',value=>expect(parseTillVerifiedAmount(value)).toBe(Number(value)));
 it.each(['','0','-1','0.001','1.234','1e3','NaN','Infinity','1,000','9007199254740992','90071992547409.91'])('rejects invalid or unsafe amount: %s',value=>expect(parseTillVerifiedAmount(value)).toBeNull());
});
async function form(amount:string,confirm=true){const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});render(<QueryClientProvider client={client}><DeliveryTillVerification/></QueryClientProvider>);fireEvent.click(await screen.findByRole('button',{name:'Review'}));fireEvent.change(screen.getByLabelText('Amount confirmed in merchant records (KES)'),{target:{value:amount}});fireEvent.change(screen.getByLabelText('Receiving merchant Till number'),{target:{value:'123456'}});fireEvent.change(screen.getByLabelText('Independent merchant verification evidence'),{target:{value:'Fixture merchant statement checked'}});fireEvent.click(screen.getByRole('button',{name:'Choose fixture account'}));if(confirm)fireEvent.click(screen.getByRole('checkbox'));return client;}
describe('actual Till approval form with mocked transport',()=>{
 it.each(['0.29','16.15'])('submits valid KES %s with required merchant/account evidence',async amount=>{const client=await form(amount);fireEvent.click(screen.getByRole('button',{name:'Verify & Post Payment'}));await waitFor(()=>expect(m.success).toHaveBeenCalledOnce());expect(m.rpc).toHaveBeenCalledWith({},'neo_delivery_mpesa_till_claim_approve',expect.objectContaining({_verified_amount:Number(amount),_merchant_till:'123456',_receiving_account:'50000000-0000-4000-8000-000000000001'}));client.clear();});
 it('blocks excessive decimal places without invoking approval',async()=>{const client=await form('1.234');fireEvent.click(screen.getByRole('button',{name:'Verify & Post Payment'}));await waitFor(()=>expect(m.error).toHaveBeenCalledWith('Enter a valid verified amount.'));expect(m.rpc.mock.calls.some(c=>c[1]==='neo_delivery_mpesa_till_claim_approve')).toBe(false);client.clear();});
 it('requires independent merchant confirmation before enabling approval',async()=>{const client=await form('0.29',false);const button=screen.getByRole('button',{name:'Verify & Post Payment'}) as HTMLButtonElement;expect(button.disabled).toBe(true);fireEvent.click(button);expect(m.rpc.mock.calls.some(c=>c[1]==='neo_delivery_mpesa_till_claim_approve')).toBe(false);client.clear();});
 it('does not show payment success for an unconfirmed posting response',async()=>{const client=await form('0.29');m.rpc.mockResolvedValueOnce({error:null,data:{ok:true}});fireEvent.click(screen.getByRole('button',{name:'Verify & Post Payment'}));await waitFor(()=>expect(m.error).toHaveBeenCalledWith('Finance approval did not confirm successful payment posting.'));expect(m.success).not.toHaveBeenCalled();client.clear();});
});
