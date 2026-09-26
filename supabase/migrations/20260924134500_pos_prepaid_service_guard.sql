-- Preserve legitimate pay-first POS workflows without letting payment pretend that
-- service is complete or deduct stock early. Item/service lifecycle remains the
-- operational truth; payment_status may be paid while items are still open.

CREATE OR REPLACE FUNCTION public.neo_pos_lifecycle_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _open_items int := 0;
BEGIN
  IF current_setting('neo.payment_maintenance', true) = 'on' THEN RETURN NEW; END IF;

  IF NEW.status IN ('draft','cancelled','voided','void')
     AND coalesce(NEW.payment_status,'unpaid') IN ('paid','partial','partially_paid') THEN
    RAISE EXCEPTION 'A % order cannot be marked as %. Settle the order from the POS instead.',
      NEW.status, NEW.payment_status USING ERRCODE = '23514';
  END IF;

  IF NEW.status IN ('draft','cancelled','voided','void')
     AND coalesce(NEW.paid_total,0) > 0 THEN
    RAISE EXCEPTION 'A % order cannot carry a paid amount. Reverse the payment first.', NEW.status
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status IN ('paid','closed','completed','settled') THEN
    SELECT count(*) INTO _open_items
      FROM public.pos_order_items i
     WHERE i.order_id = NEW.id
       AND coalesce(i.status,'draft') NOT IN ('served','completed','cancelled','voided');

    IF _open_items > 0 THEN
      RAISE EXCEPTION 'This order still has % open item(s). Payment may be complete, but service must finish before the order can be %.',
        _open_items, NEW.status USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.status IN ('closed','completed','settled')
     AND coalesce(NEW.payment_status,'unpaid') NOT IN ('paid','settled','complimentary','transferred','charged_to_room')
     AND coalesce(NEW.grand_total,0) > 0 THEN
    RAISE EXCEPTION 'This order cannot be closed while its payment is %.', NEW.payment_status
      USING ERRCODE = '23514';
  END IF;

  -- A fully paid order may legitimately remain sent/ready/served while the
  -- kitchen or bar finishes service. The terminal item trigger reconciles and
  -- closes it only when all items are served/cancelled/voided.
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.pos_reconcile_settlement_internal(_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _o public.pos_orders;
  _paid numeric := 0;
  _pending numeric := 0;
  _balance numeric;
  _open_items int;
  _closed boolean := false;
  _pay_status text;
  _settleable boolean;
BEGIN
  SELECT * INTO _o FROM public.pos_orders WHERE id = _order_id FOR UPDATE;
  IF _o.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;

  SELECT coalesce(sum(amount) FILTER (WHERE status = 'confirmed'), 0),
         coalesce(sum(amount) FILTER (WHERE status IN ('initiated','pending')), 0)
    INTO _paid, _pending
    FROM public.pos_payments WHERE order_id = _order_id;

  _balance := round(coalesce(_o.grand_total, 0) - _paid, 2);

  SELECT count(*) INTO _open_items
    FROM public.pos_order_items
   WHERE order_id = _order_id AND status NOT IN ('served','completed','cancelled','voided');

  _pay_status := CASE
    WHEN _balance <= 0.005 AND coalesce(_o.grand_total,0) > 0 THEN 'paid'
    WHEN _paid > 0 THEN 'partial'
    WHEN _pending > 0 THEN 'pending'
    ELSE 'unpaid' END;

  _settleable := _balance <= 0.005 AND coalesce(_o.grand_total,0) > 0 AND _open_items = 0
                 AND _o.status NOT IN ('closed','cancelled','voided','charged-to-room','credit');

  IF _settleable THEN
    IF _o.status IN ('served','partially-served') THEN
      UPDATE public.pos_orders SET status = 'awaiting-payment' WHERE id = _order_id;
      _o.status := 'awaiting-payment';
    END IF;

    IF _o.status = 'awaiting-payment' THEN
      UPDATE public.pos_orders
         SET status = 'paid', paid_total = _paid, payment_status = _pay_status
       WHERE id = _order_id;
      UPDATE public.pos_orders SET status = 'closed', closed_at = now() WHERE id = _order_id;
      _closed := true;
    ELSIF _o.status = 'paid' THEN
      -- Recovery-compatible path for a bill that was paid before service under
      -- an older deployment. Once its final item becomes terminal, close it in
      -- place; do not recreate the transaction or its receipt/journal.
      UPDATE public.pos_orders
         SET paid_total = _paid, payment_status = _pay_status
       WHERE id = _order_id;
      UPDATE public.pos_orders SET status = 'closed', closed_at = coalesce(closed_at, now())
       WHERE id = _order_id;
      _closed := true;
    ELSE
      UPDATE public.pos_orders
         SET paid_total = _paid, payment_status = _pay_status
       WHERE id = _order_id
         AND (paid_total IS DISTINCT FROM _paid OR payment_status IS DISTINCT FROM _pay_status);
    END IF;
  ELSE
    -- Prepayment is allowed: keep the operational service state while recording
    -- the financial truth. Do not force the order to paid/closed while items remain open.
    UPDATE public.pos_orders
       SET paid_total = _paid, payment_status = _pay_status
     WHERE id = _order_id
       AND (paid_total IS DISTINCT FROM _paid OR payment_status IS DISTINCT FROM _pay_status);
  END IF;

  RETURN jsonb_build_object(
    'order_id', _order_id,
    'grand_total', coalesce(_o.grand_total,0),
    'paid_total', _paid,
    'pending_total', _pending,
    'balance', greatest(_balance, 0),
    'payment_status', _pay_status,
    'open_items', _open_items,
    'closed', _closed
  );
END
$function$;

REVOKE ALL ON FUNCTION public.pos_reconcile_settlement_internal(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pos_reconcile_settlement_internal(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.inventory_order_consumption_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE r record; v_err text;
BEGIN
  -- Item-level served/completed transitions are the primary consumption path.
  -- Order-level posting is only an idempotent catch-up when the whole order is
  -- actually terminal; payment alone must never deduct kitchen/bar stock.
  IF lower(COALESCE(NEW.status,'')) NOT IN ('completed','closed') THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND lower(COALESCE(OLD.status,'')) = lower(COALESCE(NEW.status,'')) THEN RETURN NEW; END IF;

  FOR r IN SELECT id FROM public.pos_order_items
            WHERE order_id = NEW.id AND COALESCE(status,'') NOT IN ('voided','cancelled') LOOP
    BEGIN
      PERFORM public.inventory_consume_order_item(r.id);
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
      BEGIN
        INSERT INTO public.inventory_posting_events (organization_id, branch_id, order_id, order_item_id,
          posting_type, idempotency_key, status, payload)
        VALUES (NEW.organization_id, NEW.branch_id, NEW.id, r.id, 'consumption',
          'error:' || r.id::text, 'failed',
          jsonb_build_object('reason','consumption-failed','detail', v_err))
        ON CONFLICT DO NOTHING;

        INSERT INTO public.audit_logs (organization_id, branch_id, user_name, action, module, record_id, new_value, reason)
        VALUES (NEW.organization_id, NEW.branch_id, COALESCE(auth.uid()::text,'system'),
          'stock.consumption.failed', 'inventory', r.id::text,
          jsonb_build_object('order_id', NEW.id, 'detail', v_err),
          'Stock could not be deducted for this sold item');
      EXCEPTION WHEN OTHERS THEN NULL;
      END;
    END;
  END LOOP;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.inventory_order_consumption_trigger() FROM PUBLIC, anon, authenticated;
