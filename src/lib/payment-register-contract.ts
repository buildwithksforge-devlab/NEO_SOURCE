import type {PaymentAttempt} from '@/lib/payment-register';
const states=new Set(['requested','pending','confirmed','posted','failed','cancelled','timed_out','refunded','voided']);
export class PaymentRegisterContractError extends Error {}
export function parsePaymentRegister(value:unknown):PaymentAttempt[]{
 const fail=()=>{throw new PaymentRegisterContractError('Payment records could not be verified. Refresh or review the source records before using these totals.');};
 if(!Array.isArray(value))return fail();
 const keys=new Set<string>();
 return value.map(raw=>{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return fail();
  const r=raw as Record<string,unknown>;
  for(const key of ['id','payment_id','payment_table','source_module','method','requested_at'])if(typeof r[key]!=='string'||!(r[key] as string).trim())return fail();
  if(!states.has(String(r['state']))||!Number.isFinite(Date.parse(String(r['requested_at']))))return fail();
  if(typeof r['amount']!=='number'&&typeof r['amount']!=='string')return fail();const amount=Number(r['amount']);
  if(!Number.isFinite(amount)||(['confirmed','posted'].includes(String(r['state']))&&amount<=0))return fail();
  if(typeof r['manual_tender']!=='boolean')return fail();
  const key=String(r['payment_table'])+':'+String(r['payment_id']);if(keys.has(key))return fail();keys.add(key);
  for(const field of ['tendered','change_due'])if(r[field]!=null&&!Number.isFinite(Number(r[field])))return fail();
  return {...r,amount} as PaymentAttempt;
 });
}
export const isDepositRegisterRow=(r:Pick<PaymentAttempt,'payment_table'>)=>r['payment_table']==='reservation_deposits';
export function paymentEvidenceLabel(r:Pick<PaymentAttempt,'payment_table'|'method'|'manual_tender'>):string{
 if(isDepositRegisterRow(r))return 'Deposit recorded';
 if(r['method']==='cash')return 'Cash collection';
 return r['manual_tender']?'Recorded by hand':'Electronic payment';
}
export function canVerifyRegisterRow(r:Pick<PaymentAttempt,'payment_table'|'manual_tender'|'state'|'verified_at'>):boolean{
 return !isDepositRegisterRow(r)&&r['manual_tender']&&!r['verified_at']&&['confirmed','posted'].includes(r['state']);
}

