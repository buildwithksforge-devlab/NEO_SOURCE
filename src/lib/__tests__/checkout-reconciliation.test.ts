import {describe,expect,it} from "vitest";
import {checkoutPosition,mapCheckoutFolio,requireCheckoutResult,type CheckoutFolio} from "@/lib/checkout-reconciliation";
import {reservationFolioIndex} from "@/lib/reservation-folio-index";
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const row={id:id(1),branch_id:"hotel-a",folio_number:"F-1",folio_type:"guest",currency:"KES",status:"open"};
const projection={found:true,folio_id:id(1),branch_id:"hotel-a",currency:"KES",gross_obligation:100,collected:50,outstanding:50};
const folio=(over:Partial<CheckoutFolio>={}):CheckoutFolio=>({id:id(1),number:"F-1",type:"guest",currency:"KES",status:"open",charges:100,collected:50,outstanding:50,...over});
describe("independent checkout financial evidence",()=>{
 it("reads canonical money instead of stale stored folio totals",()=>{
  expect(mapCheckoutFolio({...row,balance:999},projection,"hotel-a")).toMatchObject({charges:100,collected:50,outstanding:50});
 });
 it.each([{...projection,folio_id:id(2)},{...projection,branch_id:"hotel-b"},{...projection,currency:"USD"},{...projection,found:false},{...projection,outstanding:0},{...projection,collected:" "},{...projection,gross_obligation:"NaN"}])("refuses unverifiable folio projection %j",value=>{
  expect(()=>mapCheckoutFolio(row,value,"hotel-a")).toThrow();
 });
 it("shows debt and credit separately rather than netting folios to zero",()=>{
  expect(checkoutPosition([folio(),folio({id:id(2),collected:150,outstanding:-50})])).toMatchObject({amountDue:50,creditDue:50,mixedCurrency:false});
 });
 it("refuses missing/duplicate folios and identifies mixed currencies",()=>{
  expect(()=>checkoutPosition([])).toThrow(/No financial folio/);
  expect(()=>checkoutPosition([folio(),folio()])).toThrow(/duplicate/);
  expect(checkoutPosition([folio(),folio({id:id(2),currency:"USD"})])).toMatchObject({mixedCurrency:true,currency:null});
 });
 const result=()=>({ok:true,stay_id:id(3),reservation_id:id(4),folio_id:id(1),folio_count:2,charges:300,collected:300,outstanding:0,forced:false,room_state:"vacant-dirty",
  folios:[{folio_id:id(1),currency:"KES",charges:100,collected:100,outstanding:0,status:"settled"},{folio_id:id(2),currency:"KES",charges:200,collected:200,outstanding:0,status:"settled"}]});
 it("verifies every modern saved folio and aggregate before reporting checkout success",()=>{
  const value=result();expect(requireCheckoutResult(value,id(4))).toEqual(value);
 });
 it.each(["count","duplicate","total","debt","currency","reservation"])("refuses conflicting %s in an apparently successful checkout",defect=>{
  const value=result();
  if(defect==="count")value.folio_count=1;
  if(defect==="duplicate")value.folios[1]!.folio_id=id(1);
  if(defect==="total")value.collected=301;
  if(defect==="debt")value.folios[1]!.outstanding=1;
  if(defect==="currency")value.folios[1]!.currency="USD";
  if(defect==="reservation")value.reservation_id=id(9);
  expect(()=>requireCheckoutResult(value,id(4))).toThrow();
 });
 it("retains compatibility with the deployed legacy checkout response without inventing folios",()=>{
  const legacy={stay_id:id(3),folio_id:id(1),idempotent:true};
  expect(requireCheckoutResult(legacy,id(4))).toEqual(legacy);
  expect(()=>requireCheckoutResult({stay_id:id(3),ok:false},id(4))).toThrow();
 });
 it("retains all open-folio balances and chooses guest navigation independent of query order",()=>{
  const rows=[{id:id(2),reservation_id:id(4),folio_type:"corporate",currency:"KES",balance:200},{id:id(1),reservation_id:id(4),folio_type:"guest",currency:"KES",balance:100},{id:id(5),reservation_id:id(4),folio_type:"group",currency:"KES",balance:-150}];
  expect(reservationFolioIndex(rows)[id(4)]).toMatchObject({id:id(1),count:3,balance:300,credit:150});
  expect(reservationFolioIndex([...rows].reverse())[id(4)]).toMatchObject({id:id(1),count:3,balance:300,credit:150});
  expect(reservationFolioIndex([{...rows[0]!,balance:null}])[id(4)]?.balance).toBeNull();
 });
});
