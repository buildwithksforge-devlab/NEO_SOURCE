const transferStatuses=new Set(["sent","accepted","in-preparation","partially-ready","ready","partially-served","served","awaiting-payment"]);
const terminal=new Set(["closed","cancelled","voided","credit","charged-to-room"]);
const inactiveAttempts=new Set(["failed","cancelled","voided","void","expired"]);
function money(value:unknown):number|null {
 if((typeof value!=="number"&&typeof value!=="string")||String(value).trim()===""||!Number.isFinite(Number(value))||Number(value)<0)return null;
 const amount=Number(value);return Number.isSafeInteger(Math.round(amount*100))?amount:null;
}
export function posRoomTransferState(order:{status?:unknown;folio_post_status?:unknown;folio_id?:unknown;grand_total?:unknown;paid_total?:unknown;room_transfer_paid_total?:unknown;payment_status?:unknown;tip_amount?:unknown;delivery_fee?:unknown;pos_payments?:readonly {status?:unknown;amount?:unknown}[]|null}|null|undefined,receiptUnderReview=false){
 const total=money(order?.grand_total),paid=money(order?.paid_total);
 const transferred=order?.folio_post_status==="posted"||order?.status==="charged-to-room";
 const amountKnown=total!==null&&paid!==null;
 const allocated=money(order?.room_transfer_paid_total);
 const overlap=transferred&&(!amountKnown||(paid!==0&&allocated!==paid)||!order?.folio_id);
 const amountDue=amountKnown&&!overlap?(transferred?0:Math.max(0,Math.round((total-paid)*100)/100)):null;
 const credit=amountKnown&&!transferred?Math.max(0,Math.round((paid-total)*100)/100):0;
 const attempts=order?.pos_payments;
 const confirmed=attempts?.filter(p=>p.status==="confirmed").map(p=>money(p.amount))??[];
 const confirmedCents=confirmed.reduce<number>((sum, amount)=>sum+Math.round((amount??0)*100),0);
 let reason:string|null=null;
 if(transferred)reason=overlap?"Room transfer and POS payment evidence need reconciliation. Review the original receipts and guest folio.":"This bill is already on the guest folio. Collect against that guest account.";
 else if(!amountKnown||!Array.isArray(attempts))reason="Bill amounts and saved payment attempts could not be verified. Refresh before room transfer.";
 else if(order?.payment_status!==(paid===0?"unpaid":"partial")||receiptUnderReview
  ||attempts.some(p=>p.status!=="confirmed"&&!inactiveAttempts.has(String(p.status??"")))
  ||confirmed.some(amount=>amount===null||amount<=0)||confirmedCents!==Math.round(paid*100))
  reason="This bill has unresolved or unmatched payment evidence. Reconcile its original payments before room transfer.";
 else if(!transferStatuses.has(String(order?.status??"")))reason="Send this bill to production before charging it to a room.";
 else if((order?.tip_amount!=null&&money(order.tip_amount)!==0)||(order?.delivery_fee!=null&&money(order.delivery_fee)!==0))
  reason="A bill with tips or delivery fees needs component allocation before room transfer.";
 else if(total<=paid)reason="This bill has no outstanding balance to transfer.";
 const transferredBalance=transferred&&!overlap&&amountKnown?Math.round((total-paid)*100)/100:null;
 return {transferred,overlap,amountDue,credit,transferredBalance,canCollect:amountDue!==null&&amountDue>0&&!transferred&&!terminal.has(String(order?.status??"")),canTransfer:reason===null,reason};
}
