// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({cash:vi.fn(),pay:vi.fn()}));
vi.mock('@/lib/auth',()=>({useAuth:()=>({can:()=>true})}));
vi.mock('@/lib/deposits',()=>({depositGate:vi.fn(),useDepositPosition:()=>({})}));
vi.mock('@/components/pms/DepositPanel',()=>({DepositPanel:()=>null}));
vi.mock('@/lib/branch-filter',()=>({useActivePropertyFilter:()=>({branchId:'branch'})}));
vi.mock('@/lib/pos-data',()=>({useMyOpenShift:()=>({})}));
vi.mock('@/lib/frontdesk-ops',()=>({useOpenCashShift:()=>({})}));
vi.mock('@/lib/cash-routing',()=>({useFolioCashRequests:()=>({data:[]}),useRequestCashPayment:()=>({mutateAsync:m.cash,isPending:false}),useTillContext:()=>({data:{self_service:true},isLoading:false})}));
vi.mock('@/lib/pms-data',()=>({useAssignRoom:vi.fn(),useAvailability:vi.fn(),useCheckIn:vi.fn(),useCheckOut:vi.fn(),usePostCharge:vi.fn(),useReceivingAccounts:()=>({data:[]}),useRecordPayment:()=>({mutateAsync:m.pay,isPending:false}),useTransferRoom:vi.fn()}));
vi.mock('@/components/payments/PaymentMethodPicker',()=>({PaymentMethodPicker:()=>null}));
import {RecordPaymentDialog} from '@/components/pms/ReservationActions';
afterEach(cleanup);beforeEach(()=>{vi.clearAllMocks();m.cash.mockResolvedValue({status:'confirmed',request_id:'request',payment_id:'payment'});});
const open=()=>fireEvent.click(screen.getByRole('button',{name:'Record payment'}));
const submit=()=>fireEvent.click(screen.getByRole('button',{name:'Confirm cash received'}));
describe('PMS cash dialog collection recovery',()=>{
 it('passes one stable collection key through a failed retry and reopening',async()=>{
  m.cash.mockRejectedValueOnce(new Error('Connection interrupted'));
  render(<RecordPaymentDialog folioId="folio" balance={100}/>);open();submit();
  await screen.findByRole('alert');const first=m.cash.mock.calls[0]![0];expect(first.idempotencyKey).toMatch(/^pms-collection:folio:/);
  fireEvent.click(screen.getByRole('button',{name:'Cancel'}));open();submit();
  await waitFor(()=>expect(m.cash).toHaveBeenCalledTimes(2));expect(m.cash.mock.calls[1]![0].idempotencyKey).toBe(first.idempotencyKey);
 });
 it('keeps a no-drawer refusal open',async()=>{m.cash.mockResolvedValue({status:'no_till',message:'Drawer closed'});render(<RecordPaymentDialog folioId="folio" balance={100}/>);open();submit();expect((await screen.findByRole('alert')).textContent).toContain('Drawer closed');expect(screen.getByRole('dialog')).toBeTruthy();});
 it('refreshes the suggested balance and key for a genuine next collection',async()=>{const view=render(<RecordPaymentDialog folioId="folio" balance={100}/>);open();submit();await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());const key=m.cash.mock.calls[0]![0].idempotencyKey;view.rerender(<RecordPaymentDialog folioId="folio" balance={40}/>);open();expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('40');submit();await waitFor(()=>expect(m.cash).toHaveBeenCalledTimes(2));expect(m.cash.mock.calls[1]![0].idempotencyKey).not.toBe(key);});
});
