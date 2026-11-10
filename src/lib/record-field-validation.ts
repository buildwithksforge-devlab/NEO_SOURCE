import {departmentIdentity} from '@/lib/menu-scoping';
type Field={name:string;label:string;type?:string;required?:boolean;options?:{value:string}[]};
export function recordFieldsError(fields:readonly Field[],values:Record<string,unknown>):string|null{
  for(const f of fields){
    const value=values[f.name];
    const empty=value===null||value===undefined||(typeof value==='string'&&!value.trim());
    if(f.required&&(empty||(f.type==='checkbox'&&value!==true)))return `${f.label} is required.`;
    if(empty)continue;
    if(f.type==='number'&&!Number.isFinite(Number(value)))return `${f.label} must be a valid number.`;
    if(f.type==='select'&&f.options&&!f.options.some(option=>option.value===value))return `Choose an available ${f.label.toLowerCase()}.`;
  }
  return null;
}

export function eventDepartmentChoices<T extends {id?:unknown;name?:unknown;catalogue_key?:unknown;organization_id?:unknown;branch_id?:unknown;active?:unknown}>(departments:readonly T[],organizationId:string|null,branchId:string|null):T[]{
  if(!organizationId||!branchId)return [];
  const best=new Map<string,T>();
  for(const d of departments.filter(d=>d.organization_id===organizationId&&d.active===true&&(d.branch_id===branchId||d.branch_id===null))){
    const key=departmentIdentity({id:String(d.id),name:String(d.name??d.id??''),catalogue_key:typeof d.catalogue_key==='string'?d.catalogue_key:null,branch_id:d.branch_id===null?null:String(d.branch_id),active:true});
    const held=best.get(key);
    if(!held||(held.branch_id===null&&d.branch_id===branchId))best.set(key,d);
  }
  return [...best.values()];
}
