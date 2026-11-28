// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from "vitest";
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {createRootRoute,createRoute,createRouter,createMemoryHistory,createBrowserHistory,Outlet,RouterProvider} from "@tanstack/react-router";
import {BackNavigation} from "@/components/common/BackNavigation";
afterEach(cleanup);
async function setup(entries:string[],browser=false){const root=createRootRoute({component:()=> <><BackNavigation/><Outlet/></>});const routes=['/workspace','/first','/record'].map(path=>createRoute({getParentRoute:()=>root,path,component:()=> <p>{path}</p>}));if(browser)window.history.replaceState(null,"",entries[0]);const history=browser?createBrowserHistory({window}):createMemoryHistory({initialEntries:entries});if(browser){for(const path of entries.slice(1))history.push(path);history.flush();}const router=createRouter({routeTree:root.addChildren(routes),history});await router.load();render(<RouterProvider router={router}/>);return {router,history};}
describe('shared application Back control',()=>{
 it('returns to the actual previous page using router history',async()=>{const {router}=await setup(['/first','/record']);fireEvent.click(screen.getByRole('button',{name:'Go back'}));await waitFor(()=>expect(router.state.location.pathname).toBe('/first'));});
 it('uses workspace fallback for a directly opened record rather than exiting the app',async()=>{const {router}=await setup(['/record']);fireEvent.click(screen.getByRole('button',{name:'Back to workspace'}));await waitFor(()=>expect(router.state.location.pathname).toBe('/workspace'));});
 it('disables Back at an initial workspace entry with no previous page',async()=>{await setup(['/workspace']);expect((screen.getByRole('button',{name:'Back to workspace'}) as HTMLButtonElement).disabled).toBe(true);});
 it('respects an existing history blocker',async()=>{const {router,history}=await setup(['/first','/record'],true);const blocker=vi.fn(()=>true);const unblock=history.block({blockerFn:blocker});try{fireEvent.click(screen.getByRole('button',{name:'Go back'}));await waitFor(()=>expect(blocker).toHaveBeenCalled());expect(router.state.location.pathname).toBe('/record');}finally{unblock();history.destroy();}});
});