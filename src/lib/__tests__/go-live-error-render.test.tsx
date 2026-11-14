import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,describe,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({readiness:{} as any,menu:{} as any}));
vi.mock('@tanstack/react-router',()=>({createFileRoute:()=>((options:any)=>({options})),Link:({children}:any)=>children}));
vi.mock('@/lib/go-live',async()=>{const original=await vi.importActual<any>('@/lib/go-live');return {...original,useGoLiveReadiness:()=>m.readiness,useMenuValidationStates:()=>m.menu}});
vi.mock('@/lib/finance-controls',()=>({useSeedApprovalAuthority:()=>({isPending:false,mutate:vi.fn()})}));
vi.mock('@/components/ui/tabs',()=>({Tabs:({children}:any)=>children,TabsList:({children}:any)=>children,TabsTrigger:({children}:any)=>children,TabsContent:({children}:any)=>children}));
vi.mock('@/components/common/DataDisplay',()=>({PageHeader:({title}:any)=><h1>{title}</h1>,SectionCard:({children}:any)=><section>{children}</section>,StatCard:({label,value}:any)=><div>{label}: {value}</div>}));
import {Route} from '@/routes/admin.go-live';
const Component=(Route as any).options.component;
beforeEach(()=>{m.readiness={data:{status:'ready',generated_at:'2026-11-09T01:00:00Z',checks:[{key:'pos',label:'Configured',domain:'POS',status:'ready',detail:'ok',count:1,route:'/pos'}]},isError:false,isPending:false,isFetching:false,refetch:vi.fn()};m.menu={data:[{item_id:'tea',name:'Tea',state:'ready',issues:[]}],isError:false,isPending:false,refetch:vi.fn()}});
describe('Go-Live failure visibility',()=>{
 it('shows a readiness error instead of an empty result or stale green status',()=>{m.readiness.isError=true;m.readiness.error=new Error('network unavailable');const html=renderToStaticMarkup(<Component/>);expect(html).toContain('Readiness could not be verified');expect(html).toContain('Overall: Unknown');expect(html).not.toContain('Overall: Ready');expect(html).not.toContain('No readiness signals available')});
 it('shows menu request failures instead of import advice or all-ready claims',()=>{m.menu.isError=true;m.menu.error=new Error('network unavailable');const html=renderToStaticMarkup(<Component/>);expect(html).toContain('Menu readiness could not be verified');expect(html).not.toContain('All 1 menu items');expect(html).not.toContain('No menu items for this property')});
 it('renders pending checks as loading rather than an empty successful query',()=>{m.readiness.isPending=true;m.readiness.data=undefined;const html=renderToStaticMarkup(<Component/>);expect(html).not.toContain('No readiness signals available');expect(html).not.toContain('Overall: Ready')});
});
