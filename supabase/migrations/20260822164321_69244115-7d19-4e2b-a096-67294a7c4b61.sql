INSERT INTO public.permissions (module, feature, action, label)
SELECT 'pos', '*', 'payments.manual-confirm', 'Manually confirm an external POS payment'
WHERE NOT EXISTS (
  SELECT 1 FROM public.permissions WHERE module='pos' AND feature='*' AND action='payments.manual-confirm'
);

INSERT INTO public.role_permissions (organization_id, role_id, permission_id, source)
SELECT DISTINCT rp.organization_id, rp.role_id, p.id, 'template'
FROM public.role_permissions rp
JOIN public.permissions vp ON vp.id = rp.permission_id
CROSS JOIN public.permissions p
WHERE vp.module='pos' AND vp.feature='*' AND vp.action='payments.verify'
  AND p.module='pos' AND p.feature='*' AND p.action='payments.manual-confirm'
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.pos_reconcile_order_settlement(_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _org uuid := public.current_org_id();
  _o public.pos_orders;
  _paid numeric := 0;
  _pending numeric := 0;
  _balance numeric;
  _open_items int;
  _closed boolean := false;
  _pay_status text;
BEGIN
  SELECT * INTO _o FROM public.pos_orders WHERE id = _order_id AND organization_id = _org FOR UPDATE;
  IF _o.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;

  SELECT coalesce(sum(amount) FILTER (WHERE status = 'confirmed'), 0),
         coalesce(sum(amount) FILTER (WHERE status IN ('initiated','pending')), 0)
    INTO _paid, _pending
    FROM public.pos_payments WHERE order_id = _order_id;

  _balance := round(coalesce(_o.grand_total, 0) - _paid, 2);

  SELECT count(*) INTO _open_items
    FROM public.pos_order_items
   WHERE order_id = _order_id AND status NOT IN ('served','cancelled','voided');

  _pay_status := CASE
    WHEN _balance <= 0.005 AND coalesce(_o.grand_total,0) > 0 THEN 'paid'
    WHEN _paid > 0 THEN 'partial'
    WHEN _pending > 0 THEN 'pending'
    ELSE 'unpaid' END;

  UPDATE public.pos_orders
     SET paid_total = _paid, payment_status = _pay_status
   WHERE id = _order_id;

  IF _balance <= 0.005 AND coalesce(_o.grand_total,0) > 0 AND _open_items = 0
     AND _o.status NOT IN ('closed','cancelled','voided','charged-to-room') THEN
    IF _o.status IN ('served','partially-served') THEN
      UPDATE public.pos_orders SET status = 'awaiting-payment' WHERE id = _order_id;
      _o.status := 'awaiting-payment';
    END IF;
    IF _o.status = 'awaiting-payment' THEN
      UPDATE public.pos_orders SET status = 'paid' WHERE id = _order_id;
      UPDATE public.pos_orders SET status = 'closed', closed_at = now() WHERE id = _order_id;
      _closed := true;
    END IF;
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
END $$;

REVOKE ALL ON FUNCTION public.pos_reconcile_order_settlement(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_reconcile_order_settlement(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.pos_record_payment_attempt(
  _order_id uuid,
  _amount numeric,
  _method text,
  _tendered numeric DEFAULT NULL,
  _reference text DEFAULT NULL,
  _shift_id uuid DEFAULT NULL,
  _idempotency_key text DEFAULT NULL,
  _manual_confirm boolean DEFAULT false,
  _note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _org uuid := public.current_org_id();
  _o public.pos_orders;
  _existing public.pos_payments;
  _balance numeric;
  _status text;
  _external boolean;
  _change numeric := 0;
  _payment uuid;
  _key text := coalesce(nullif(_idempotency_key,''), 'pos-pay:' || _order_id::text || ':' || gen_random_uuid()::text);
BEGIN
  IF NOT public.has_permission('pos','payments.process') THEN
    RAISE EXCEPTION 'Not permitted to take payments';
  END IF;

  SELECT * INTO _existing FROM public.pos_payments
   WHERE organization_id = _org AND idempotency_key = _key;
  IF _existing.id IS NOT NULL THEN
    RETURN jsonb_build_object('payment_id', _existing.id, 'status', _existing.status, 'duplicate', true)
        || public.pos_reconcile_order_settlement(_order_id);
  END IF;

  SELECT * INTO _o FROM public.pos_orders WHERE id = _order_id AND organization_id = _org FOR UPDATE;
  IF _o.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF _o.status IN ('closed','cancelled','voided','charged-to-room') THEN
    RAISE EXCEPTION 'Bill is % and cannot take further payment', _o.status;
  END IF;

  SELECT round(coalesce(_o.grand_total,0) - coalesce(sum(amount) FILTER (WHERE status='confirmed'),0), 2)
    INTO _balance FROM public.pos_payments WHERE order_id = _order_id;
  _balance := coalesce(_balance, round(coalesce(_o.grand_total,0),2));

  IF coalesce(_amount,0) <= 0 THEN RAISE EXCEPTION 'Payment amount must be greater than zero'; END IF;
  IF _amount > _balance + 0.005 THEN
    RAISE EXCEPTION 'Payment of % exceeds the outstanding balance of %', _amount, greatest(_balance,0);
  END IF;

  _external := _method IN ('mpesa','debit-card','credit-card','bank-transfer');

  IF _manual_confirm THEN
    IF NOT public.has_permission('pos','payments.manual-confirm') THEN
      RAISE EXCEPTION 'Not permitted to confirm payments manually';
    END IF;
    IF coalesce(btrim(_note),'') = '' THEN
      RAISE EXCEPTION 'A verification note is required for a manually confirmed payment';
    END IF;
    _status := 'confirmed';
  ELSE
    _status := CASE WHEN _external THEN 'pending' ELSE 'confirmed' END;
  END IF;

  IF _method = 'cash' AND _tendered IS NOT NULL THEN
    _change := greatest(0, _tendered - _amount);
  END IF;

  INSERT INTO public.pos_payments (
    organization_id, branch_id, order_id, amount, tendered, change_due, currency, method,
    external_reference, status, provider_status, paid_at, cashier_id, shift_id, customer_id,
    created_by, verified_by, verification_note, idempotency_key
  ) VALUES (
    _org, _o.branch_id, _order_id, round(_amount,2), _tendered, _change, _o.currency, _method,
    nullif(_reference,''), _status,
    CASE WHEN _manual_confirm THEN 'manual-confirmed' WHEN _external THEN 'awaiting-provider' ELSE NULL END,
    CASE WHEN _status = 'confirmed' THEN now() ELSE NULL END,
    auth.uid(), _shift_id, _o.customer_id, auth.uid(),
    CASE WHEN _manual_confirm THEN auth.uid() ELSE NULL END,
    nullif(btrim(coalesce(_note,'')),''), _key
  ) RETURNING id INTO _payment;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, action, module, record_id, new_value)
  VALUES (_org, _o.branch_id, auth.uid(), 'pos.payment.record', 'pos', _order_id,
          jsonb_build_object('paymentId', _payment, 'amount', round(_amount,2), 'method', _method,
                             'status', _status, 'manualConfirm', _manual_confirm));

  RETURN jsonb_build_object('payment_id', _payment, 'status', _status, 'duplicate', false)
      || public.pos_reconcile_order_settlement(_order_id);
END $$;

REVOKE ALL ON FUNCTION public.pos_record_payment_attempt(uuid,numeric,text,numeric,text,uuid,text,boolean,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_record_payment_attempt(uuid,numeric,text,numeric,text,uuid,text,boolean,text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.pos_confirm_manual_payment(_payment_id uuid, _note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE _org uuid := public.current_org_id(); _p public.pos_payments; _bal numeric;
BEGIN
  IF NOT public.has_permission('pos','payments.manual-confirm') THEN
    RAISE EXCEPTION 'Not permitted to confirm payments manually';
  END IF;
  IF coalesce(btrim(_note),'') = '' THEN
    RAISE EXCEPTION 'A verification note is required for a manually confirmed payment';
  END IF;

  SELECT * INTO _p FROM public.pos_payments
   WHERE id = _payment_id AND organization_id = _org FOR UPDATE;
  IF _p.id IS NULL THEN RAISE EXCEPTION 'Payment not found'; END IF;
  IF _p.status = 'confirmed' THEN
    RETURN jsonb_build_object('payment_id', _p.id, 'status', 'confirmed', 'duplicate', true)
        || public.pos_reconcile_order_settlement(_p.order_id);
  END IF;
  IF _p.status NOT IN ('initiated','pending') THEN
    RAISE EXCEPTION 'Payment is % and cannot be confirmed', _p.status;
  END IF;

  SELECT round(coalesce(o.grand_total,0)
              - coalesce((SELECT sum(amount) FROM public.pos_payments x
                           WHERE x.order_id = _p.order_id AND x.status='confirmed'),0), 2)
    INTO _bal FROM public.pos_orders o WHERE o.id = _p.order_id;
  IF _p.amount > _bal + 0.005 THEN
    RAISE EXCEPTION 'Confirming % would exceed the outstanding balance of %', _p.amount, greatest(_bal,0);
  END IF;

  UPDATE public.pos_payments
     SET status = 'confirmed', provider_status = 'manual-confirmed', paid_at = now(),
         verified_by = auth.uid(), verification_note = btrim(_note)
   WHERE id = _payment_id;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, action, module, record_id, new_value)
  VALUES (_org, _p.branch_id, auth.uid(), 'pos.payment.manual_confirm', 'pos', _p.order_id,
          jsonb_build_object('paymentId', _p.id, 'amount', _p.amount, 'method', _p.method, 'note', btrim(_note)));

  RETURN jsonb_build_object('payment_id', _p.id, 'status', 'confirmed', 'duplicate', false)
      || public.pos_reconcile_order_settlement(_p.order_id);
END $$;

REVOKE ALL ON FUNCTION public.pos_confirm_manual_payment(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_confirm_manual_payment(uuid,text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_menu_catalogue(_branch uuid DEFAULT NULL)
RETURNS TABLE(
  id uuid, name text, sku text, category_id uuid, category_name text, menu_name text,
  base_price numeric, tax_rate numeric, availability text, publish_status text,
  branch_id uuid, station_id uuid, station_name text, station_source text, station_missing boolean,
  assigned_station_id uuid, import_batch_id uuid, published_at timestamptz, updated_at timestamptz
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE _org uuid := public.current_org_id();
BEGIN
  IF _org IS NULL THEN RETURN; END IF;
  IF NOT public.has_permission('pos','menu.view') THEN
    RAISE EXCEPTION 'Not permitted to view the menu catalogue';
  END IF;

  RETURN QUERY
  WITH src AS (
    SELECT mi.*, mc.name AS cat_name, m.name AS menu_nm,
           public.neo_kitchen_resolve_station(_org, coalesce(mi.branch_id, _branch), mi.id, mi.category_id, NULL, NULL) AS res
      FROM public.menu_items mi
      LEFT JOIN public.menu_categories mc ON mc.id = mi.category_id
      LEFT JOIN public.menus m ON m.id = mc.menu_id
     WHERE mi.organization_id = _org
       AND mi.publish_status = 'published'
       AND (_branch IS NULL OR mi.branch_id IS NULL OR mi.branch_id = _branch)
       AND (mi.branch_id IS NULL OR mi.branch_id = ANY(public.current_branch_ids()))
  )
  SELECT r.id, r.name, r.sku, r.category_id, r.cat_name, r.menu_nm,
         r.base_price, r.tax_rate, r.availability, r.publish_status,
         r.branch_id,
         nullif(r.res->>'station_id','')::uuid,
         st.name,
         r.res->>'source',
         (r.res->>'missing')::boolean,
         r.station_id,
         r.import_batch_id, r.published_at, r.updated_at
    FROM src r
    LEFT JOIN public.operational_stations st ON st.id = nullif(r.res->>'station_id','')::uuid
   ORDER BY r.cat_name NULLS LAST, r.name;
END $$;

REVOKE ALL ON FUNCTION public.neo_menu_catalogue(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_menu_catalogue(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_menu_assign_station(_item_id uuid, _station_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE _org uuid := public.current_org_id(); _item public.menu_items;
BEGIN
  IF NOT public.has_permission('pos','menu.manage') THEN
    RAISE EXCEPTION 'Not permitted to manage the menu';
  END IF;
  SELECT * INTO _item FROM public.menu_items WHERE id = _item_id AND organization_id = _org;
  IF _item.id IS NULL THEN RAISE EXCEPTION 'Menu item not found'; END IF;

  IF _station_id IS NOT NULL AND NOT public.neo_station_is_usable(_org, _item.branch_id, _station_id) THEN
    RAISE EXCEPTION 'That production station is not usable for this item';
  END IF;

  UPDATE public.menu_items SET station_id = _station_id, updated_at = now() WHERE id = _item_id;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, action, module, record_id, previous_value, new_value)
  VALUES (_org, _item.branch_id, auth.uid(), 'pos.menu.assign_station', 'pos', _item_id,
          jsonb_build_object('stationId', _item.station_id),
          jsonb_build_object('stationId', _station_id));

  RETURN jsonb_build_object('item_id', _item_id, 'station_id', _station_id);
END $$;

REVOKE ALL ON FUNCTION public.neo_menu_assign_station(uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_menu_assign_station(uuid,uuid) TO authenticated, service_role;

UPDATE public.menu_import_batches b
   SET status = 'superseded',
       committed_rows = 0,
       duplicate_rows = 77,
       errors = coalesce(b.errors,'[]'::jsonb) || jsonb_build_array(jsonb_build_object(
         'code','duplicate-batch',
         'message','Re-import of the same file; all 77 items were already committed by batch 684f84f1-27d9-4d10-8dcd-24494b324f95.'))
 WHERE b.id = '0d13c24a-4471-4030-9440-342f39d26864'
   AND NOT EXISTS (SELECT 1 FROM public.menu_items mi WHERE mi.import_batch_id = b.id);
