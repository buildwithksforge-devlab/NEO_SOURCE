import {beforeEach,describe,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({org:'org-a' as string|null,from:vi.fn(),eq:vi.fn(),rpc:vi.fn(),direct:vi.fn(),invalidate:vi.fn()}));
vi.mock('@tanstack/react-query',()=>({useQuery:(options:unknown)=>options,useMutation:(options:unknown)=>options,useQueryClient:()=>({invalidateQueries:m.invalidate})}));
vi.mock('@/lib/auth',()=>({useAuth:()=>({organizationId:m.org})}));
vi.mock('@/lib/branch-filter',()=>({useActivePropertyFilter:()=>({applyTo:(value:unknown)=>value,filterKey:'property'}),useWriteBranchId:()=>null}));
vi.mock('@/lib/rpc-guard',()=>({guardedRpc:m.rpc}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:m.from,rpc:m.direct}}));
vi.mock('@/lib/audit',()=>({logAudit:vi.fn()}));
import {useReservationFolios,useReservationHistory,useAvailability} from '@/lib/pms-data';
import {useRecordDeposit} from '@/lib/deposits';
type Options={queryKey:unknown[];enabled:boolean;queryFn:()=>Promise<unknown>};
type Chain={select:()=>Chain;eq:(...args:unknown[])=>Chain;order:()=>Chain;then:(resolve:(value:unknown)=>unknown)=>unknown};
beforeEach(()=>{vi.clearAllMocks();m.org='org-a';let chain:Chain;chain={select:()=>chain,eq:(...args)=>{m.eq(...args);return chain},order:()=>chain,then:resolve=>resolve({data:[],error:null})};m.from.mockReturnValue(chain)});
describe('reservation reads keep their workspace scope',()=>{
 for(const [name,hook] of [['folios',useReservationFolios],['history',useReservationHistory]] as const){
  it(`${name} uses the current organization in both cache and query`,async()=>{const query=hook('reservation') as unknown as Options;expect(query.queryKey).toContain('org-a');await query.queryFn();expect(m.eq).toHaveBeenCalledWith('organization_id','org-a');expect(m.eq).toHaveBeenCalledWith('reservation_id','reservation');m.org='org-b';expect((hook('reservation') as unknown as Options).queryKey).not.toEqual(query.queryKey)});
  it(`${name} cannot refetch without an organization`,async()=>{m.org=null;const query=hook('reservation') as unknown as Options;expect(query.enabled).toBe(false);await expect(query.queryFn()).rejects.toThrow(/scope/);expect(m.from).not.toHaveBeenCalled()});
 }
 const params={branch:'property',arrival:'2026-11-08',departure:'2026-11-09',roomType:null,adults:2,children:0};
 it('availability caches do not survive a workspace change as the same key',()=>{const first=useAvailability(params) as unknown as Options;m.org='org-b';expect((useAvailability(params) as unknown as Options).queryKey).not.toEqual(first.queryKey)});
 it.each([{arrival:'2026-02-30'},{departure:'2026-11-08'},{adults:0},{adults:1.5},{children:-1}])('cannot refetch invalid availability even through manual refetch %j',async invalid=>{const query=useAvailability({...params,...invalid}) as unknown as Options;expect(query.enabled).toBe(false);await expect(query.queryFn()).rejects.toThrow(/valid stay dates/);expect(m.rpc).not.toHaveBeenCalled()});
 it('retains the canonical RPC for a valid search',async()=>{m.rpc.mockResolvedValue({data:[],error:null});const query=useAvailability(params) as unknown as Options;expect(query.enabled).toBe(true);await query.queryFn();expect(m.rpc).toHaveBeenCalledWith(expect.anything(),'pms_available_rooms',expect.objectContaining({_arrival:params.arrival,_departure:params.departure,_adults:2}))});
});
describe('deposit recording boundaries',()=>{
 type Mutation={mutationFn:(input:{reservationId:string;amount:number;method:string;idempotencyKey:string})=>Promise<unknown>};
 const run=(amount:number,key='intent')=>(useRecordDeposit() as unknown as Mutation).mutationFn({reservationId:'r',amount,method:'cash',idempotencyKey:key});
 it.each([0,-1,NaN,Infinity])('rejects invalid deposit amount %s before the RPC',async amount=>{await expect(run(amount)).rejects.toThrow(/amount/);expect(m.direct).not.toHaveBeenCalled()});
 it('requires an idempotency intent before recording',async()=>{await expect(run(100,' ')).rejects.toThrow(/idempotency/);expect(m.direct).not.toHaveBeenCalled()});
 it.each([null,{}, {deposit_id:'null'},{deposit_id:' undefined '},{deposit_id:4}])('does not accept an unconfirmed deposit ID %j',async data=>{m.direct.mockResolvedValue({data,error:null});await expect(run(100)).rejects.toThrow(/persisted/)});
 it('retains persisted deposit evidence and visible Finance-pending state',async()=>{m.direct.mockResolvedValue({data:{deposit_id:'deposit',idempotent:true,finance:{ok:false,reason:'pending'}},error:null});await expect(run(100)).resolves.toMatchObject({deposit_id:'deposit',idempotent:true,finance:{ok:false}})});
});
