// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {checkoutPosition,type CheckoutFolio} from "@/lib/checkout-reconciliation";
const state=vi.hoisted(()=>({data:null as any,error:null as Error|null,fetching:false,success:true,pending:false,override:false,checkout:vi.fn(),refetch:vi.fn()}));
vi.mock("@/lib/auth",()=>({useAuth:()=>({isAdmin:false,can:(_module:string,feature:string)=>feature==="departures.edit"||(feature==="folio.override"&&state.override)})}));
vi.mock("@/lib/checkout-position",()=>({useCheckoutPosition:()=>({data:state.data,error:state.error,isPending:state.pending,isSuccess:state.success,isError:!!state.error,isFetching:state.fetching,refetch:state.refetch})}));
vi.mock("@/lib/pms-data",()=>({useCheckOut:()=>({mutateAsync:state.checkout,isPending:false}),useRecordPayment:()=>({}),useReceivingAccounts:()=>({data:[]})}));
vi.mock("@/lib/deposits",()=>({depositGate:vi.fn(),useDepositPosition:vi.fn()}));
vi.mock("@/components/pms/DepositPanel",()=>({DepositPanel:()=>null}));
vi.mock("@/lib/pos-data",()=>({useMyOpenShift:()=>({})}));
vi.mock("@/lib/frontdesk-ops",()=>({useOpenCashShift:()=>({})}));
vi.mock("@/lib/branch-filter",()=>({useActivePropertyFilter:()=>({branchId:"hotel-a"})}));
vi.mock("@/lib/cash-routing",()=>({useTillContext:()=>({data:null}),useRequestCashPayment:()=>({}),useFolioCashRequests:()=>({data:[]})}));
vi.mock("@/components/common/PermittedLink",()=>({PermittedLink:({params,children}:any)=><a href={`/pms/folios/${params.id}`}>{children}</a>}));
const {CheckOutDialog}=await import("@/components/pms/ReservationActions");
const reservation={id:"00000000-0000-4000-8000-000000000004",confirmation_number:"RES-4",status:"checked-in",room_id:"room",room_type_id:null,arrival_date:"2026-11-17",departure_date:"2026-11-18",adults:1,children:0,branch_id:"hotel-a"};
const folio=(n:number,balance=0):CheckoutFolio=>({id:`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`,number:`F-${n}`,type:n===1?"guest":"corporate",currency:"KES",status:"open",charges:100,collected:100-balance,outstanding:balance});
async function open(){render(<CheckOutDialog reservation={reservation}/>);fireEvent.click(screen.getByRole("button",{name:"Check out"}));await screen.findByRole("button",{name:"Complete check-out"});}
beforeEach(()=>{vi.clearAllMocks();state.data=checkoutPosition([folio(1),folio(2)]);state.error=null;state.success=true;state.pending=false;state.fetching=false;state.override=false;state.checkout.mockResolvedValue({});});
afterEach(cleanup);
describe("checkout review across all folios",()=>{
 it("shows both folios with direct settlement/history links and submits the current reservation",async()=>{
  await open();expect(screen.getByRole("link",{name:"F-1"}).getAttribute("href")).toContain("000000000001");expect(screen.getByRole("link",{name:"F-2"})).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:"Complete check-out"}));
  await waitFor(()=>expect(state.checkout).toHaveBeenCalledWith({reservation:reservation.id,force:false,notes:""}));
 });
 it("blocks unknown or failed financial reads rather than assuming zero",async()=>{
  state.data=null;state.success=false;state.error=new Error("Finance unavailable");
  await open();expect(screen.getByRole("alert").textContent).toContain("Finance unavailable");
  expect((screen.getByRole("button",{name:"Complete check-out"}) as HTMLButtonElement).disabled).toBe(true);
 });
 it("blocks credit netting even for a role allowed to override debt",async()=>{
  state.data=checkoutPosition([folio(1,-50),folio(2,50)]);state.override=true;
  await open();expect(screen.getByRole("alert").textContent).toContain("cannot cancel another folio");
  fireEvent.click(screen.getByRole("switch"));fireEvent.change(screen.getByLabelText("Check-out notes"),{target:{value:"Approved"}});
  expect((screen.getByRole("button",{name:"Complete check-out"}) as HTMLButtonElement).disabled).toBe(true);
 });
 it("requires both override capability and a written reason for unpaid folios",async()=>{
  state.data=checkoutPosition([folio(1),folio(2,50)]);state.override=true;
  await open();const submit=screen.getByRole("button",{name:"Complete check-out"}) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);fireEvent.click(screen.getByRole("switch"));expect(submit.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Check-out notes"),{target:{value:"Approved credit departure"}});expect(submit.disabled).toBe(false);
 });
 it("does not enable an override switch for staff without the capability",async()=>{
  state.data=checkoutPosition([folio(1,50)]);await open();expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
 });
 it("blocks checkout while refreshing balances",async()=>{
  state.fetching=true;await open();expect((screen.getByRole("button",{name:"Complete check-out"}) as HTMLButtonElement).disabled).toBe(true);
 });
});
