-- Align the room-charge lifecycle with the canonical production-send flow.
-- 'Charge to room' is itself a settlement path for an open bill: after the fix
-- that lets a draft order be sent to production, an unpaid bill legitimately
-- sits in a production state ('sent' .. 'ready') when staff choose to charge it
-- to the guest's room. The old guard only accepted 'served'-family states, so
-- it raised 'Bill is not finalised for posting'.

-- 1. Rulebook: a bill under production can step to the canonical pre-settlement
--    state. This is the same step the cash path uses; it is not a new flow.
CREATE OR REPLACE FUNCTION public.neo_pos_status_rules()
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'draft', jsonb_build_array('held','confirmed','sent','cancelled'),
    'held', jsonb_build_array('draft','confirmed','cancelled'),
    'confirmed', jsonb_build_array('sent','cancelled'),
    'sent', jsonb_build_array('accepted','in-preparation','partially-ready','ready','awaiting-payment','cancelled','void-pending'),
    'accepted', jsonb_build_array('in-preparation','partially-ready','ready','awaiting-payment','void-pending'),
    'in-preparation', jsonb_build_array('partially-ready','ready','awaiting-payment','void-pending'),
    'partially-ready', jsonb_build_array('ready','partially-served','awaiting-payment','void-pending'),
    'ready', jsonb_build_array('partially-served','served','awaiting-payment','void-pending'),
    'partially-served', jsonb_build_array('served','awaiting-payment','void-pending'),
    'served', jsonb_build_array('awaiting-payment','void-pending'),
    'awaiting-payment', jsonb_build_array('paid','charged-to-room','credit','void-pending'),
    'paid', jsonb_build_array('closed','void-pending'),
    'charged-to-room', jsonb_build_array('closed','void-pending'),
    'credit', jsonb_build_array('closed','void-pending'),
    'closed', jsonb_build_array('awaiting-payment'),
    'void-pending', jsonb_build_array('voided','served','awaiting-payment')
  );
$function$;

-- 2. Room charge: accept any post-production, pre-settlement state and always
--    step through 'awaiting-payment', exactly like the cash path. Draft, held,
--    confirmed, cancelled, voided and closed bills stay rejected. Every other
--    check (permission, org, open folio, idempotency, exactly-once posting via
--    folio_post_charge) is untouched.
CREATE OR REPLACE FUNCTION public.pos_post_room_charge(_order_id uuid, _folio_id uuid, _idempotency_key text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _order public.pos_orders;
  _folio public.folios;
  _line uuid;
  _prior text;
BEGIN
  IF NOT public.has_permission('pos','room_charge.post') THEN
    RAISE EXCEPTION 'Not permitted to post room charges';
  END IF;
  SELECT * INTO _order FROM public.pos_orders WHERE id = _order_id AND organization_id = _org;
  IF _order.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF _order.folio_post_status = 'posted' THEN RAISE EXCEPTION 'Order already posted to a folio'; END IF;
  IF _order.status NOT IN ('sent','accepted','in-preparation','partially-ready','ready',
                           'partially-served','served','awaiting-payment') THEN
    RAISE EXCEPTION 'Bill % cannot be charged to a room from status "%": send it to production first',
      _order.order_number, _order.status;
  END IF;

  SELECT * INTO _folio FROM public.folios WHERE id = _folio_id AND organization_id = _org;
  IF _folio.id IS NULL THEN RAISE EXCEPTION 'Folio not found'; END IF;
  IF _folio.status <> 'open' THEN RAISE EXCEPTION 'Folio is not open'; END IF;

  IF EXISTS (SELECT 1 FROM public.folio_lines WHERE organization_id = _org AND idempotency_key = _idempotency_key) THEN
    RAISE EXCEPTION 'Duplicate room charge blocked';
  END IF;

  -- Post through the canonical folio charge routine so the folio totals and
  -- balance move with the line, and so the charge reaches Finance the same way
  -- every other folio charge does. A raw INSERT here left folio balances stale.
  _prior := COALESCE(current_setting('neo.system_posting', true), 'off');
  PERFORM set_config('neo.system_posting', 'on', true);
  _line := public.folio_post_charge(
    _folio_id, 'food-beverage',
    'POS ' || _order.order_number || ' (' || _order.order_type || ')',
    1, _order.subtotal, _order.tax_total, _order.service_charge_total, _order.discount_total,
    'pos', _order_id, 'fnb', _idempotency_key, NULL);

  -- Settlement always passes through 'awaiting-payment', exactly like the cash
  -- path in pos_reconcile_settlement_internal.
  IF _order.status <> 'awaiting-payment' THEN
    UPDATE public.pos_orders SET status = 'awaiting-payment' WHERE id = _order_id;
  END IF;

  UPDATE public.pos_orders
     SET folio_post_status = 'posted', folio_id = _folio_id, payment_status = 'paid',
         status = 'charged-to-room', closed_at = now()
   WHERE id = _order_id;
  PERFORM set_config('neo.system_posting', _prior, true);

  PERFORM public.emit_domain_event(_org, _order.branch_id, 'pos.room_charge.posted', 'pos', _order_id,
    jsonb_build_object('orderId', _order_id, 'folioId', _folio_id, 'amount', _order.grand_total),
    _idempotency_key, _order.customer_id);

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, action, module, record_id, new_value)
  VALUES (_org, _order.branch_id, auth.uid(), 'pos.room_charge.post', 'pos', _order_id,
          jsonb_build_object('folioId', _folio_id, 'amount', _order.grand_total));

  RETURN _line;
END; $function$;