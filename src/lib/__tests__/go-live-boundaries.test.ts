import {beforeEach,describe,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({rpc:vi.fn(),auth:{organizationId:'org',user:{id:'worker'},phase:'ready',permissions:new Set(['admin.view']),permissionsLoaded:true,accessLoaded:true,access:{accessScope:'self',branchIds:['property'],departmentIds:[],stationIds:[],roleIds:[]}},branch:{branchId:'property' as string|null,filterKey:'property'}}));
vi.mock('@/lib/auth',()=>({useAuth:()=>m.auth}));
vi.mock('@/lib/branch-filter',()=>({useActivePropertyFilter:()=>m.branch}));
vi.mock('@/lib/rpc-guard',()=>({guardedRpc:m.rpc}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{}}));
vi.mock('@tanstack/react-query',()=>({useQuery:(options:unknown)=>options}));
import {useGoLiveReadiness,useMenuValidationStates} from '@/lib/go-live';
import {parseGoLiveReadiness,parseMenuValidationRows,ReadinessContractError} from '@/lib/go-live-contract';
type Q={queryKey:unknown[];enabled:boolean;queryFn:()=>Promise<unknown>;retry:(n:number,e:Error)=>boolean};
const hooks=[useGoLiveReadiness,useMenuValidationStates];
const check={key:'pos',domain:'POS',label:'Configured',detail:'Confirmed',status:'ready',count:1,route:'/pos'};
const payload={branch_id:'property',generated_at:'2026-11-09T01:00:00Z',status:'ready',checks:[check]};
const menu={item_id:'item',branch_id:'property',name:'Tea',state:'ready',issues:[]};
beforeEach(()=>{vi.clearAllMocks();m.auth.organizationId='org';m.auth.user={id:'worker'};m.auth.phase='ready';m.auth.permissions=new Set(['admin.view']);m.auth.permissionsLoaded=true;m.auth.accessLoaded=true;m.auth.access.branchIds=['property'];m.branch={branchId:'property',filterKey:'property'};});
describe.each(hooks)('readiness identity boundary %s',hook=>{
 const query=()=>hook() as unknown as Q;
 it.each(['signed-out','authenticating','resolving-account','resolving-access','suspended','denied','reauth-required','error'])('waits during %s',phase=>{m.auth.phase=phase;expect(query().enabled).toBe(false)});
 it('waits for effective permissions and scope',()=>{m.auth.permissionsLoaded=false;expect(query().enabled).toBe(false);m.auth.permissionsLoaded=true;m.auth.accessLoaded=false;expect(query().enabled).toBe(false)});
 it('requires an organisation and worker',()=>{m.auth.organizationId='';expect(query().enabled).toBe(false);m.auth.organizationId='org';m.auth.user.id='';expect(query().enabled).toBe(false)});
 it('does not share cache across workers, tenants, properties or changed authority',()=>{const original=query().queryKey;m.auth.user={id:'other'};expect(query().queryKey).not.toEqual(original);m.auth.user={id:'worker'};m.auth.organizationId='other-org';expect(query().queryKey).not.toEqual(original);m.auth.organizationId='org';m.auth.permissions.add('finance.view');expect(query().queryKey).not.toEqual(original);m.auth.permissions=new Set(['admin.view']);m.branch.filterKey='other';expect(query().queryKey).not.toEqual(original)});
 it('keeps schema/permission error codes and does not retry permanent failures',async()=>{m.rpc.mockResolvedValue({data:null,error:{message:'missing routine',code:'PGRST202'}});let failure:Error;try{await query().queryFn();throw Error('unexpected success')}catch(e){failure=e as Error}expect(failure).toMatchObject({code:'PGRST202'});expect(query().retry(0,failure)).toBe(false);expect(query().retry(0,Object.assign(new Error('denied'),{code:'42501'}))).toBe(false);expect(query().retry(0,new ReadinessContractError())).toBe(false);expect(query().retry(0,new Error('transport'))).toBe(true);expect(query().retry(2,new Error('transport'))).toBe(false)});
});
describe('readiness evidence contract',()=>{
 it('retains real confirmed checks',()=>expect(parseGoLiveReadiness(payload,'property')).toEqual(payload));
 it.each([null,[],{}, {...payload,branch_id:'other'},{...payload,generated_at:'invalid'},{...payload,status:'complete'},{...payload,checks:[]},{...payload,checks:[check,check]}])('rejects incomplete, stale-scope or duplicate evidence %j',v=>expect(()=>parseGoLiveReadiness(v,'property')).toThrow(ReadinessContractError));
 it.each([{count:NaN},{count:Infinity},{count:-1},{count:1.5},{count:'1'},{key:''},{route:'https://example.invalid'},{route:'//example.invalid'},{route:'/\\example.invalid'},{status:'done'},{extra:[]},{label:''}])('rejects malformed checks %j',patch=>expect(()=>parseGoLiveReadiness({...payload,checks:[{...check,...patch}]},'property')).toThrow(ReadinessContractError));
 it.each(['attention','blocked','unknown'])('cannot report ready with a %s check',status=>expect(()=>parseGoLiveReadiness({...payload,checks:[{...check,status}]},'property')).toThrow());
 it('cannot hide a blocked check behind an attention verdict',()=>expect(()=>parseGoLiveReadiness({...payload,status:'attention',checks:[{...check,status:'blocked'}]},'property')).toThrow());
 it('retains an explicitly unknown empty response without asserting readiness',()=>expect(parseGoLiveReadiness({...payload,status:'unknown',checks:[]},'property').status).toBe('unknown'));
 it('requires the requested property to be sent to the RPC',async()=>{m.rpc.mockResolvedValue({data:payload,error:null});await (useGoLiveReadiness() as unknown as Q).queryFn();expect(m.rpc).toHaveBeenCalledWith(expect.anything(),'neo_go_live_readiness',{_branch:'property'})});
});
describe('menu readiness contract',()=>{
 it('retains shared rows and selected-property rows',()=>expect(parseMenuValidationRows([menu,{...menu,item_id:'shared',branch_id:null}],'property')).toHaveLength(2));
 it('accepts a genuinely empty successful query',()=>expect(parseMenuValidationRows([],'property')).toEqual([]));
 it.each([null,{},[{...menu,branch_id:'other'}],[menu,menu],[{...menu,issues:null}],[{...menu,issues:['missing-recipe']}],[{...menu,state:'complete'}],[{...menu,name:''}]])('does not convert invalid data to an empty/ready menu %j',v=>expect(()=>parseMenuValidationRows(v,'property')).toThrow());
 it('requires global scope explicitly for multiple properties',()=>expect(parseMenuValidationRows([{...menu,branch_id:'other'}],null)).toHaveLength(1));
});
