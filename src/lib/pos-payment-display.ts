export function cashTender(amount: number, raw: string): {tendered:number;change:number;error:null}|{tendered:null;change:null;error:string} {
 const tendered=raw.trim()===''?amount:Number(raw);
 if(!Number.isFinite(amount)||amount<=0||!Number.isFinite(tendered)||tendered<amount||Math.abs(Math.round(tendered*100)-tendered*100)>0.000001) return {tendered:null,change:null,error:'Enter cash tendered in cents, at least the payment amount.'};
 return {tendered,change:Math.round((tendered-amount)*100)/100,error:null};
}
export const POS_OPEN_FILTER='status.in.(draft,held,confirmed,sent,accepted,in-preparation,partially-ready,ready,partially-served,served,awaiting-payment),and(status.eq.paid,payment_status.in.(partial,partially_paid,unpaid,pending))';
export function outstandingPaidBill(order:{status:string;payment_status?:string|null}):boolean {
 return order.status==='paid'&&['partial','partially_paid','unpaid','pending'].includes(order.payment_status??'');
}
