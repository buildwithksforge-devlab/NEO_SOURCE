import {beforeEach,describe,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({rpc:vi.fn(),invalidate:vi.fn()}));
vi.mock('@tanstack/react-query',()=>({useQuery:vi.fn(),useMutation:(options:unknown)=>options,useQueryClient:()=>({invalidateQueries:m.invalidate})}));
vi.mock('@/lib/rpc-guard',()=>({guardedRpc:m.rpc}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{}}));
import {useAddPastryPlanItem} from '@/lib/pastry-department';
type Mutation={mutationFn:(input:{planId:string;product:string;quantity:number;dueAt?:string})=>Promise<unknown>};
const mutation=()=>useAddPastryPlanItem() as unknown as Mutation;
beforeEach(()=>vi.clearAllMocks());
describe('production plan input boundary',()=>{
 it.each([0,-1,NaN,Infinity,-Infinity])('refuses invalid production quantity %s before the RPC',async quantity=>{await expect(mutation().mutationFn({planId:'plan',product:'Bread',quantity})).rejects.toThrow(/quantity/);expect(m.rpc).not.toHaveBeenCalled()});
 it('refuses a blank product before the RPC',async()=>{await expect(mutation().mutationFn({planId:'plan',product:' ',quantity:1})).rejects.toThrow(/product/);expect(m.rpc).not.toHaveBeenCalled()});
 it('retains valid quantities and property-resolved deadlines',async()=>{m.rpc.mockResolvedValue({data:{id:'item'},error:null});await mutation().mutationFn({planId:'plan',product:' Bread ',quantity:12,dueAt:'2026-11-08T15:30:00.000Z'});expect(m.rpc).toHaveBeenCalledWith({},'neo_pastry_plan_item_add',expect.objectContaining({_quantity:12,_product:'Bread',_due:'2026-11-08T15:30:00.000Z'}))});
});
