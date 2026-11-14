import {describe,it,expect} from 'vitest';
import {depositGate,type DepositPosition} from '@/lib/deposits';
import {selectReservationFolio,linkedFolioBalance} from '@/lib/reservation-folios';
import {isCalendarDate,calendarNights,addCalendarDays,parseAvailabilitySearch,resolveAvailabilitySearch} from '@/lib/availability-search';
describe('deposit gate does not manufacture settled money',()=>{
 it.each([{}, {required:0},{outstanding:0},{required:NaN,outstanding:0},{required:0,outstanding:Infinity},{required:100,outstanding:-1},{required:'100',outstanding:0},{required:0,outstanding:0,paid:NaN}])('refuses missing or invalid amount evidence %j',fields=>expect(depositGate({ok:true,...fields} as unknown as DepositPosition).blocked).toBe(true));
 it('does not accept zero reported outstanding when supplied paid facts show a shortfall',()=>{const result=depositGate({ok:true,required:10000,paid:3000,outstanding:0});expect(result.blocked).toBe(true);expect(result.message).toContain('7000.00')});
 it('retains a genuinely settled deposit and known no-deposit policy',()=>{expect(depositGate({ok:true,required:10000,paid:10000,outstanding:0}).blocked).toBe(false);expect(depositGate({ok:true,required:0,paid:0,outstanding:0}).blocked).toBe(false)});
 it('retains explicit corporate-credit and single-use override policy gates',()=>{expect(depositGate({ok:true,waiver:'corporate-credit'}).blocked).toBe(false);expect(depositGate({ok:true,override_id:'authorized'}).blocked).toBe(false)});
});
describe('reservation folio identity and balances',()=>{
 const rows=[{id:'old',status:'closed'},{id:'active',status:'open'},{id:'newest-history',status:'closed'}];
 it('opens the active linked folio instead of the first historical one',()=>expect(selectReservationFolio(rows,null)?.id).toBe('active'));
 it('retains an explicitly selected historical folio for reading',()=>expect(selectReservationFolio(rows,'old')?.id).toBe('old'));
 it('does not keep a selected ID after it leaves the reservation',()=>expect(selectReservationFolio(rows,'other-reservation')?.id).toBe('active'));
 it('defaults to the newest active folio when several are open',()=>expect(selectReservationFolio([...rows,{id:'new-active',status:'under-review'}],null)?.id).toBe('new-active'));
 it('does not default to a voided folio',()=>{expect(selectReservationFolio([{id:'void',status:'voided'}],null)).toBeUndefined();expect(selectReservationFolio([],null)).toBeUndefined()});
 it('adds all active folio balances without double-counting a reservation deposit',()=>expect(linkedFolioBalance([{status:'open',currency:'KES',balance:1000},{status:'closed',currency:'KES',balance:200},{status:'voided',currency:'KES',balance:99999}],'KES')).toBe(1200));
 it('retains a genuine credit when aggregating balances',()=>expect(linkedFolioBalance([{status:'open',currency:'KES',balance:1000},{status:'open',currency:'KES',balance:-200}],'KES')).toBe(800));
 it('does not invent an exchange rate or a missing balance',()=>{expect(linkedFolioBalance([{status:'open',currency:'USD',balance:1}],'KES')).toBeNull();expect(linkedFolioBalance([{status:'open',currency:'KES',balance:NaN}],'KES')).toBeNull();expect(linkedFolioBalance([],'KES')).toBeNull()});
});
describe('real availability dates and whole guest counts',()=>{
 it.each(['2026-02-30','2026-04-31','2026-13-01','0000-01-01','bad'])('rejects an impossible calendar date %s',value=>{expect(isCalendarDate(value)).toBe(false);expect(calendarNights(value,'2026-11-10')).toBe(0);expect(parseAvailabilitySearch({arrival:value}).arrival).toBeUndefined()});
 it('retains leap days and negative explicit ranges',()=>{expect(isCalendarDate('2028-02-29')).toBe(true);expect(calendarNights('2028-02-28','2028-03-01')).toBe(2);expect(calendarNights('2026-11-10','2026-11-09')).toBe(-1)});
 it('does not silently roll an invalid date into a different stay',()=>{expect(addCalendarDays('2026-02-30',1)).toBe('2026-02-30');expect(addCalendarDays('2026-11-08',NaN)).toBe('2026-11-08')});
 it.each([0,-1,1.5,Infinity,NaN,true,' '])('does not preserve an invalid adult count %s',adults=>expect(parseAvailabilitySearch({adults}).adults).toBeUndefined());
 it('retains a valid zero child count and whole adult count',()=>expect(parseAvailabilitySearch({adults:'3',children:'0'})).toMatchObject({adults:3,children:0}));
 it('normalizes invalid programmatic party inputs just like URL inputs',()=>{const result=resolveAvailabilitySearch({arrival:'2026-11-08',departure:'2026-11-09',adults:NaN,children:-1});expect(result.values).toMatchObject({adults:2,children:0});expect(result.needsCanonicalUrl).toBe(true)});
});
