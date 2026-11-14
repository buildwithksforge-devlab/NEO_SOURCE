import { describe, expect, it } from 'vitest';
import { requireVoidResult } from '@/lib/pos-void-result';
describe('durable void confirmation', () => {
 const pending = {ok:true,request_id:'r',order_id:'o',status:'pending'};
 it('accepts a saved request for the intended order',()=>expect(requireVoidResult(pending,{orderId:'o'})).toEqual(pending));
 it.each([null, {}, {...pending,ok:false}, {...pending,request_id:null}, {...pending,order_id:'elsewhere'}, {...pending,status:'applied'}])('rejects unconfirmed request results %j',r=>expect(()=>requireVoidResult(r,{orderId:'o'})).toThrow());
 it('requires the approved item effect',()=> {
  expect(()=>requireVoidResult({...pending,status:'applied',item_status:'served'},{requestId:'r',approve:true})).toThrow();
  expect(requireVoidResult({...pending,status:'applied',item_status:'voided'},{requestId:'r',approve:true}).status).toBe('applied');
 });
 it('rejects a different saved decision',()=>expect(()=>requireVoidResult({...pending,status:'applied',item_status:'voided'},{requestId:'other',approve:true})).toThrow());
 it('checks rejection separately',()=> {
  expect(requireVoidResult({...pending,status:'rejected'},{requestId:'r',approve:false}).status).toBe('rejected');
  expect(()=>requireVoidResult({...pending,status:'applied',item_status:'voided'},{requestId:'r',approve:false})).toThrow();
 });
});
