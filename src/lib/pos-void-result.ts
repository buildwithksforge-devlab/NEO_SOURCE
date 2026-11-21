/** A void is complete only when the server confirms its saved request and effect. */
export function requireVoidResult(value: unknown, expected: { requestId?: string; orderId?: string; approve?: boolean }) {
  const r = value as { ok?: boolean; request_id?: string; order_id?: string; status?: string; item_status?: string } | null;
  if (!r?.ok || !r.request_id || !r.order_id ||
      (expected.requestId && r.request_id !== expected.requestId) ||
      (expected.orderId && r.order_id !== expected.orderId) ||
      (expected.approve === undefined ? r.status !== 'pending' :
        expected.approve ? r.status !== 'applied' || r.item_status !== 'voided' : r.status !== 'rejected')) {
    throw new Error('The saved void result could not be verified. Refresh before trying again.');
  }
  return r;
}
