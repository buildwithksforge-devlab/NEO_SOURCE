// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
const m=vi.hoisted(()=>({request:vi.fn(),update:vi.fn(),getUser:vi.fn(),profile:vi.fn(),success:vi.fn(),error:vi.fn(),warning:vi.fn(),navigate:vi.fn()}));
vi.mock('@tanstack/react-router',()=>({createFileRoute:()=> (options:any)=>({options}),useNavigate:()=>m.navigate,Link:({children}:any)=><span>{children}</span>}));
vi.mock('@/components/auth/AuthLayout',()=>({AuthLayout:({children}:any)=><div>{children}</div>}));
vi.mock('sonner',()=>({toast:{success:m.success,error:m.error,warning:m.warning}}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{auth:{resetPasswordForEmail:m.request,updateUser:m.update,getUser:m.getUser},from:()=>({update:()=>({eq:m.profile})})}}));
const forgot=await import('@/routes/auth.forgot-password');const reset=await import('@/routes/auth.reset-password');
const Forgot=(forgot.Route as any).options.component;const Reset=(reset.Route as any).options.component;
beforeEach(()=>{vi.clearAllMocks();m.request.mockResolvedValue({error:null});m.update.mockResolvedValue({error:null});m.getUser.mockResolvedValue({data:{user:{id:'self'}}});m.profile.mockResolvedValue({error:null});});afterEach(cleanup);
describe('staff password recovery forms',()=>{
 it('recovers the forgot-password button after network failure',async()=>{
 m.request.mockRejectedValue(new Error('offline'));render(<Forgot/>);fireEvent.change(screen.getByLabelText(/email/i),{target:{value:'staff@example.test'}});fireEvent.submit(screen.getByRole('button',{name:/send/i}).closest('form')!);await waitFor(()=>expect(m.error).toHaveBeenCalled());expect((screen.getByRole('button',{name:/send/i}) as HTMLButtonElement).disabled).toBe(false);expect(m.success).not.toHaveBeenCalled();
 });
 it('uses the current reset route when requesting recovery',async()=>{
 render(<Forgot/>);fireEvent.change(screen.getByLabelText(/email/i),{target:{value:'staff@example.test'}});fireEvent.submit(screen.getByRole('button',{name:/send/i}).closest('form')!);await waitFor(()=>expect(m.success).toHaveBeenCalled());expect(m.request).toHaveBeenCalledWith('staff@example.test',{redirectTo:window.location.origin+'/auth/reset-password'});
 });
 it('reports password changed but profile flag failed without claiming full success',async()=>{
 m.profile.mockResolvedValue({error:{message:'denied'}});render(<Reset/>);fireEvent.change(screen.getByLabelText('New password'),{target:{value:'Example-password-42'}});fireEvent.change(screen.getByLabelText('Confirm password'),{target:{value:'Example-password-42'}});fireEvent.submit(screen.getByRole('button',{name:'Update password'}).closest('form')!);await waitFor(()=>expect(m.warning).toHaveBeenCalled());expect(m.navigate).not.toHaveBeenCalled();expect(m.success).not.toHaveBeenCalled();
 });
 it('restores reset control after a lost update response',async()=>{
 m.update.mockRejectedValue(new Error('offline'));render(<Reset/>);fireEvent.change(screen.getByLabelText('New password'),{target:{value:'Example-password-42'}});fireEvent.change(screen.getByLabelText('Confirm password'),{target:{value:'Example-password-42'}});fireEvent.submit(screen.getByRole('button',{name:'Update password'}).closest('form')!);await waitFor(()=>expect(m.error).toHaveBeenCalled());expect((screen.getByRole('button',{name:'Update password'}) as HTMLButtonElement).disabled).toBe(false);
 });
});
