import {describe,it,expect,vi} from 'vitest';
import {createDepartmentTask,requireSavedTask,validateTaskCreation,type TaskCreation} from '@/lib/task-creation';
const draft:TaskCreation={organization_id:'org',branch_id:'property',department_id:'department',assignee_id:'worker',created_by:'manager',title:'Inspect handover',status:'open'};
const saved={...draft,id:'task'};
function client(data:unknown=saved,error:{message:string}|null=null){const single=vi.fn().mockResolvedValue({data,error}),select=vi.fn(()=>({single})),insert=vi.fn(()=>({select})),from=vi.fn(()=>({insert}));return {db:{from},from,insert,select,single};}
describe('task creation ownership and persistence',()=>{
 it('saves the requested property, department and worker and returns the real task ID',async()=>{const m=client();expect(await createDepartmentTask(m.db,draft)).toEqual(saved);expect(m.insert).toHaveBeenCalledWith(draft);expect(m.select).toHaveBeenCalledWith(expect.stringContaining('branch_id'))});
 for(const key of ['organization_id','branch_id','department_id','assignee_id','created_by'] as const){
  it('refuses missing '+key+' before creating a row',async()=>{const m=client();await expect(createDepartmentTask(m.db,{...draft,[key]:null})).rejects.toThrow();expect(m.from).not.toHaveBeenCalled()});
 }
 it('refuses a blank title before creating a row',async()=>{const m=client();await expect(createDepartmentTask(m.db,{...draft,title:' '})).rejects.toThrow(/title/);expect(m.from).not.toHaveBeenCalled()});
 for(const key of ['organization_id','branch_id','department_id','assignee_id','status'] as const){
  it('does not report success when the database saved a different '+key,async()=>{const m=client({...saved,[key]:'different'});await expect(createDepartmentTask(m.db,draft)).rejects.toThrow(/differs/)})
 }
 it.each([null,{},[],{id:''},{...saved,id:null}])('rejects an unconfirmed insert %j',async value=>{await expect(createDepartmentTask(client(value).db,draft)).rejects.toThrow(/not confirmed/)});
 it('preserves the server assignment-scope refusal',async()=>{await expect(createDepartmentTask(client(null,{message:'That worker belongs to another property'}).db,draft)).rejects.toThrow('That worker belongs to another property')});
 it('permits an explicitly unassigned department queue task through the main task path',()=>{const pending={...draft,assignee_id:null,status:'new'};expect(()=>validateTaskCreation(pending)).not.toThrow();expect(requireSavedTask({...pending,id:'task'},pending)["assignee_id"]).toBeNull()});
 it('does not force an unassigned team task onto the current user',()=>{expect(()=>validateTaskCreation({...draft,assignee_id:null},true)).toThrow(/worker/)});
 it('accepts a valid task in another company using its own context',async()=>{const task={...draft,organization_id:'other-org',branch_id:'other-property',department_id:'other-dept',assignee_id:'other-worker'};expect(await createDepartmentTask(client({...task,id:'other-task'}).db,task)).toMatchObject({id:'other-task'})});
});

