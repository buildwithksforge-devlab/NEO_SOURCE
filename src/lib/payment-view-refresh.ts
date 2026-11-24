export const PAYMENT_VIEW_KEYS=['pms','finance','payment-register','folio-projection','payment-lifecycle','payment-audit-trail','cash','financial-lifecycle','financial-states','finance-posting','neo-facts','folio-trace','commitments','credit','crm-credit-line','crm-digital-summary'] as const;
/** Refresh every view of persisted financial work. Inactive views are marked stale, not fetched. */
export function invalidatePaymentViews(cache:{invalidateQueries:(filters:{queryKey:readonly unknown[]})=>unknown}):Promise<void>{
 return Promise.all(PAYMENT_VIEW_KEYS.map(key=>cache.invalidateQueries({queryKey:[key]}))).then(()=>undefined);
}
