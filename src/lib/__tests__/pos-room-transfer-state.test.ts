import {describe,expect,it} from "vitest";
import {posRoomTransferState} from "../pos-room-transfer";
const bill={status:"served",folio_post_status:"not-posted",folio_id:null,grand_total:7261.5,paid_total:0,payment_status:"unpaid",pos_payments:[]};
describe("POS room transfer and collection boundary",()=>{
 it("allows a completely unpaid served bill without requiring payment before production",()=>expect(posRoomTransferState(bill)).toMatchObject({canTransfer:true,canCollect:true,amountDue:7261.5}));
 it("does not offer the remaining partial debt as a full-bill room charge",()=>expect(posRoomTransferState({...bill,paid_total:2000,payment_status:"partial"})).toMatchObject({canTransfer:false,canCollect:true,amountDue:5261.5}));
 it.each(["confirmed","pending","initiated","processing","unknown"])("refuses a room transfer with saved payment status %s",status=>expect(posRoomTransferState({...bill,pos_payments:[{status}]}).canTransfer).toBe(false));
 it("allows final failed attempts but keeps active receipt review blocked",()=>{
  const failed={...bill,pos_payments:[{status:"failed"}]};expect(posRoomTransferState(failed).canTransfer).toBe(true);
  expect(posRoomTransferState(failed,true).canTransfer).toBe(false);
 });
 it("shows transferred debt at the guest account without pretending cash was received",()=>expect(posRoomTransferState({...bill,folio_post_status:"posted",folio_id:"folio",status:"charged-to-room",payment_status:"paid"})).toMatchObject({transferred:true,canTransfer:false,canCollect:false,amountDue:0,overlap:false}));
 it("blocks a transferred bill with existing direct payments for reconciliation",()=>expect(posRoomTransferState({...bill,folio_post_status:"posted",folio_id:"folio",paid_total:2000})).toMatchObject({overlap:true,amountDue:null,canCollect:false,canTransfer:false}));
 it.each([null,NaN,"",Infinity])("does not turn unknown total %s into a zero balance",grand_total=>expect(posRoomTransferState({...bill,grand_total})).toMatchObject({amountDue:null,canCollect:false,canTransfer:false}));
 it("requires payment-attempt evidence and refuses unallocated extra components",()=>{
  expect(posRoomTransferState({...bill,pos_payments:null}).canTransfer).toBe(false);
  expect(posRoomTransferState({...bill,tip_amount:50}).canTransfer).toBe(false);
  expect(posRoomTransferState({...bill,delivery_fee:50}).canTransfer).toBe(false);
 });
 it("keeps a genuine overpayment as explicit credit rather than a negative collection amount",()=>expect(posRoomTransferState({...bill,paid_total:8000,payment_status:"paid"})).toMatchObject({amountDue:0,credit:738.5,canCollect:false,canTransfer:false}));
});
