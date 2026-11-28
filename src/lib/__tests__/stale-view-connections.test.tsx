// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,renderHook} from '@testing-library/react';
import {QueryClient,QueryClientProvider,QueryObserver,focusManager} from '@tanstack/react-query';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({rpc:vi.fn(),success:vi.fn(),warning:vi.fn(),error:vi.fn(),auth:{organizationId:'org',user:{id:'worker'},phase:'ready',permissions:new Set(['finance.view']),permissionsLoaded:true,accessLoaded:true,access:{accessScope:'branch',branchIds:['branch'],departmentIds:[],stationIds:[],roleIds:[]}}}));
vi.mock('@/lib/auth',()=>({useAuth:()=>m.auth}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:m.rpc}}));
vi.mock('@/lib/rpc-guard',()=>({guardedRpc:(_client:unknown,name:string,args:unknown)=>m.rpc(name,args)}));
vi.mock('sonner',()=>({toast:{success:m.success,warning:m.warning,error:m.error,info:vi.fn()}}));
import {readViewAccess,VISIBLE_VIEW_REFRESH} from '../view-freshness';
import {invalidatePaymentViews,PAYMENT_VIEW_KEYS} from '../payment-view-refresh';
import {parseOutboxReplayBatch} from '../outbox-replay-result';
import {useOutboxReplayBatch} from '../finance-posting';
import {usePaymentRegister} from '../payment-register';
const clients:QueryClient[]=[];
const client=()=>{const q=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity},mutations:{retry:false}}});clients.push(q);return q;};
afterEach(()=>{cleanup();clients.forEach(c=>c.clear());clients.length=0;focusManager.setFocused(undefined);vi.useRealTimers();});
beforeEach(()=>{vi.clearAllMocks();m.auth.user.id='worker';m.auth.phase='ready';m.auth.permissionsLoaded=true;m.auth.accessLoaded=true;});
describe('view access identity',()=>{
 it('requires a resolved signed-in authority',()=>expect(readViewAccess(m.auth).ready).toBe(true));
 it.each(['permissionsLoaded','accessLoaded'] as const)('waits for %s',key=>expect(readViewAccess({...m.auth,[key]:false}).ready).toBe(false));
 it.each(['loading','anonymous','recoverable'])('does not read with phase %s',phase=>expect(readViewAccess({...m.auth,phase}).ready).toBe(false));
 it('waits for organization and worker',()=>{expect(readViewAccess({...m.auth,organizationId:null}).ready).toBe(false);expect(readViewAccess({...m.auth,user:null}).ready).toBe(false);});
 it('changes cache identity when worker changes',()=>expect(readViewAccess({...m.auth,user:{id:'other'}}).identity).not.toBe(readViewAccess(m.auth).identity));
 it('changes cache identity when grants change',()=>expect(readViewAccess({...m.auth,permissions:new Set(['finance.approve'])}).identity).not.toBe(readViewAccess(m.auth).identity));
 it('changes cache identity when property authority changes',()=>expect(readViewAccess({...m.auth,access:{...m.auth.access,branchIds:['other']}}).identity).not.toBe(readViewAccess(m.auth).identity));
 it('ignores ordering differences in the same grants and scope',()=>expect(readViewAccess({...m.auth,permissions:new Set(['b','a']),access:{...m.auth.access,branchIds:['b','a']}}).identity).toBe(readViewAccess({...m.auth,permissions:new Set(['a','b']),access:{...m.auth.access,branchIds:['a','b']}}).identity));
});
describe('financial refresh connections',()=>{
 it('refreshes active related views and leaves unrelated data alone',async()=>{
  const q=client();let server=1;const observed=['payment-register','financial-lifecycle','financial-states','finance-posting','crm-credit-line','unrelated'];
  const calls=new Map<string,number>();const off=observed.map(root=>new QueryObserver(q,{queryKey:[root,'org'],queryFn:async()=>{calls.set(root,(calls.get(root)??0)+1);return server;}}).subscribe(()=>{}));
  await vi.waitFor(()=>expect(q.getQueryData(['financial-lifecycle','org'])).toBe(1));
  server=2;await invalidatePaymentViews(q);
  for(const root of observed.filter(x=>x!=='unrelated'))expect(q.getQueryData([root,'org'])).toBe(2);
  expect(q.getQueryData(['unrelated','org'])).toBe(1);expect(calls.get('unrelated')).toBe(1);off.forEach(f=>f());
 });
 it('marks inactive financial views stale without fetching them',async()=>{const q=client();q.setQueryData(['financial-states','org'],[{old:true}]);await invalidatePaymentViews(q);expect(q.getQueryState(['financial-states','org'])?.isInvalidated).toBe(true);expect(q.getQueryState(['financial-states','org'])?.fetchStatus).toBe('idle');});
 it('keeps every financial family connected once',()=>expect(new Set(PAYMENT_VIEW_KEYS).size).toBe(PAYMENT_VIEW_KEYS.length));
 it('does not complete refresh before an active view has returned its new answer',async()=>{const q=client();let resolve:((v:number)=>void)|undefined;let next=false;const observer=new QueryObserver(q,{queryKey:['payment-register','org'],queryFn:()=>next?new Promise<number>(r=>{resolve=r;}):Promise.resolve(1)});const off=observer.subscribe(()=>{});await vi.waitFor(()=>expect(observer.getCurrentResult().data).toBe(1));next=true;let completed=false;const refresh=invalidatePaymentViews(q).then(()=>{completed=true;});await vi.waitFor(()=>expect(resolve).toBeTypeOf('function'));expect(completed).toBe(false);resolve!(2);await refresh;expect(observer.getCurrentResult().data).toBe(2);off();});
});
describe('visible remote updates',()=>{
 it('reads changes from another worker without a local mutation and pauses when unfocused',async()=>{vi.useFakeTimers();focusManager.setFocused(true);const q=client();let server=1;const observer=new QueryObserver(q,{queryKey:['remote-finance'],...VISIBLE_VIEW_REFRESH,queryFn:async()=>server});const off=observer.subscribe(()=>{});await vi.advanceTimersByTimeAsync(1);expect(observer.getCurrentResult().data).toBe(1);server=2;await vi.advanceTimersByTimeAsync(15_000);expect(observer.getCurrentResult().data).toBe(2);focusManager.setFocused(false);server=3;await vi.advanceTimersByTimeAsync(30_000);expect(observer.getCurrentResult().data).toBe(2);off();});
 it('uses the remote refresh policy in the real payment register hook',()=>{m.rpc.mockResolvedValue({data:[],error:null});const q=client();const {result}=renderHook(()=>usePaymentRegister({}),{wrapper:({children})=><QueryClientProvider client={q}>{children}</QueryClientProvider>});expect(result.current.isPending).toBe(true);const cache=q.getQueryCache().getAll()[0]!;expect((cache.options as unknown as {refetchInterval:number}).refetchInterval).toBe(15_000);expect((cache.options as unknown as {refetchIntervalInBackground:boolean}).refetchIntervalInBackground).toBe(false);});
});
describe('outbox replay results and refreshed screens',()=>{
 it.each([null,{}, {ok:false}, {ok:true,requeued:null,already_processed:0,failed:0},{ok:true,requeued:-1,already_processed:0,failed:0},{ok:true,requeued:0.5,already_processed:0,failed:0},{ok:true,requeued:0,already_processed:'1',failed:0}])('rejects unverified replay result %j',value=>expect(()=>parseOutboxReplayBatch(value)).toThrow());
 it('retains real zero and partial-failure counts',()=>expect(parseOutboxReplayBatch({ok:true,requeued:0,already_processed:2,failed:1})).toEqual({requeued:0,alreadyProcessed:2,failed:1}));
 it('replay refreshes outbox and financial views and warns on partial failure',async()=>{m.rpc.mockResolvedValue({data:{ok:true,requeued:1,already_processed:0,failed:1},error:null});const q=client();for(const root of ['neo-outbox-health','neo-outbox-failures','financial-states','financial-lifecycle','finance-posting'])q.setQueryData([root,'org'],[]);const {result}=renderHook(()=>useOutboxReplayBatch(),{wrapper:({children})=><QueryClientProvider client={q}>{children}</QueryClientProvider>});await act(async()=>{await result.current.mutateAsync({branchId:'branch'});});for(const root of ['neo-outbox-health','neo-outbox-failures','financial-states','financial-lifecycle','finance-posting'])expect(q.getQueryState([root,'org'])?.isInvalidated).toBe(true);expect(m.warning).toHaveBeenCalledWith('Requeued 1 · already processed 0 · failed 1');expect(m.success).not.toHaveBeenCalled();});
 it('a refused replay never announces zero as success',async()=>{m.rpc.mockResolvedValue({data:{ok:false,detail:'Not permitted'},error:null});const q=client();const {result}=renderHook(()=>useOutboxReplayBatch(),{wrapper:({children})=><QueryClientProvider client={q}>{children}</QueryClientProvider>});await act(async()=>{await expect(result.current.mutateAsync({branchId:'branch'})).rejects.toThrow('Not permitted');});expect(m.success).not.toHaveBeenCalled();});
});
