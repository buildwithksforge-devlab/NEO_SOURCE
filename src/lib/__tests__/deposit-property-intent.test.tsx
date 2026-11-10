// @vitest-environment jsdom
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,cleanup} from '@testing-library/react';
const m=vi.hoisted(()=>({record:vi.fn(),zone:'Africa/Nairobi' as string|null,clock:vi.fn()}));
vi.mock('@/lib/auth',()=>({useAuth:()=>({can:()=>true})}));
vi.mock('@/lib/use-property-clock',()=>({usePropertyClock:(id:string|null)=>{m.clock(id);return {timeZone:m.zone}}}));
vi.mock('@/components/payments/PaymentMethodPicker',()=>({PaymentMethodPicker:()=>null}));
vi.mock('@/lib/deposits',async original=>({...await original<typeof import('@/lib/deposits')>(),useDepositPosition:()=>({data:{ok:true,required:10000,paid:0,held:0,applied:0,outstanding:10000},isLoading:false,error:null}),useRecordDeposit:()=>({mutate:m.record,isPending:false}),useDepositOverride:()=>({mutate:vi.fn(),isPending:false})}));
import {DepositPanel} from '@/components/pms/DepositPanel';
import {depositIdempotencyKey} from '@/lib/deposits';
beforeEach(()=>{vi.clearAllMocks();m.zone='Africa/Nairobi';vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-07T22:30:00Z'))});
afterEach(()=>{cleanup();vi.useRealTimers()});
describe('deposit intent follows the reservation, not the header',()=>{
 it('uses the reservation property and property-local business date',()=>{render(<DepositPanel reservationId="reservation" branchId="record-property"/>);fireEvent.change(screen.getByLabelText('Amount'),{target:{value:'5000'}});fireEvent.click(screen.getByText('Record deposit'));expect(m.clock).toHaveBeenCalledWith('record-property');expect(m.record).toHaveBeenCalledWith(expect.objectContaining({idempotencyKey:depositIdempotencyKey({reservationId:'reservation',propertyId:'record-property',amount:5000,method:'cash',businessDate:'2026-11-08'})}),expect.anything())});
 it('does not record under a missing property or unknown property clock',()=>{m.zone=null;render(<DepositPanel reservationId="reservation" branchId="record-property"/>);fireEvent.change(screen.getByLabelText('Amount'),{target:{value:'5000'}});fireEvent.click(screen.getByText('Record deposit'));expect(m.record).not.toHaveBeenCalled()});
});
