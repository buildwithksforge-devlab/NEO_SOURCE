import { beforeEach,describe,expect,it,vi } from "vitest";
import { useCreateLaundryOrder,usePostLaundryCharge,useAdvanceLaundryOrder } from "@/lib/operations-data";
import { laundryCatalogueRate } from "@/lib/laundry-intake";
const mocks=vi.hoisted(()=>({rpc:vi.fn(),from:vi.fn(),success:vi.fn(),warning:vi.fn(),error:vi.fn(),invalidate:vi.fn(),branch:"branch-1" as string|null}));
vi.mock("@/integrations/supabase/client",()=>({supabase:{from:mocks.from}}));
vi.mock("@/lib/rpc-guard",()=>({guardedRpc:mocks.rpc}));
vi.mock("@tanstack/react-query",()=>({useMutation:(options:unknown)=>options,useQuery:vi.fn(),useQueryClient:()=>({invalidateQueries:mocks.invalidate})}));
vi.mock("@/lib/auth",()=>({useAuth:()=>({organizationId:"org-1",profile:{department_id:"laundry"},user:{id:"actor-1"}})}));
vi.mock("@/lib/branch-filter",()=>({useWriteBranchId:()=>mocks.branch,useActivePropertyFilter:()=>({branchId:mocks.branch})}));
vi.mock("@/lib/realtime-scope",()=>({useScopedRealtime:vi.fn()}));
vi.mock("@/lib/scoped-options",()=>({useScopedDepartments:vi.fn(),useScopedWorkers:vi.fn()}));
vi.mock("@/lib/audit",()=>({logAudit:vi.fn()}));
vi.mock("@/lib/guard-violations",()=>({withGuardCapture:vi.fn()}));
vi.mock("sonner",()=>({toast:{success:mocks.success,warning:mocks.warning,error:mocks.error}}));
type Mutation={mutationFn:(input:unknown)=>Promise<unknown>;onSuccess:(result:unknown)=>void};
const input={roomId:"room-1",express:false,intentKey:"attempt-1",items:[{price_item_id:"price-1",quantity:2}]};
const saved={ok:true,order_id:"order-1",laundry_number:"LN-001",folio_id:"folio-1",reservation_id:"stay-reservation-1"};
beforeEach(()=>{vi.clearAllMocks();mocks.branch="branch-1";mocks.from.mockImplementation(()=>{throw new Error("Intake must not perform split direct table writes");});});
describe("laundry mutation durable boundaries",()=>{
 it("saves header and garments through one RPC with a stable business identity",async()=>{
  mocks.rpc.mockResolvedValue({data:saved,error:null});const mutation=useCreateLaundryOrder() as unknown as Mutation;
  expect(await mutation.mutationFn(input)).toEqual(saved);
  expect(mocks.rpc).toHaveBeenCalledWith(expect.anything(),"neo_laundry_order_create",{
   _branch:"branch-1",_room:"room-1",_items:input.items,_idempotency_key:"attempt-1",_express:false,_instructions:null,
  });expect(mocks.from).not.toHaveBeenCalled();
 });
 it.each([null,{}, {...saved,ok:false}, {...saved,folio_id:null}])("does not accept incomplete intake proof %j",async data=>{
  mocks.rpc.mockResolvedValue({data,error:null});await expect((useCreateLaundryOrder() as unknown as Mutation).mutationFn(input)).rejects.toThrow();
 });
 it("rejects intake without a selected write property before dispatch",async()=>{
  mocks.branch=null;await expect((useCreateLaundryOrder() as unknown as Mutation).mutationFn(input)).rejects.toThrow("Select the property");expect(mocks.rpc).not.toHaveBeenCalled();
 });
 it.each([null,{}, {ok:false,detail:"Guest folio is closed"}, {ok:true,folio_charged:false}, {ok:true,folio_charged:true,folio_id:"folio-1"}])("does not announce a posting without a saved folio line %j",async data=>{
  mocks.rpc.mockResolvedValue({data,error:null});await expect((usePostLaundryCharge() as unknown as Mutation).mutationFn("order-1")).rejects.toThrow();expect(mocks.success).not.toHaveBeenCalled();
 });
 it("refreshes the guest folio and finance after confirmed posting",async()=>{
  const data={ok:true,folio_charged:true,folio_id:"folio-1",folio_line_id:"line-1"};mocks.rpc.mockResolvedValue({data,error:null});
  const mutation=usePostLaundryCharge() as unknown as Mutation;mutation.onSuccess(await mutation.mutationFn("order-1"));
  expect(mocks.success).toHaveBeenCalledWith("Charge posted to the guest folio");
  expect(mocks.invalidate).toHaveBeenCalledWith({queryKey:["pms"]});expect(mocks.invalidate).toHaveBeenCalledWith({queryKey:["finance"]});
 });
 it("distinguishes a saved handover with blocked billing from a successful folio posting",async()=>{
  mocks.rpc.mockResolvedValue({data:{ok:true,status:"delivered",posting_status:"blocked"},error:null});
  const mutation=useAdvanceLaundryOrder() as unknown as Mutation;mutation.onSuccess(await mutation.mutationFn({id:"order-1",status:"delivered"}));
  expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining("posting still needs attention"));expect(mocks.success).not.toHaveBeenCalled();
 });
 it("rejects a missing canonical status rather than echoing the requested action",async()=>{
  mocks.rpc.mockResolvedValue({data:{ok:true},error:null});await expect((useAdvanceLaundryOrder() as unknown as Mutation).mutationFn({id:"order-1",status:"delivered"})).rejects.toThrow("saved laundry status");
 });
});
describe("laundry catalogue rate display",()=>{
 const item={normal_price:100,express_price:150};
 it("uses the real normal and express price columns",()=>{expect(laundryCatalogueRate(item,false)).toBe(100);expect(laundryCatalogueRate(item,true)).toBe(150);});
 it("retains the established normal-price fallback when no express rate is set",()=>{expect(laundryCatalogueRate({...item,express_price:0},true)).toBe(100);});
 it.each([undefined,{normal_price:"NaN"},{normal_price:-1}])("does not display an invalid configured amount %j",price=>{expect(laundryCatalogueRate(price,false)).toBe(0);});
});