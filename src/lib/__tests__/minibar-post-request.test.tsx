// @vitest-environment jsdom
import {act,renderHook} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import type {ReactNode} from "react";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
const state=vi.hoisted(()=>({rpc:vi.fn(),success:vi.fn(),error:vi.fn()}));
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
vi.mock("@/lib/auth",()=>({useAuth:()=>({organizationId:"00000000-0000-4000-8000-000000000001",user:{id:"00000000-0000-4000-8000-000000000002"}})}));
vi.mock("@/integrations/supabase/client",()=>({supabase:{}}));
vi.mock("@/lib/branch-filter",()=>({useActivePropertyFilter:()=>({})}));
vi.mock("@/lib/rpc-guard",()=>({guardedRpc:(...args:unknown[])=>state.rpc(...args)}));
vi.mock("@/lib/supply-view-refresh",()=>({invalidateSupplyViews:vi.fn()}));
vi.mock("sonner",()=>({toast:{success:(...args:unknown[])=>state.success(...args),error:(...args:unknown[])=>state.error(...args)}}));
const {usePostMinibar}=await import("../minibar");
const clients:QueryClient[]=[];
function mount(){
 const client=new QueryClient({defaultOptions:{mutations:{retry:false}}});clients.push(client);
 return renderHook(()=>usePostMinibar(),{wrapper:({children}:{children:ReactNode})=><QueryClientProvider client={client}>{children}</QueryClientProvider>});
}
const input={folioId:id(3),locationId:id(4),roomId:id(5),notes:null,lines:[{menu_item_id:id(6),description:"Water",quantity:2,unit_price:100}]};
beforeEach(()=>{
 localStorage.clear();vi.clearAllMocks();
 Object.defineProperty(navigator,"locks",{configurable:true,value:{request:async(_key:string,callback:()=>unknown)=>callback()}});
 state.rpc.mockImplementation(async(_client,_name,args)=>({data:{ok:true,posting_id:id(7),posting_number:"MB-1",lines:1,total:200,
  attempt_id:args._attempt,folio_id:args._folio,location_id:args._location,room_id:args._room,replayed:false},error:null}));
});
afterEach(()=>clients.splice(0).forEach(client=>client.clear()));
describe("Minibar request dispatch and uncertain outcomes",()=>{
 it("retains the same key after network failure, success and hook remount until an explicit new charge",async()=>{
  const hook=mount();state.rpc.mockRejectedValueOnce(new Error("connection lost"));
  await act(async()=>{await expect(hook.result.current.mutateAsync(input)).rejects.toThrow(/connection lost/);});
  const key=state.rpc.mock.calls[0]![2]._attempt;
  await act(async()=>{await hook.result.current.mutateAsync(input);});
  expect(state.rpc.mock.calls[1]![2]._attempt).toBe(key);
  hook.unmount();const remounted=mount();
  await act(async()=>{await remounted.result.current.mutateAsync(input);});
  expect(state.rpc.mock.calls[2]![2]._attempt).toBe(key);
  expect(state.rpc.mock.calls.every(call=>call[1]==="neo_minibar_post_once")).toBe(true);remounted.unmount();
 });
 it("does not fall back to the unkeyed RPC when the database repair is absent",async()=>{
  state.rpc.mockResolvedValue({data:null,error:{code:"PGRST202",message:"function missing"}});const hook=mount();
  await act(async()=>{await expect(hook.result.current.mutateAsync(input)).rejects.toThrow(/matching database repair/);});
  expect(state.rpc).toHaveBeenCalledTimes(1);expect(localStorage.length).toBe(1);expect(state.success).not.toHaveBeenCalled();hook.unmount();
 });
 it("refuses a mismatched saved result and retains its request for review",async()=>{
  state.rpc.mockResolvedValue({data:{ok:true,posting_id:id(7),posting_number:"MB-1",lines:1,total:200,attempt_id:id(99),folio_id:id(3),location_id:id(4),room_id:id(5),replayed:false},error:null});
  const hook=mount();await act(async()=>{await expect(hook.result.current.mutateAsync(input)).rejects.toThrow(/not confirmed/);});
  expect(state.success).not.toHaveBeenCalled();expect(localStorage.length).toBe(1);hook.unmount();
 });
 it("refuses to dispatch without secure cross-tab request storage",async()=>{
  Object.defineProperty(navigator,"locks",{configurable:true,value:undefined});const hook=mount();
  await act(async()=>{await expect(hook.result.current.mutateAsync(input)).rejects.toThrow(/secure minibar request storage/);});
  expect(state.rpc).not.toHaveBeenCalled();hook.unmount();
 });
});
