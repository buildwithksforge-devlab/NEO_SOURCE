import {describe,it,expect} from 'vitest';
import {stationDepartmentOptions,assertStationPlacement,confirmStationWrite} from '@/lib/station-write';
const depts=[{id:'org',name:'Shared',branch_id:null,active:true},{id:'a',name:'Kitchen A',branch_id:'a',active:true},{id:'b',name:'Kitchen B',branch_id:'b',active:true},{id:'inactive',name:'Old',branch_id:'a',active:false}];
describe('station placement and durable saved result',()=>{
 it('organisation-wide station cannot retain a property-specific department',()=>{expect(stationDepartmentOptions(depts,null).map(d=>d.id)).toEqual(['org'])});
 it('a property can use its active departments and shared department',()=>{expect(stationDepartmentOptions(depts,'a').map(d=>d.id).sort()).toEqual(['a','org'])});
 it('refuses blank, stale, inactive and other-property create assignments',()=>{
  expect(()=>assertStationPlacement(' ', 'a','a',depts)).toThrow(/name/);
  for(const id of ['b','inactive','missing'])expect(()=>assertStationPlacement('Coffee','a',id,depts)).toThrow(/active departments/);
  expect(()=>assertStationPlacement('Coffee','','org',depts)).toThrow();
 });
 it('permits valid named stations without hardcoding their station or department identity',()=>{expect(()=>assertStationPlacement('New production counter','a','a',depts)).not.toThrow()});
 it('RLS/no-row/empty and wrong-ID results are never successful saves',()=>{
  expect(()=>confirmStationWrite(null,null)).toThrow(/not confirmed/);
  expect(()=>confirmStationWrite({},null)).toThrow(/not confirmed/);
  expect(()=>confirmStationWrite({id:'other'},null,'expected')).toThrow(/not confirmed/);
  expect(()=>confirmStationWrite(null,{message:'denied'})).toThrow(/denied/);
 });
 it('confirms only a returned saved identity',()=>{expect(confirmStationWrite({id:'a'},null,'a')).toBe('a');expect(confirmStationWrite({id:'new'},null)).toBe('new')});
});
