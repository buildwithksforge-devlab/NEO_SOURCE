import {beforeEach,describe,expect,it,vi} from "vitest";
const state=vi.hoisted(()=>({organization:"tenant-alpha",branch:"property-a" as string|null,calls:[] as string[]}));
vi.mock("@/lib/auth",()=>({useAuth:()=>({organizationId:state.organization,user:{id:"staff"}})}));
vi.mock("@/lib/branch-filter",()=>({
 useWriteBranchId:()=>state.branch,
 useActivePropertyFilter:()=>({filterKey:state.branch??"all",applyTo:(q:any,table:string)=>{
  state.calls.push(`scope:${table}`);return state.branch?q.eq("branch_id",state.branch):q;
 }}),
}));
vi.mock("@tanstack/react-query",()=>({useQuery:(options:any)=>options,useMutation:vi.fn(),useQueryClient:vi.fn()}));
vi.mock("@/integrations/supabase/client",()=>({supabase:{from:(table:string)=>{
 state.calls.push(`table:${table}`);
 const query:any={select:()=>query,eq:(key:string,value:string)=>{state.calls.push(`${key}:${value}`);return query;},order:async()=>({data:[],error:null})};
 return query;
}}}));
const {useKitchenMenuItems}=await import("../kitchen-data");
describe("recipe/menu picker follows every tenant and selected property",()=>{
 beforeEach(()=>{state.organization="tenant-alpha";state.branch="property-a";state.calls=[];});
 it("narrows reads to the current organization and selected property",async()=>{
  const options=useKitchenMenuItems() as any;await options.queryFn();
  expect(state.calls).toContain("organization_id:tenant-alpha");expect(state.calls).toContain("branch_id:property-a");
  expect(options.queryKey).toEqual(["kitchen","menu-items","tenant-alpha","property-a"]);
 });
 it("changes both data filters and cache when switching hotel or tenant",async()=>{
  const first=(useKitchenMenuItems() as any).queryKey;
  state.organization="tenant-beta";state.branch="property-b";
  const next=useKitchenMenuItems() as any;await next.queryFn();
  expect(next.queryKey).not.toEqual(first);expect(state.calls).toContain("organization_id:tenant-beta");expect(state.calls).toContain("branch_id:property-b");
 });
 it("keeps all-properties reads within the current organization",async()=>{
  state.branch=null;const options=useKitchenMenuItems() as any;await options.queryFn();
  expect(state.calls).toContain("organization_id:tenant-alpha");expect(state.calls.some(c=>c.startsWith("branch_id:"))).toBe(false);
  expect(options.queryKey.at(-1)).toBe("all");
 });
});
