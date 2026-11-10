import {describe,it,expect} from 'vitest';
import {rosterShiftWindow} from '@/lib/roster-time';
describe('property-local roster assignment',()=>{
 it('stores Nairobi wall-clock times as UTC instants without using the laptop timezone',()=>{
  expect(rosterShiftWindow('2026-11-07','08:00:00','17:00:00','Africa/Nairobi')).toEqual({startsAt:'2026-11-07T05:00:00.000Z',endsAt:'2026-11-07T14:00:00.000Z'});
 });
 it('ends overnight shifts on the next property calendar day',()=>{
  expect(rosterShiftWindow('2026-12-31','22:00','06:00','Africa/Nairobi')).toEqual({startsAt:'2026-12-31T19:00:00.000Z',endsAt:'2027-01-01T03:00:00.000Z'});
 });
 it('respects property zones with fractional-hour offsets and template seconds',()=>{
  expect(rosterShiftWindow('2026-11-07','08:00:15','16:00:30','Asia/Kolkata')).toEqual({startsAt:'2026-11-07T02:30:15.000Z',endsAt:'2026-11-07T10:30:30.000Z'});
 });
 it('uses each date’s actual daylight-saving offset',()=>{
  expect(rosterShiftWindow('2026-07-07','08:00','16:00','Europe/London').startsAt).toBe('2026-07-07T07:00:00.000Z');
  expect(rosterShiftWindow('2026-11-07','08:00','16:00','Europe/London').startsAt).toBe('2026-11-07T08:00:00.000Z');
 });
 it('refuses invalid dates, invalid timezone, invalid or zero-length times',()=>{
  for(const args of [['2026-02-30','08:00','16:00','UTC'],['2026-11-07','24:00','16:00','UTC'],['2026-11-07','','16:00','UTC'],['2026-11-07','08:00','08:00','UTC'],['2026-11-07','08:00','16:00','Unknown/Zone']]){
   expect(()=>rosterShiftWindow(...args as [string,string,string,string])).toThrow();
  }
 });
 it('refuses missing and repeated daylight-saving clock times',()=>{
  expect(()=>rosterShiftWindow('2026-03-29','01:30','08:00','Europe/London')).toThrow(/clock change/);
  expect(()=>rosterShiftWindow('2026-10-25','01:30','08:00','Europe/London')).toThrow(/clock change/);
 });
});
