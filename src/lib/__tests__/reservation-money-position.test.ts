import {describe,expect,it} from "vitest";
import {requireReservationMoneyPosition} from "../reservation-money-position";
const saved={reservation_id:"res",currency:"KES",quote:30000,obligation:30000,collected:5000,pending:2000,
 outstanding:25000,credit:0,headroom:23000,deposit_paid:5000,payment_status:"part-paid"};
describe("reservation money uses one confirmed receipt and a separate pending reservation",()=>{
 it("keeps pending money out of paid deductions while reserving new collection capacity",()=>{
  expect(requireReservationMoneyPosition(saved,"res")).toMatchObject({collected:5000,outstanding:25000,pending:2000,headroom:23000});
 });
 it("does not count deposit application as another receipt",()=>{
  expect(requireReservationMoneyPosition({...saved,deposit_paid:5000},"res").outstanding).toBe(25000);
  expect(()=>requireReservationMoneyPosition({...saved,collected:10000},"res")).toThrow(/reconcile/);
 });
 it("shows overpayment separately without a negative amount due",()=>{
  expect(requireReservationMoneyPosition({...saved,collected:35000,deposit_paid:5000,pending:0,outstanding:0,credit:5000,headroom:0,payment_status:"paid"},"res")).toMatchObject({credit:5000,outstanding:0});
 });
 it("retains a larger current obligation when extra charges are posted",()=>{
  expect(requireReservationMoneyPosition({...saved,obligation:32000,outstanding:27000,headroom:25000},"res").obligation).toBe(32000);
 });
 it.each([{outstanding:23000},{headroom:25000},{credit:5000},{deposit_paid:6000},{collected:NaN},{quote:null},{pending:"2000"},{currency:""},{reservation_id:"other"}])("refuses contradictory or unknown amounts %j",patch=>{
  expect(()=>requireReservationMoneyPosition({...saved,...patch},"res")).toThrow(/reconcile/);
 });
});
