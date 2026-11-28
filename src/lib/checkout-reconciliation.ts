import {requireSavedRecord} from "./durable-command-result";
type Row=Record<string,unknown>;
const uuid=(value:unknown):value is string=>typeof value==="string"&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
function amount(value:unknown):number {
  if((typeof value!=="number"&&typeof value!=="string")||(typeof value==="string"&&!value.trim())||!Number.isFinite(Number(value)))
    throw new Error("The checkout financial amounts could not be verified.");
  const number=Number(value);
  if(!Number.isSafeInteger(Math.round(number*100)))throw new Error("Checkout amount exceeds supported precision.");
  return number;
}
export type CheckoutFolio={id:string;number:string;type:string;currency:string;status:string;charges:number;collected:number;outstanding:number};
export function mapCheckoutFolio(row:Row,value:unknown,branchId:string):CheckoutFolio {
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Folio financial position is unavailable.");
  const projection=value as Row;
  if(!uuid(row["id"])||projection["found"]!==true||projection["folio_id"]!==row["id"]
    ||row["branch_id"]!==branchId||projection["branch_id"]!==branchId
    ||typeof row["currency"]!=="string"||!row["currency"]||projection["currency"]!==row["currency"])
    throw new Error("Folio identity, property or currency could not be verified.");
  const charges=amount(projection["gross_obligation"]),collected=amount(projection["collected"]),outstanding=amount(projection["outstanding"]);
  if(Math.abs(charges-collected-outstanding)>=0.005)throw new Error("Folio financial amounts do not reconcile.");
  return {id:row["id"],number:String(row["folio_number"]??row["id"]),type:String(row["folio_type"]??"guest"),
    currency:row["currency"],status:String(row["status"]??""),charges,collected,outstanding};
}
export function checkoutPosition(folios:CheckoutFolio[]) {
  if(!folios.length)throw new Error("No financial folio exists for this stay.");
  const currencies=[...new Set(folios.map(f=>f.currency))];
  const ids=new Set(folios.map(f=>f.id));
  if(ids.size!==folios.length)throw new Error("Checkout contains duplicate folio identities.");
  return {folios,currency:currencies.length===1?currencies[0]!:null,mixedCurrency:currencies.length!==1,
    amountDue:folios.reduce((sum,f)=>sum+Math.max(0,Math.round(f.outstanding*100)),0)/100,
    creditDue:folios.reduce((sum,f)=>sum+Math.max(0,-Math.round(f.outstanding*100)),0)/100};
}
export function requireCheckoutResult(value:unknown,reservation:string):Row {
  const result=requireSavedRecord(value,["stay_id"],"Check-out did not confirm the saved stay.");
  if(!uuid(result["stay_id"])||(result["reservation_id"]!=null&&result["reservation_id"]!==reservation))
    throw new Error("Checkout result does not match the saved stay/reservation.");
  if(result["folios"]===undefined&&result["folio_count"]===undefined)return result; // Existing deployed RPC contract.
  if(result["ok"]!==true||result["reservation_id"]!==reservation||!Array.isArray(result["folios"])
    ||result["room_state"]!=="vacant-dirty"||result["folio_count"]!==result["folios"].length||result["folios"].length===0)
    throw new Error("Checkout did not confirm every included folio.");
  const ids=new Set<string>();let charges=0,collected=0,outstanding=0;let currency:string|undefined;
  for(const item of result["folios"]){
    if(!item||typeof item!=="object"||Array.isArray(item))throw new Error("Invalid checkout folio evidence.");
    const folio=item as Row,id=folio["folio_id"];
    if(!uuid(id)||ids.has(id)||typeof folio["currency"]!=="string"||!folio["currency"])
      throw new Error("Invalid checkout folio identity/currency.");
    ids.add(id);
    if(currency&&currency!==folio["currency"])throw new Error("Checkout contains mixed currencies.");
    currency=folio["currency"];
    const billed=amount(folio["charges"]),paid=amount(folio["collected"]),balance=amount(folio["outstanding"]);
    if(Math.abs(billed-paid-balance)>=0.005||balance<0
      ||folio["status"]!==(balance>0?"under-review":"settled")||(balance>0&&result["forced"]!==true))
      throw new Error("Checkout folio settlement does not reconcile.");
    charges+=Math.round(billed*100);collected+=Math.round(paid*100);outstanding+=Math.round(balance*100);
  }
  if(!ids.has(String(result["folio_id"]))||Math.round(amount(result["charges"])*100)!==charges
    ||Math.round(amount(result["collected"])*100)!==collected||Math.round(amount(result["outstanding"])*100)!==outstanding)
    throw new Error("Checkout totals disagree with the included folios.");
  return result;
}
