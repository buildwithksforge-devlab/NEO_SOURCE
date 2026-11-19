const transferStatuses=new Set(["sent","accepted","in-preparation","partially-ready","ready","partially-served","served","awaiting-payment"]);
const terminal=new Set(["closed","cancelled","voided","credit","charged-to-room"]);
const inactiveAttempts=new Set(["failed","cancelled","voided","void","expired"]);
function money(value:unknown):number|null {
 if((typeof value!=="number"&&typeof value!=="string")||String(value).trim()===""||!Number.isFinite(Number(value))||Number(value)<0)return null;
 const amount=Number(value);return Number.isSafeInteger(Math.round(amount*100))?amount:null;
}
export function posRoomTransferState(order:{status?:unknown;folio_post_status?:unknown;folio_id?:unknown;grand_total?:unknown;paid_total?:unknown;payment_status?:unknown;tip_amount?:unknown;delivery_fee?:unknown;pos_payments?:readonly {status?:unknown;provider_status?:unknown}[]|null}|null|undefined,receiptUnderReview=false){
 const total=money(order?.grand_total),paid=money(order?.paid_total);
 const transferred=order?.folio_post_status==="posted"||order?.status==="charged-to-room";
 const amountKnown=total!==null&&paid!==null;
 const overlap=transferred&&(!amountKnown||paid!==0||!order?.folio_id);
 const amountDue=amountKnown&&!overlap?(transferred?0:Math.max(0,Math.round((total-paid)*100)/100)):null;
 const credit=amountKnown&&!transferred?Math.max(0,Math.round((paid-total)*100)/100):0;
 const attempts=order?.pos_payments;
 let reason:string|null=null;
 if(transferred)reason=overlap?"Room transfer and POS payment evidence need reconciliation. Review the original receipts and guest folio.":"This bill is already on the guest folio. Collect against that guest account.";
 else if(!amountKnown||!Array.isArray(attempts))reason="Bill amounts and saved payment attempts could not be verified. Refresh before room transfer.";
 else if(paid!==0||order?.payment_status!=="unpaid"||receiptUnderReview||attempts.some(p=>!inactiveAttempts.has(String(p.status??""))||p.provider_status==="manager-reviewed"))
  reason="This bill has recorded or unresolved money. Reconcile its original payment before room transfer.";
 else if(!transferStatuses.has(String(order?.status??"")))reason="Send this unpaid bill to production before charging it to a room.";
 else if((order?.tip_amount!=null&&money(order.tip_amount)!==0)||(order?.delivery_fee!=null&&money(order.delivery_fee)!==0))
  reason="A bill with tips or delivery fees needs component allocation before room transfer.";
 else if(total<=0)reason="Add a valid charge before room transfer.";
 return {transferred,overlap,amountDue,credit,canCollect:amountDue!==null&&amountDue>0&&!transferred&&!terminal.has(String(order?.status??"")),canTransfer:reason===null,reason};
}
