// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
const state=vi.hoisted(()=>({status:"checked-in",verified:true,payment:vi.fn(),save:vi.fn(),from:vi.fn(),audit:vi.fn(),error:vi.fn()}));
vi.mock("@tanstack/react-router",()=>({createFileRoute:()=>((definition:any)=>({...definition,useParams:()=>({id:"reservation"})})),Link:({children}:any)=><a>{children}</a>}));
vi.mock("@/lib/auth",()=>({useAuth:()=>({organizationId:"org",user:{id:"staff"},profile:{full_name:"Staff"},can:()=>true})}));
vi.mock("@/lib/audit",()=>({logAudit:(...args:unknown[])=>state.audit(...args)}));
vi.mock("sonner",()=>({toast:{success:vi.fn(),error:(...args:unknown[])=>state.error(...args)}}));
vi.mock("@/integrations/supabase/client",()=>({supabase:{from:(...args:unknown[])=>state.from(...args)}}));
vi.mock("@/lib/pms-data",()=>({
 useReservation:()=>({data:{id:"reservation",confirmation_number:"R-1",status:state.status,currency:"KES",branch_id:"branch",reservation_type:"individual",arrival_date:"2026-11-18",departure_date:"2026-11-21",nights:3,adults:1,children:0,nightly_rate:10000,total_amount:30000,deposit_required:5000,customers:{full_name:"Guest"}},isLoading:false}),
 useReservationFolios:()=>({data:[{id:"folio",folio_number:"F-1",status:"open",currency:"KES",total_charges:99999,total_payments:88888,balance:11111,folio_lines:[]}],isLoading:false,isError:false}),
 useReservationHistory:()=>({data:[]}),
}));
vi.mock("@/lib/reservation-collections",()=>({useReservationCollectionPosition:()=>({data:{currency:"KES",quote:30000,obligation:30000,collected:5000,deposit_paid:5000,pending:2000,outstanding:25000,credit:0,headroom:23000,payment_status:"part-paid"},isSuccess:true,isFetching:false,error:null})}));
vi.mock("@/lib/checkout-position",()=>({useCheckoutPosition:()=>({isSuccess:state.verified,isError:!state.verified,isFetching:false,isPending:false,data:state.verified?{currency:"KES",mixedCurrency:false,amountDue:5000,creditDue:0,folios:[{id:"folio",currency:"KES",charges:10000,collected:5000,outstanding:5000}]}:undefined})}));
vi.mock("@/components/pms/ReservationActions",()=>({AssignRoomDialog:()=>null,CheckInDialog:()=>null,CheckOutDialog:()=>null,PostChargeDialog:()=>null,
 RecordPaymentDialog:(props:unknown)=>{state.payment(props);return <button>Record payment</button>;}}));
vi.mock("@/components/pms/PmsShared",()=>({PmsGuard:({children}:any)=><>{children}</>,EmptyState:({title}:any)=><p>{title}</p>,FolioStatusBadge:()=>null,ReservationStatusBadge:()=>null,QueryState:({children}:any)=><>{children}</>}));
vi.mock("@/components/pms/DepositPanel",()=>({DepositPanel:()=>null}));
vi.mock("@/components/pms/ReservationCollections",()=>({ReservationCollections:()=>null}));
vi.mock("@/components/payments/MpesaPromptDialog",()=>({MpesaPromptDialog:()=>null}));
vi.mock("@/components/ui/tabs",()=>({Tabs:({children}:any)=><div>{children}</div>,TabsList:({children}:any)=><div>{children}</div>,TabsTrigger:({children}:any)=><span>{children}</span>,TabsContent:({children}:any)=><div>{children}</div>}));
const {ReservationDetail}=await import("@/routes/_shell.pms.reservations.$id");
const clients:QueryClient[]=[];
function mount(){const client=new QueryClient({defaultOptions:{mutations:{retry:false}}});clients.push(client);return render(<QueryClientProvider client={client}><ReservationDetail/></QueryClientProvider>);}
beforeEach(()=>{
 vi.clearAllMocks();state.status="checked-in";state.verified=true;state.save.mockResolvedValue({data:null,error:null});
 state.from.mockImplementation(()=>{const query:any={update:()=>query,eq:()=>query,select:()=>query,maybeSingle:()=>state.save(),insert:vi.fn()};return query;});
});
afterEach(()=>{cleanup();clients.splice(0).forEach(client=>client.clear());});
describe("reservation detail keeps booking collection and posted bill evidence separate",()=>{
 it("displays canonical posted charges instead of cached totals and labels the booking-wide payment capacity",()=>{
  mount();expect(screen.queryByText(/99,999|88,888|11,111/)).toBeNull();
  expect(screen.getByText(/Posted charges KES 10,000/)).toBeTruthy();
  expect(screen.getByText(/Posted folio amount due KES 5,000/)).toBeTruthy();
  expect(screen.getByText("Booking amount still due")).toBeTruthy();
  expect(state.payment).toHaveBeenCalledWith(expect.objectContaining({folioId:"folio",balance:23000,balanceLabel:expect.stringContaining("whole booking")}));
 });
 it("withdraws financial actions when the canonical folio read fails instead of using stored balances",()=>{
  state.verified=false;mount();expect(state.payment).not.toHaveBeenCalled();expect(screen.queryByText(/11,111/)).toBeNull();
  expect(screen.getByText(/Posted folio totals could not be verified/)).toBeTruthy();
 });
 it("does not offer cancellation/no-show as a way to change the money of an active stay",()=>{
  mount();expect((screen.getByRole("button",{name:"Cancel reservation"}) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button",{name:"Mark as no-show"}) as HTMLButtonElement).disabled).toBe(true);
 });
 it("does not report a stale pre-arrival status change as saved or write its history",async()=>{
  state.status="confirmed";mount();fireEvent.change(screen.getByRole("textbox"),{target:{value:"Guest cancelled"}});
  fireEvent.click(screen.getByRole("button",{name:"Cancel reservation"}));
  await waitFor(()=>expect(state.error).toHaveBeenCalledWith(expect.stringContaining("was not saved")));
  expect(state.audit).not.toHaveBeenCalled();expect(state.from).toHaveBeenCalledTimes(1);
 });
});
