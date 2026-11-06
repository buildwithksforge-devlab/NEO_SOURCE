// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import type {ReactNode} from 'react';
const m=vi.hoisted(()=>({reset:vi.fn(),success:vi.fn(),error:vi.fn(),email:'guest@example.test'}));
vi.mock('@tanstack/react-router',()=>({createFileRoute:()=> (options:any)=>({options,useParams:()=>({hotelSlug:'demo'})}),Link:({children}:any)=><span>{children}</span>}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{auth:{resetPasswordForEmail:m.reset,signOut:vi.fn()}}}));
vi.mock('sonner',()=>({toast:{success:m.success,error:m.error}}));
vi.mock('@/components/public/PublicAppShell',()=>({useWorkspace:()=>({organization_id:'org-a',branch_id:'branch-a',hotel_name:'Demo'}),BrandButton:({children,...props}:any)=><button {...props}>{children}</button>}));
vi.mock('@/components/public/GuestScreen',()=>({GuestScreen:({children}:{children:ReactNode})=><div>{children}</div>,GuestSection:({children}:{children:ReactNode})=><section>{children}</section>}));
vi.mock('@/lib/public-session',()=>({useCustomerSession:()=>({user:{id:'guest-a',email:m.email},loading:false})}));
vi.mock('@/lib/guest-app',()=>({useGuestProfile:()=>({data:{email:m.email}}),useGuestScreenView:vi.fn(),useUpdateGuestProfile:()=>({mutate:vi.fn()})}));
import {Route} from '@/routes/guest.$hotelSlug.settings';
const Page=(Route as any).options.component;
afterEach(cleanup);beforeEach(()=>{vi.clearAllMocks();m.email='guest@example.test';m.reset.mockResolvedValue({error:null});});
describe('guest settings password reset through existing Supabase Auth',()=>{
 it('sends the recovery link to the actual reset page on this site',async()=>{render(<Page/>);fireEvent.click(screen.getByRole('button',{name:'Send reset link'}));await waitFor(()=>expect(m.success).toHaveBeenCalledOnce());expect(m.reset).toHaveBeenCalledWith(m.email,{redirectTo:`${window.location.origin}/auth/reset-password`});});
 it('never reports success for a resolved Supabase error',async()=>{m.reset.mockResolvedValue({error:{message:'rate limited'}});render(<Page/>);fireEvent.click(screen.getByRole('button',{name:'Send reset link'}));await waitFor(()=>expect(m.error).toHaveBeenCalledOnce());expect(m.success).not.toHaveBeenCalled();});
 it('recovers the control after a rejected network request',async()=>{m.reset.mockRejectedValue(new Error('offline'));render(<Page/>);fireEvent.click(screen.getByRole('button',{name:'Send reset link'}));await waitFor(()=>expect(m.error).toHaveBeenCalledOnce());expect((screen.getByRole('button',{name:'Send reset link'}) as HTMLButtonElement).disabled).toBe(false);expect(m.success).not.toHaveBeenCalled();});
 it('blocks duplicate requests while delivery is pending',async()=>{let finish!:(value:unknown)=>void;m.reset.mockReturnValue(new Promise(resolve=>{finish=resolve}));render(<Page/>);fireEvent.click(screen.getByRole('button',{name:'Send reset link'}));const button=screen.getByRole('button',{name:'Sending…'}) as HTMLButtonElement;expect(button.disabled).toBe(true);fireEvent.click(button);expect(m.reset).toHaveBeenCalledOnce();await act(async()=>finish({error:null}));});
 it('does not call the provider without an account email',async()=>{m.email='';render(<Page/>);fireEvent.click(screen.getByRole('button',{name:'Send reset link'}));expect(m.reset).not.toHaveBeenCalled();expect(m.error).toHaveBeenCalledOnce();});
});
