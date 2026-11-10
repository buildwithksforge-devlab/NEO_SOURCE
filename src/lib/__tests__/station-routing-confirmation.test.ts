import {beforeEach,describe,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({org:'org-a' as string|null,rpc:vi.fn(),from:vi.fn(),eq:vi.fn(),select:vi.fn(),order:vi.fn(),or:vi.fn(),invalidate:vi.fn(),success:vi.fn()}));
vi.mock('@tanstack/react-query',()=>({useQuery:(o:unknown)=>o,useMutation:(o:unknown)=>o,useQueryClient:()=>({invalidateQueries:m.invalidate})}));
vi.mock('@/lib/auth',()=>({useAuth:()=>({organizationId:m.org})}));
vi.mock('@/lib/branch-filter',()=>({useActivePropertyFilter:()=>({branchId:'property',filterKey:'property'})}));
vi.mock('@/lib/rpc-guard',()=>({guardedRpc:m.rpc}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:m.from}}));
vi.mock('sonner',()=>({toast:{success:m.success,error:vi.fn()}}));
import {useSetStationStore,useClearStationStore,useStationImpact,usePropertyStores,useStationStoreRules} from '@/lib/station-store-routing';
type Mutation={mutationFn:(x:{stationId:string;locationId:string})=>Promise<unknown>;onSuccess:(x:unknown)=>void};
type Query={enabled:boolean;queryKey:unknown[];queryFn:()=>Promise<unknown>};
const run=async(clear=false)=>{const mutation=(clear?useClearStationStore():useSetStationStore()) as unknown as Mutation;const result=await mutation.mutationFn({stationId:'station',locationId:'store'});mutation.onSuccess(result);return result};
beforeEach(()=>{vi.clearAllMocks();m.org='org-a';const chain={select:m.select,eq:m.eq,order:m.order,or:m.or,then:(resolve:(v:unknown)=>unknown)=>Promise.resolve({data:[],error:null}).then(resolve)};for(const method of [m.from,m.select,m.eq,m.order,m.or])method.mockReturnValue(chain)});
describe('confirmed station store changes',()=>{
 it.each([null,{}, {ok:false,detail:'Mapping blocked'},{ok:true,station_id:'other',location_id:'store'},{ok:true,station_id:'station',location_id:'other'}])('does not toast success for unconfirmed set %j',async data=>{m.rpc.mockResolvedValue({data,error:null});await expect(run()).rejects.toThrow();expect(m.success).not.toHaveBeenCalled();expect(m.invalidate).not.toHaveBeenCalled()});
 it('accepts a confirmed matching station/store and refreshes existing caches',async()=>{m.rpc.mockResolvedValue({data:{ok:true,station_id:'station',location_id:'store',location_name:'Cold Store'},error:null});await run();expect(m.success).toHaveBeenCalledTimes(1);expect(m.invalidate).toHaveBeenCalledWith({queryKey:['kitchen']});expect(m.rpc).toHaveBeenCalledWith(expect.anything(),'neo_station_store_set',{_station:'station',_location:'store',_reason:null})});
 it.each([null,{}, {ok:false},{ok:true,station_id:'other'}])('does not toast success for unconfirmed removal %j',async data=>{m.rpc.mockResolvedValue({data,error:null});await expect(run(true)).rejects.toThrow();expect(m.success).not.toHaveBeenCalled()});
 it('accepts confirmed removal without inventing a fallback store',async()=>{m.rpc.mockResolvedValue({data:{ok:true,station_id:'station',fallback_location_id:null},error:null});await run(true);expect(m.success).toHaveBeenCalledWith('Mapping removed.')});
 it('preserves server transport errors',async()=>{m.rpc.mockResolvedValue({data:null,error:{message:'Permission denied'}});await expect(run()).rejects.toThrow('Permission denied');expect(m.success).not.toHaveBeenCalled()});
});
describe('station routing read boundaries',()=>{
 it('separates station impact cache by organization',()=>{const a=useStationImpact('station') as unknown as Query;m.org='org-b';const b=useStationImpact('station') as unknown as Query;expect(a.queryKey).not.toEqual(b.queryKey)});
 it.each([null,{}, {allowed:'true'}])('rejects unconfirmed impact %j',async data=>{m.rpc.mockResolvedValue({data,error:null});await expect((useStationImpact('station') as unknown as Query).queryFn()).rejects.toThrow(/confirm station impact/)});
 it('preserves an explicit denied impact',async()=>{m.rpc.mockResolvedValue({data:{allowed:false,reason:'Active production'},error:null});await expect((useStationImpact('station') as unknown as Query).queryFn()).resolves.toMatchObject({allowed:false,reason:'Active production'})});
 it('filters store reads by organization as well as property',async()=>{await (usePropertyStores() as unknown as Query).queryFn();expect(m.eq).toHaveBeenCalledWith('organization_id','org-a');expect(m.or).toHaveBeenCalledWith('branch_id.eq.property,branch_id.is.null')});
 it('filters routing-rule reads by organization',async()=>{await (useStationStoreRules() as unknown as Query).queryFn();expect(m.eq).toHaveBeenCalledWith('organization_id','org-a')});
 it('refuses manually refetched reads without organization context',async()=>{m.org=null;for(const query of [usePropertyStores(),useStationStoreRules(),useStationImpact('station')]){expect((query as unknown as Query).enabled).toBe(false);await expect((query as unknown as Query).queryFn()).rejects.toThrow(/workspace/)}expect(m.rpc).not.toHaveBeenCalled();expect(m.from).not.toHaveBeenCalled()});
});
