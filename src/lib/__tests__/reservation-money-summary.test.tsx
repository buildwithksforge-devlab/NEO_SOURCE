// @vitest-environment jsdom
import {cleanup,render,screen,within} from "@testing-library/react";
import {afterEach,describe,expect,it} from "vitest";
import {ReservationMoneySummary} from "@/components/pms/ReservationMoneySummary";
const position={currency:"KES",quote:30000,obligation:30000,collected:5000,pending:2000,outstanding:25000,
 credit:0,headroom:23000,deposit_paid:5000,payment_status:"part-paid"};
afterEach(cleanup);
describe("reservation money explains the booking/posted-folio distinction",()=>{
 it("shows received deposits as an included subtotal and pending as a separate collection reservation",()=>{
  render(<ReservationMoneySummary position={position}/>);
  for(const [label,amount] of [["Current booking obligation","30,000"],["Confirmed money received","5,000"],["Of which deposits (already included)","5,000"],["Booking amount still due","25,000"],["Awaiting confirmation","2,000"],["Available for a new collection","23,000"]]){
   const row=screen.getByText(label!).parentElement!;expect(within(row).getByText(new RegExp(amount!))).toBeTruthy();
  }
  expect(screen.getByText(/Applying a deposit to a folio moves the same money/)).toBeTruthy();
  expect(screen.getByText(/Posted folio balances below cover charges posted so far/)).toBeTruthy();
 });
});
