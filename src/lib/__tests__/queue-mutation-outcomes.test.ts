import {beforeEach,describe,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({rpc:vi.fn(),invalidate:vi.fn(),toast:vi.fn()}));
vi.mock('@tanstack/react-query',()=>({keepPreviousData:vi.fn(),useQuery:vi.fn(),useMutation:(o:unknown)=>o,useQueryClient:()=>({invalidateQueries:m.invalidate})}));
vi.mock('@/lib/rpc-guard',()=>({guardedRpc:m.rpc}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{}}));
vi.mock('@/lib/auth',()=>({useAuth:()=>({organizationId:'org',profile:{full_name:'Operator'},user:{id:'staff'}})}));
vi.mock('@/lib/branch-filter',()=>({useActivePropertyFilter:()=>({branchId:'property',orgWide:false})}));
vi.mock('@/lib/audit',()=>({logAudit:vi.fn()}));
vi.mock('@/lib/preview-mode',()=>({guardPreview:vi.fn()}));
vi.mock('sonner',()=>({toast:{success:m.toast,error:m.toast,info:m.toast,warning:m.toast}}));
import {useConvertEnquiry,useConvertQuotation,useConfirmBooking,useEnsureBeo,usePublishBeo,useCreateBooking} from '@/lib/events-data';
import {useCreateGuestBooking} from '@/lib/guest-booking';
type Mutation={mutationFn:(v:never)=>Promise<unknown>};
const run=(hook:unknown,input:unknown)=>(hook as Mutation).mutationFn(input as never);
beforeEach(()=>vi.clearAllMocks());
describe('queue event mutation outcomes require existing server evidence',()=>{
 const paths=[
  {name:'event creation',hook:useCreateBooking,input:{event_name:'Dinner'},result:{booking_id:'saved'}},
  {name:'enquiry conversion',hook:useConvertEnquiry,input:{enquiryId:'source'},result:{booking_id:'saved',created:true}},
  {name:'quotation conversion',hook:useConvertQuotation,input:{quotationId:'source'},result:{booking_id:'saved',created:false}},
  {name:'confirmation',hook:useConfirmBooking,input:{bookingId:'saved'},result:{booking_id:'saved',already_confirmed:true}},
  {name:'BEO creation',hook:useEnsureBeo,input:'booking',result:'saved'},
  {name:'department handoff',hook:usePublishBeo,input:'saved',result:{beo_id:'saved',billing_warning:'Review billing'}},
 ];
 for(const path of paths){
  it(`${path.name} rejects an empty server reply`,async()=>{m.rpc.mockResolvedValue({data:null,error:null});await expect(run(path.hook(),path.input)).rejects.toThrow(/confirm/);expect(m.toast).not.toHaveBeenCalled();expect(m.invalidate).not.toHaveBeenCalled()});
  it(`${path.name} retains the existing valid/replay outcome`,async()=>{m.rpc.mockResolvedValue({data:path.result,error:null});await expect(run(path.hook(),path.input)).resolves.toEqual(path.result)});
 }
 it('confirmation refuses a different booking identity',async()=>{m.rpc.mockResolvedValue({data:{booking_id:'other'},error:null});await expect(run(useConfirmBooking(),{bookingId:'saved'})).rejects.toThrow(/expected/)});
 it('BEO handoff refuses explicit unsuccessful result',async()=>{m.rpc.mockResolvedValue({data:{ok:false,beo_id:'saved',detail:'Department is not configured'},error:null});await expect(run(usePublishBeo(),'saved')).rejects.toThrow(/Department/)});
 it('a guest booking refuses false success before trip invalidation',async()=>{m.rpc.mockResolvedValue({data:{ok:false,id:'record',reason:'no_availability'},error:null});await expect(run(useCreateGuestBooking('org'),{branchId:'b',roomTypeId:'room',arrival:'2026-11-10',departure:'2026-11-11',adults:1,children:0,intentKey:'intent'})).rejects.toThrow(/no_availability/);expect(m.invalidate).not.toHaveBeenCalled()});
});
