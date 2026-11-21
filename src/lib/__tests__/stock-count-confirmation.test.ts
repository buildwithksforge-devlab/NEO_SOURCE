import {beforeEach,describe,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({rpc:vi.fn(),from:vi.fn(),eq:vi.fn(),saved:vi.fn(),success:vi.fn(),warning:vi.fn(),invalidate:vi.fn(),org:'org' as string|null}));
vi.mock('@/lib/rpc-guard',()=>({guardedRpc:m.rpc}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:m.from}}));
vi.mock('@/lib/auth',()=>({useAuth:()=>({organizationId:m.org,user:{id:'staff'},profile:{department_id:'department'}})}));
vi.mock('@/lib/branch-filter',()=>({useActivePropertyFilter:()=>({branchId:'property',filterKey:'property'})}));
vi.mock('@/lib/scoped-options',()=>({useScopedDepartmentByKey:vi.fn(),useScopedWorkerOptions:vi.fn()}));
vi.mock('@/lib/stock-needs',()=>({applyStockNeedStatus:vi.fn()}));
vi.mock('@tanstack/react-query',()=>({useMutation:(o:unknown)=>o,useQuery:(o:unknown)=>o,useQueryClient:()=>({invalidateQueries:m.invalidate})}));
vi.mock('sonner',()=>({toast:{success:m.success,warning:m.warning,info:vi.fn(),error:vi.fn()}}));
import {useStoreIssue} from '@/lib/stores-lifecycle';
import {useRecordCountedQuantity,useSubmitCountVariance,useReconcileCountAgainstLedger,useDecideStockAdjustment} from '@/lib/stores-department';
import {useConsumeStockPart,useAssetServiceHistory,useIssuableStockForJob} from '@/lib/maintenance-department';
import {requireSavedRecord,rejectBusinessFailure} from '@/lib/durable-command-result';
type Mutation={mutationFn:(x:unknown)=>Promise<unknown>;onSuccess:(v:unknown)=>void};
type Query={enabled:boolean;queryKey:unknown[];queryFn:()=>Promise<unknown>};
const run=async(mutation:unknown,input:unknown)=>{const c=mutation as Mutation,r=await c.mutationFn(input);c.onSuccess(r);return r};
const issue={locationId:'store',attemptKey:'attempt',reason:'Operational issue',direction:'issue',lines:[{stock_item_id:'item',quantity:2}]};
beforeEach(()=>{vi.clearAllMocks();m.org='org';const chain={update:vi.fn(),eq:m.eq,select:vi.fn(),order:vi.fn(),limit:vi.fn(),maybeSingle:m.saved};for(const method of [m.from,chain.update,m.eq,chain.select,chain.order,chain.limit])method.mockReturnValue(chain);m.saved.mockResolvedValue({data:{id:'line',counted_quantity:0},error:null})});
describe('store issues and returns require saved movements',()=>{
 it.each([null,{}, {ok:false},{ok:true,direction:'issue',location_id:'other',lines:1,movements:['movement']},{ok:true,direction:'return',location_id:'store',lines:1,movements:['movement']},{ok:true,direction:'issue',location_id:'store',lines:0,movements:[]}])('refuses unconfirmed issue %j',async data=>{m.rpc.mockResolvedValue({data,error:null});await expect(run(useStoreIssue(),issue)).rejects.toThrow();expect(m.success).not.toHaveBeenCalled();expect(m.invalidate).not.toHaveBeenCalled()});
 it.each([0,-1,NaN,Infinity])('does not dispatch invalid stock quantity %s',async quantity=>{await expect(run(useStoreIssue(),{...issue,lines:[{stock_item_id:'item',quantity}]})).rejects.toThrow();expect(m.rpc).not.toHaveBeenCalled()});
 it.each(['issue','return'])('preserves confirmed %s with the same attempt and movement',async direction=>{m.rpc.mockResolvedValue({data:{ok:true,direction,location_id:'store',lines:1,movements:['movement']},error:null});await run(useStoreIssue(),{...issue,direction});expect(m.rpc).toHaveBeenCalledWith(expect.anything(),'neo_stores_issue',expect.objectContaining({_attempt:'attempt',_direction:direction,_lines:issue.lines}));expect(m.success).toHaveBeenCalledTimes(1)});
});
describe('physical counts cannot falsely save or reconcile',()=>{
 it.each([null,{id:'other',counted_quantity:0},{id:'line',counted_quantity:null},{id:'line',counted_quantity:1}])('refuses missing or mismatched saved count %j',async data=>{m.saved.mockResolvedValue({data,error:null});await expect(run(useRecordCountedQuantity(),{lineId:'line',counted:0})).rejects.toThrow(/not saved/);expect(m.invalidate).not.toHaveBeenCalled()});
 it('preserves a real zero count and scopes the update by organization',async()=>{await run(useRecordCountedQuantity(),{lineId:'line',counted:0});expect(m.eq).toHaveBeenCalledWith('organization_id','org');expect(m.invalidate).toHaveBeenCalled()});
 it.each([null,{}, {status:'open'}])('does not close or approve an unconfirmed count %j',async data=>{m.rpc.mockResolvedValue({data,error:null});await expect(run(useSubmitCountVariance(),{takeId:'take'})).rejects.toThrow();expect(m.success).not.toHaveBeenCalled()});
 it('preserves the installed already-awaiting-approval replay without inventing a line count',async()=>{m.rpc.mockResolvedValue({data:{status:'awaiting-approval',adjustment:null},error:null});await run(useSubmitCountVariance(),{takeId:'take'});expect(m.success).toHaveBeenCalledWith('Count is awaiting variance approval')});
 it('shows uncounted lines rather than a false clean reconciliation',async()=>{m.rpc.mockResolvedValue({data:{ok:true,take_id:'take',lines:3,match:1,shortage:0,overage:0,not_counted:2},error:null});await run(useReconcileCountAgainstLedger(),'take');expect(m.warning).toHaveBeenCalledWith(expect.stringContaining('2 line(s) remain uncounted'));expect(m.success).not.toHaveBeenCalled()});
 it.each([null,{}, {ok:true,take_id:'other',lines:0,match:0,shortage:0,overage:0,not_counted:0},{ok:true,take_id:'take',lines:3,match:0,shortage:0,overage:0,not_counted:0}])('refuses unconfirmed reconciliation totals %j',async data=>{m.rpc.mockResolvedValue({data,error:null});await expect(run(useReconcileCountAgainstLedger(),'take')).rejects.toThrow();expect(m.success).not.toHaveBeenCalled()});
 it('retains a confirmed fully counted match',async()=>{m.rpc.mockResolvedValue({data:{ok:true,take_id:'take',lines:2,match:2,shortage:0,overage:0,not_counted:0},error:null});await run(useReconcileCountAgainstLedger(),'take');expect(m.success).toHaveBeenCalledWith('Every counted line agrees with the ledger')});
 it.each([null,{}, {ok:true,decision:'reject',adjustment:'adjustment',result:{status:'rejected'}},{ok:true,decision:'approve',adjustment:'adjustment',result:{status:'draft'}}])('refuses unconfirmed stock adjustment %j',async data=>{m.rpc.mockResolvedValue({data,error:null});await expect(run(useDecideStockAdjustment(),{adjustmentId:'adjustment',decision:'approve'})).rejects.toThrow();expect(m.success).not.toHaveBeenCalled()});
 it('preserves a confirmed posted stock correction',async()=>{m.rpc.mockResolvedValue({data:{ok:true,decision:'approve',adjustment:'adjustment',result:{status:'posted'}},error:null});await run(useDecideStockAdjustment(),{adjustmentId:'adjustment',decision:'approve'});expect(m.success).toHaveBeenCalledWith('Correction approved and posted to stock')});
});
describe('maintenance stock links and history scope',()=>{
 it.each([null,{}, {ok:true,part_id:'part'},{ok:false,detail:'Part not issued'}])('requires both saved part and movement %j',async data=>{m.rpc.mockResolvedValue({data,error:null});await expect(run(useConsumeStockPart(),{workOrderId:'work',stockItemId:'item',locationId:'store',quantity:1})).rejects.toThrow();expect(m.success).not.toHaveBeenCalled()});
 it('refuses infinite maintenance usage before RPC',async()=>{await expect(run(useConsumeStockPart(),{workOrderId:'work',stockItemId:'item',locationId:'store',quantity:Infinity})).rejects.toThrow();expect(m.rpc).not.toHaveBeenCalled()});
 it('retains confirmed duplicate part without claiming another issue',async()=>{m.rpc.mockResolvedValue({data:{ok:true,part_id:'part',movement_id:'movement',duplicate:true},error:null});await run(useConsumeStockPart(),{workOrderId:'work',stockItemId:'item',locationId:'store',quantity:1,idempotencyKey:'intent'});expect(m.success).toHaveBeenCalledWith(expect.stringContaining('nothing was issued twice'))});
 it('separates history and stock cache keys by organization',()=>{const a=[useAssetServiceHistory('asset'),useIssuableStockForJob('work')] as unknown as Query[];m.org='other';const b=[useAssetServiceHistory('asset'),useIssuableStockForJob('work')] as unknown as Query[];for(let n=0;n<2;n++)expect(a[n]!.queryKey).not.toEqual(b[n]!.queryKey)});
});
describe('durable reference validation',()=>{
 it.each(['null',' NULL ','undefined',' Undefined '])('rejects sentinel reference %s',id=>expect(()=>requireSavedRecord({id},['id'],'Not saved')).toThrow('Not saved'));
 it('preserves specific business failure detail',()=>expect(()=>rejectBusinessFailure({ok:false,detail:'Actual reason'},'Fallback')).toThrow('Actual reason'));
});
