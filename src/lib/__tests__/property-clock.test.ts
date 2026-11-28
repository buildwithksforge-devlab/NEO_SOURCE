import {describe,it,expect} from 'vitest';
import {propertyDateTimeToIso,propertyDateTimeInput,propertyTimeZone} from '@/lib/property-clock';
import {recordFieldsError,eventDepartmentChoices} from '@/lib/record-field-validation';
describe('property deadlines use the property clock',()=>{
 it('stores Nairobi 18:30 as 15:30 UTC and renders the original wall time',()=>{const instant=propertyDateTimeToIso('2026-11-08T18:30','Africa/Nairobi');expect(instant).toBe('2026-11-08T15:30:00.000Z');expect(propertyDateTimeInput(instant,'Africa/Nairobi')).toBe('2026-11-08T18:30')});
 it('does not depend on the computer timezone',()=>{const before=process.env['TZ'];try{process.env['TZ']='Pacific/Honolulu';expect(propertyDateTimeToIso('2026-11-08T18:30','Africa/Nairobi')).toBe('2026-11-08T15:30:00.000Z')}finally{if(before===undefined)delete process.env['TZ'];else process.env['TZ']=before}});
 it('handles quarter-hour offsets and crossing the UTC date',()=>expect(propertyDateTimeToIso('2026-11-08T01:15','Asia/Kathmandu')).toBe('2026-11-07T19:30:00.000Z'));
 it('preserves explicit seconds',()=>expect(propertyDateTimeToIso('2026-11-08T18:30:45','Africa/Nairobi')).toBe('2026-11-08T15:30:45.000Z'));
 it('leaves empty optional deadlines empty',()=>expect(propertyDateTimeToIso('',null)).toBeNull());
 it.each(['2026-02-30T12:00','2026-11-08T24:00','2026-11-08T12:60','2026-11-08T12:00:60','2026-11-08','2026-11-08T12:00Z','bad'])('refuses invalid wall-clock input %s',value=>expect(()=>propertyDateTimeToIso(value,'Africa/Nairobi')).toThrow());
 it('refuses missing or invalid timezone instead of guessing the computer clock',()=>{expect(()=>propertyDateTimeToIso('2026-11-08T12:00',null)).toThrow(/property/);expect(()=>propertyDateTimeToIso('2026-11-08T12:00','Unknown/Zone')).toThrow(/timezone/)});
 it('refuses a skipped spring clock hour',()=>expect(()=>propertyDateTimeToIso('2026-03-08T02:30','America/New_York')).toThrow(/skipped or repeated/));
 it('refuses an ambiguous autumn clock hour',()=>expect(()=>propertyDateTimeToIso('2026-11-01T01:30','America/New_York')).toThrow(/skipped or repeated/));
 it('accepts normal DST hours',()=>expect(propertyDateTimeToIso('2026-07-08T12:30','America/New_York')).toBe('2026-07-08T16:30:00.000Z'));
 it('resolves the record property rather than another selected property',()=>{const branches=[{id:'a',organization_id:'org',timezone:'Africa/Nairobi'},{id:'b',organization_id:'org',timezone:'Asia/Kathmandu'}];expect(propertyTimeZone(branches,'b','org','UTC')).toBe('Asia/Kathmandu')});
 it('does not use another workspace or inactive property clock',()=>{expect(propertyTimeZone([{id:'a',organization_id:'other',timezone:'UTC'}],'a','org','Africa/Nairobi')).toBeNull();expect(propertyTimeZone([{id:'a',organization_id:'org',active:false,timezone:'UTC'}],'a','org','Africa/Nairobi')).toBeNull()});
 it('retains the configured organization fallback for a known property',()=>expect(propertyTimeZone([{id:'a',organization_id:'org',timezone:null}],'a','org','Africa/Nairobi')).toBe('Africa/Nairobi'));
});
describe('event requirement capture',()=>{
 const fields=[{name:'department',label:'Configured department',type:'select',required:true,options:[{value:'d'}]}];
 it('required selects block an empty submission',()=>expect(recordFieldsError(fields,{department:''})).toMatch(/required/));
 it('stale or unauthorized dropdown choices are refused',()=>expect(recordFieldsError(fields,{department:'other'})).toMatch(/available/));
 it('known required selections are retained',()=>expect(recordFieldsError(fields,{department:'d'})).toBeNull());
 it('numeric zero is retained and nonfinite numbers are refused',()=>{const numbers=[{name:'number',label:'Quantity',type:'number',required:true}];expect(recordFieldsError(numbers,{number:0})).toBeNull();expect(recordFieldsError(numbers,{number:NaN})).toMatch(/valid number/)});
 it('required whitespace-only fields are refused',()=>expect(recordFieldsError([{name:'name',label:'Name',required:true}],{name:'  '})).toMatch(/required/));
 it('offers only active same-workspace property/shared departments',()=>{const rows=[{id:'local',organization_id:'org',branch_id:'a',active:true},{id:'shared',organization_id:'org',branch_id:null,active:true},{id:'wrong-property',organization_id:'org',branch_id:'b',active:true},{id:'wrong-org',organization_id:'other',branch_id:'a',active:true},{id:'inactive',organization_id:'org',branch_id:'a',active:false}];expect(eventDepartmentChoices(rows,'org','a').map(d=>d.id)).toEqual(['local','shared']);expect(eventDepartmentChoices(rows,'org',null)).toEqual([])});
 it('deduplicates Main Kitchen choices and prefers the property configuration',()=>{const rows=[{id:'shared',name:'Main Kitchen',organization_id:'org',branch_id:null,active:true},{id:'local',name:'Main Kitchen',organization_id:'org',branch_id:'a',active:true}];expect(eventDepartmentChoices(rows,'org','a').map(d=>d.id)).toEqual(['local'])});
});
