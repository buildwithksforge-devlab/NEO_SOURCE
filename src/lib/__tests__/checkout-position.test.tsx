// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {renderHook,waitFor} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import type {ReactNode} from "react";
const state=vi.hoisted(()=>({branch:"hotel-a",ready:true,reads:vi.fn(),rpc:vi.fn(),folios:[] as any[]}));
vi.mock("@/lib/auth",()=>({useAuth:()=>({organizationId:"org",user:{id:"staff"},permissionsLoaded:state.ready})}));
vi.mock("@/lib/branch-filter",()=>({useActivePropertyFilter:()=>({branchId:state.branch,filterKey:state.branch})}));
vi.mock("@/integrations/supabase/client",()=>({supabase:{from:(table:string)=>{
 const filters:unknown[]=[];
 const query:any={select:vi.fn(()=>query),eq:vi.fn((...args)=>{filters.push(args);return query;}),
  maybeSingle:vi.fn(async()=>{state.reads(table,filters);return {data:{id:"stay",branch_id:"hotel-a"},error:null};}),
  order:vi.fn(async()=>{state.reads(table,filters);return {data:state.folios,error:null};})};return query;
}}}));
vi.mock("@/lib/rpc-guard",()=>({guardedRpc:(...args:unknown[])=>state.rpc(...args)}));
const {useCheckoutPosition}=await import("@/lib/checkout-position");
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const clients:QueryClient[]=[];
function mount(){
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});clients.push(client);
 const wrapper=({children}:{children:ReactNode})=><QueryClientProvider client={client}>{children}</QueryClientProvider>;
 return renderHook(()=>useCheckoutPosition("reservation",true),{wrapper});
}
beforeEach(()=>{
 vi.clearAllMocks();state.branch="hotel-a";state.ready=true;
 state.folios=[1,2].map(n=>({id:id(n),branch_id:"hotel-a",reservation_id:"reservation",folio_number:`F-${n}`,folio_type:n===1?"guest":"corporate",currency:"KES",status:"open"}));
 state.rpc.mockImplementation(async(_client,_name,args)=>({data:{found:true,folio_id:args._folio,branch_id:"hotel-a",currency:"KES",gross_obligation:100,collected:args._folio===id(1)?150:50,outstanding:args._folio===id(1)?-50:50},error:null}));
});
afterEach(()=>{clients.splice(0).forEach(c=>c.clear());});
describe("checkout review reads canonical positions for all stay folios",()=>{
 it("scopes stay/folio reads to the organization and keeps credits separate from debt",async()=>{
  const hook=mount();await waitFor(()=>expect(hook.result.current.isSuccess).toBe(true));
  expect(hook.result.current.data).toMatchObject({amountDue:50,creditDue:50});
  expect(state.rpc).toHaveBeenCalledTimes(2);
  expect(state.reads).toHaveBeenCalledWith("folios",[["organization_id","org"],["stay_id","stay"]]);
  hook.unmount();
 });
 it("fails the whole review if one canonical projection fails",async()=>{
  state.rpc.mockResolvedValue({data:null,error:new Error("Guest ledger unavailable")});
  const hook=mount();await waitFor(()=>expect(hook.result.current.isError).toBe(true));
  expect(hook.result.current.data).toBeUndefined();hook.unmount();
 });
 it("refuses stale reservation data after selecting another property",async()=>{
  state.branch="hotel-b";const hook=mount();await waitFor(()=>expect(hook.result.current.isError).toBe(true));
  expect(state.rpc).not.toHaveBeenCalled();hook.unmount();
 });
 it("does not read financial data while role permissions are unresolved",()=>{
  state.ready=false;const hook=mount();expect(state.reads).not.toHaveBeenCalled();expect(state.rpc).not.toHaveBeenCalled();hook.unmount();
 });
 it("includes stay-linked corporate folios with no reservation foreign key",async()=>{
  state.folios[1].reservation_id=null;const hook=mount();await waitFor(()=>expect(hook.result.current.isSuccess).toBe(true));
  expect(hook.result.current.data?.folios).toHaveLength(2);hook.unmount();
 });
});
