import {beforeEach,describe,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({from:vi.fn(),select:vi.fn(),eq:vi.fn(),order:vi.fn(),rpc:vi.fn(),queries:[] as Array<{queryKey:unknown[];queryFn:()=>Promise<unknown>}>,scope:'organisation',branch:'property',rows:[{id:'new',name:'P-004',station_type:'production',departments:{catalogue_key:'coffee'}}],visible:['new'],mine:['new']}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:m.from}}));
vi.mock('@/lib/rpc-guard',()=>({guardedRpc:m.rpc}));
vi.mock('@/lib/auth',()=>({useAuth:()=>({organizationId:'org',user:{id:'worker'}})}));
vi.mock('@/lib/branch-filter',()=>({useActivePropertyFilter:()=>({branchId:m.branch})}));
vi.mock('@tanstack/react-query',()=>({useQuery:(o:{queryKey:unknown[];queryFn:()=>Promise<unknown>})=>{m.queries.push(o);const key=o.queryKey[1];return {data:key==='access-scope'?m.scope:key==='scoped-stations'?m.rows:key==='my-station-ids'?m.mine:m.visible,isSuccess:true,isLoading:false,error:null}},useMutation:(o:unknown)=>o,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
import {useScopedStations} from '@/lib/kitchen-tickets';
beforeEach(()=>{vi.clearAllMocks();m.queries=[];m.scope='organisation';m.visible=['new'];m.mine=['new'];m.branch='property';m.rows=[{id:'new',name:'P-004',station_type:'production',departments:{catalogue_key:'coffee'}}];const chain={select:m.select,eq:m.eq,order:m.order,then:(resolve:(v:unknown)=>unknown)=>Promise.resolve({data:m.rows,error:null}).then(resolve)};for(const method of [m.from,m.select,m.eq,m.order])method.mockReturnValue(chain)});
describe('scoped station catalogue integration',()=>{
 it('reads the real department key while narrowing the existing organization/property query',async()=>{useScopedStations();const q=m.queries.find(q=>q.queryKey[1]==='scoped-stations')!;expect(await q.queryFn()).toMatchObject([{id:'new',department_key:'coffee'}]);expect(m.from).toHaveBeenCalledWith('operational_stations');expect(m.select).toHaveBeenCalledWith('id, name, branch_id, code, station_type, departments(catalogue_key)');expect(m.eq).toHaveBeenCalledWith('organization_id','org');expect(m.eq).toHaveBeenCalledWith('branch_id','property');expect(m.eq).toHaveBeenCalledWith('active',true)});
 it('does not display a station refused by the authoritative visible-station RPC',()=>{m.visible=[];expect(useScopedStations().stations).toEqual([])});
 it('does not grant unassigned station access to a station-scoped worker',()=>{m.scope='station';m.mine=[];const result=useScopedStations();expect(result.stations).toEqual([]);expect(result.allowAll).toBe(false)});
 it('retains the assigned and server-visible station',()=>{m.scope='station';expect(useScopedStations().stations.map(s=>s.id)).toEqual(['new'])});
});
