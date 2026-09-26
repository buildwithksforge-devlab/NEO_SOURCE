-- ==================================================================
-- A. DELIVERY — server-side dispatch eligibility + transactional assignment
-- ==================================================================
CREATE OR REPLACE FUNCTION public.neo_delivery_dispatch_candidates(_order uuid)
RETURNS TABLE(
  rider_id uuid, rider_code text, display_name text, vehicle_type text,
  availability_status text, active_load integer, max_active integer,
  on_shift boolean, next_shift timestamptz, delivered_today integer,
  cash_handling_allowed boolean, eligible boolean, reasons text[]
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _o public.delivery_orders; _cash boolean;
BEGIN
  IF _org IS NULL THEN RETURN; END IF;
  IF NOT (public.has_permission('delivery','dispatch.assign')
          OR public.has_permission('delivery','riders.manage')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _o FROM public.delivery_orders WHERE id = _order AND organization_id = _org;
  IF _o.id IS NULL THEN RETURN; END IF;
  IF NOT public.neo_branch_in_scope(_o.branch_id) THEN
    RAISE EXCEPTION 'That order is outside your access scope.' USING ERRCODE = '42501';
  END IF;

  _cash := coalesce(_o.payment_method,'') IN ('cash','cash-on-delivery','cod')
           AND coalesce(_o.payment_status,'') <> 'paid';

  RETURN QUERY
  WITH base AS (
    SELECT r.*,
      (SELECT count(*) FROM public.delivery_orders o
        WHERE o.rider_id = r.id
          AND o.order_status NOT IN ('delivered','cancelled','rejected','failed'))::int AS load,
      EXISTS (SELECT 1 FROM public.rider_shifts s
               WHERE s.rider_id = r.id AND s.status IN ('scheduled','active')
                 AND now() BETWEEN s.starts_at AND s.ends_at) AS shift_now,
      (SELECT min(s.starts_at) FROM public.rider_shifts s
        WHERE s.rider_id = r.id AND s.status = 'scheduled' AND s.starts_at > now()) AS next_start,
      (SELECT count(*) FROM public.delivery_orders o
        WHERE o.rider_id = r.id AND o.delivered_at >= date_trunc('day', now()))::int AS today,
      EXISTS (SELECT 1 FROM public.profiles p
               WHERE p.id = r.profile_id AND coalesce(p.is_active, true)) AS account_live
    FROM public.rider_profiles r
    WHERE r.organization_id = _org
  ), judged AS (
    SELECT b.*, (
      ARRAY[]::text[]
      || CASE WHEN b.active IS NOT TRUE THEN ARRAY['Retired from the roster'] ELSE '{}'::text[] END
      || CASE WHEN b.profile_id IS NULL THEN ARRAY['No linked staff account'] ELSE '{}'::text[] END
      || CASE WHEN b.profile_id IS NOT NULL AND NOT b.account_live
              THEN ARRAY['Staff account is inactive'] ELSE '{}'::text[] END
      || CASE WHEN b.branch_id IS NOT NULL AND _o.branch_id IS NOT NULL AND b.branch_id <> _o.branch_id
              THEN ARRAY['Assigned to a different property'] ELSE '{}'::text[] END
      || CASE WHEN NOT b.shift_now THEN ARRAY['Not on an active shift'] ELSE '{}'::text[] END
      || CASE WHEN coalesce(b.availability_status,'offline') <> 'available'
              THEN ARRAY['Rider is ' || coalesce(b.availability_status,'offline')] ELSE '{}'::text[] END
      || CASE WHEN b.load >= coalesce(b.max_active_deliveries, 3)
              THEN ARRAY['At the active delivery ceiling'] ELSE '{}'::text[] END
      || CASE WHEN _cash AND b.cash_handling_allowed IS NOT TRUE
              THEN ARRAY['Not cleared to carry cash'] ELSE '{}'::text[] END
    ) AS why
    FROM base b
  )
  SELECT j.id, j.rider_code, j.display_name, j.vehicle_type, j.availability_status,
         j.load, coalesce(j.max_active_deliveries, 3), j.shift_now, j.next_start, j.today,
         j.cash_handling_allowed, cardinality(j.why) = 0, j.why
    FROM judged j
   WHERE public.neo_branch_in_scope(j.branch_id)
   ORDER BY cardinality(j.why), j.load, j.display_name;
END $function$;

CREATE OR REPLACE FUNCTION public.neo_delivery_assign(
  _order uuid, _rider uuid, _reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _o public.delivery_orders; _new public.rider_profiles; _prev public.rider_profiles;
  _cand record; _found boolean := false; _reason_clean text := nullif(btrim(coalesce(_reason,'')),'');
BEGIN
  IF _org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.has_permission('delivery','dispatch.assign') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'The delivery.dispatch.assign permission is required.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _o FROM public.delivery_orders
   WHERE id = _order AND organization_id = _org FOR UPDATE;
  IF _o.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'order_not_found'); END IF;
  IF NOT public.neo_branch_in_scope(_o.branch_id) THEN
    RAISE EXCEPTION 'That order is outside your access scope.' USING ERRCODE = '42501';
  END IF;
  IF _o.order_status IN ('delivered','cancelled','rejected','failed') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'order_closed',
      'detail', 'That order is already ' || _o.order_status || '.');
  END IF;
  IF _o.rider_id = _rider THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_assigned',
      'detail', 'That rider already holds this order.');
  END IF;
  IF _o.rider_id IS NOT NULL AND _reason_clean IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'reason_required',
      'detail', 'Reassigning an order requires a written reason.');
  END IF;

  FOR _cand IN SELECT * FROM public.neo_delivery_dispatch_candidates(_order) c WHERE c.rider_id = _rider LOOP
    _found := true;
    IF _cand.eligible IS NOT TRUE THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'rider_ineligible',
        'detail', array_to_string(_cand.reasons, '; '), 'reasons', to_jsonb(_cand.reasons));
    END IF;
  END LOOP;
  IF NOT _found THEN RETURN jsonb_build_object('ok', false, 'reason', 'rider_not_found'); END IF;

  SELECT * INTO _new FROM public.rider_profiles WHERE id = _rider;
  IF _o.rider_id IS NOT NULL THEN
    SELECT * INTO _prev FROM public.rider_profiles WHERE id = _o.rider_id;
  END IF;

  UPDATE public.delivery_orders
     SET rider_id = _rider, dispatch_status = 'assigned', updated_at = now()
   WHERE id = _order;

  INSERT INTO public.delivery_order_status_history
    (organization_id, delivery_order_id, status_kind, previous_status, new_status, reason, changed_by)
  VALUES (_org, _order, 'dispatch', coalesce(_prev.display_name, 'unassigned'),
          coalesce(_new.display_name, 'rider'), _reason_clean, auth.uid());

  INSERT INTO public.notifications
    (organization_id, branch_id, user_id, category, title, body, link, priority,
     source_module, source_record_id, event_type, idempotency_key)
  VALUES (_org, _o.branch_id, _new.profile_id, 'operations',
    'Delivery assigned to you',
    _o.order_number || coalesce(' · ' || _o.contact_name, '') ||
      coalesce(' · reassigned: ' || _reason_clean, ''),
    '/delivery', 'high', 'delivery', _order, 'delivery.assigned',
    'delivery.assign:' || _order::text || ':' || _rider::text)
  ON CONFLICT DO NOTHING;

  IF _prev.profile_id IS NOT NULL THEN
    INSERT INTO public.notifications
      (organization_id, branch_id, user_id, category, title, body, link,
       source_module, source_record_id, event_type, idempotency_key)
    VALUES (_org, _o.branch_id, _prev.profile_id, 'operations',
      'Delivery reassigned',
      _o.order_number || ' is now with ' || coalesce(_new.display_name,'another rider') ||
        coalesce(' — ' || _reason_clean, ''),
      '/delivery', 'delivery', _order, 'delivery.reassigned',
      'delivery.unassign:' || _order::text || ':' || _prev.id::text || ':' || _rider::text)
    ON CONFLICT DO NOTHING;
  END IF;

  INSERT INTO public.audit_logs
    (organization_id, user_id, user_name, action, module, record_id, previous_value, new_value, reason)
  VALUES (_org, auth.uid(), '',
    CASE WHEN _prev.id IS NULL THEN 'delivery.dispatch.assign' ELSE 'delivery.dispatch.reassign' END,
    'delivery', _order::text,
    jsonb_build_object('rider_id', _prev.id, 'rider', _prev.display_name),
    jsonb_build_object('rider_id', _rider, 'rider', _new.display_name),
    _reason_clean);

  RETURN jsonb_build_object('ok', true, 'order_id', _order, 'rider_id', _rider,
    'previous_rider_id', _prev.id, 'reassigned', _prev.id IS NOT NULL);
END $function$;

CREATE OR REPLACE FUNCTION public.neo_delivery_rider_audit(_rider uuid, _limit integer DEFAULT 100)
RETURNS TABLE(created_at timestamptz, action text, order_number text, detail text, actor uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id();
BEGIN
  IF _org IS NULL THEN RETURN; END IF;
  IF NOT (public.has_permission('delivery','dispatch.view')
          OR public.has_permission('delivery','riders.manage')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT h.created_at,
         ('order.' || coalesce(h.new_status, h.status_kind, 'update'))::text,
         o.order_number,
         coalesce(h.reason, coalesce(h.previous_status,'—') || ' → ' || coalesce(h.new_status,'—'))::text,
         h.changed_by
    FROM public.delivery_order_status_history h
    JOIN public.delivery_orders o ON o.id = h.delivery_order_id
   WHERE o.organization_id = _org AND o.rider_id = _rider
     AND public.neo_branch_in_scope(o.branch_id)
  UNION ALL
  SELECT s.updated_at, ('shift.' || s.status)::text, NULL::text,
         (to_char(s.starts_at,'DD Mon HH24:MI') || ' → ' || to_char(s.ends_at,'DD Mon HH24:MI')
           || coalesce(' · ' || s.cancelled_reason, ''))::text,
         s.created_by
    FROM public.rider_shifts s
   WHERE s.organization_id = _org AND s.rider_id = _rider
     AND public.neo_branch_in_scope(s.branch_id)
  UNION ALL
  SELECT a.created_at, a.action::text, NULL::text,
         coalesce(a.reason, a.new_value::text)::text, a.user_id
    FROM public.audit_logs a
   WHERE a.organization_id = _org
     AND (a.action LIKE 'delivery.rider.%' OR a.action LIKE 'delivery.dispatch.%')
     AND (a.record_id = _rider::text OR a.new_value->>'rider_id' = _rider::text
          OR a.previous_value->>'rider_id' = _rider::text)
  ORDER BY 1 DESC
  LIMIT greatest(coalesce(_limit, 100), 1);
END $function$;

DROP FUNCTION IF EXISTS public.neo_delivery_rider_performance(uuid, date, date);
CREATE OR REPLACE FUNCTION public.neo_delivery_rider_performance(
  _branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL
) RETURNS TABLE(
  rider_id uuid, rider_code text, display_name text,
  assigned integer, delivered integer, failed integer, active_orders integer,
  avg_delivery_minutes numeric, avg_assignment_minutes numeric, on_time_rate numeric,
  cash_collected numeric, scheduled_hours numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id();
  _f timestamptz := coalesce(_from, (now() - interval '30 days')::date)::timestamptz;
  _t timestamptz := (coalesce(_to, now()::date) + 1)::timestamptz;
BEGIN
  IF _org IS NULL THEN RETURN; END IF;
  IF NOT (public.has_permission('delivery','dispatch.view')
          OR public.has_permission('delivery','riders.manage')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT r.id, r.rider_code, r.display_name,
    count(o.id)::int,
    count(o.id) FILTER (WHERE o.order_status = 'delivered')::int,
    count(o.id) FILTER (WHERE o.order_status IN ('failed','rejected','cancelled'))::int,
    (SELECT count(*) FROM public.delivery_orders a
      WHERE a.rider_id = r.id
        AND a.order_status NOT IN ('delivered','cancelled','rejected','failed'))::int,
    round(avg(extract(epoch FROM (o.delivered_at - coalesce(o.collected_at, o.ready_at))) / 60.0)
          FILTER (WHERE o.delivered_at IS NOT NULL), 1),
    round(avg(extract(epoch FROM (o.delivered_at - coalesce(o.accepted_at, o.requested_at, o.created_at))) / 60.0)
          FILTER (WHERE o.delivered_at IS NOT NULL), 1),
    round(
      100.0 * count(o.id) FILTER (
        WHERE o.delivered_at IS NOT NULL AND o.estimated_delivery_at IS NOT NULL
          AND o.delivered_at <= o.estimated_delivery_at)::numeric
      / nullif(count(o.id) FILTER (WHERE o.delivered_at IS NOT NULL AND o.estimated_delivery_at IS NOT NULL), 0), 1),
    coalesce(sum(o.grand_total) FILTER (
      WHERE o.order_status = 'delivered' AND o.payment_method IN ('cash','cash-on-delivery','cod')), 0),
    coalesce((
      SELECT round(sum(extract(epoch FROM (least(s.ends_at, _t) - greatest(s.starts_at, _f))) / 3600.0)::numeric, 1)
        FROM public.rider_shifts s
       WHERE s.rider_id = r.id AND s.status <> 'cancelled'
         AND s.starts_at < _t AND s.ends_at > _f), 0)
  FROM public.rider_profiles r
  LEFT JOIN public.delivery_orders o
    ON o.rider_id = r.id AND o.created_at >= _f AND o.created_at < _t
   AND (_branch IS NULL OR o.branch_id = _branch)
  WHERE r.organization_id = _org
    AND (_branch IS NULL OR r.branch_id IS NULL OR r.branch_id = _branch)
    AND public.neo_branch_in_scope(r.branch_id)
  GROUP BY r.id, r.rider_code, r.display_name
  ORDER BY r.display_name;
END $function$;

-- ==================================================================
-- B. POS → KDS integrity
-- ==================================================================
CREATE UNIQUE INDEX IF NOT EXISTS station_ticket_items_single_live_source
  ON public.station_ticket_items (organization_id, order_item_id)
  WHERE remake_of_id IS NULL;

CREATE OR REPLACE FUNCTION public.neo_pos_kds_reconciliation(_branch uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _missing jsonb; _orphan jsonb; _dupes jsonb; _unrouted jsonb;
BEGIN
  IF _org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.has_permission('kitchen','queue.view')
          OR public.has_permission('restaurant','orders.view')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(jsonb_agg(x), '[]'::jsonb) INTO _missing FROM (
    SELECT jsonb_build_object('order_item_id', i.id, 'item_name', i.item_name,
             'order_id', i.order_id, 'sent_at', i.sent_at) AS x
      FROM public.pos_order_items i
      JOIN public.pos_orders o ON o.id = i.order_id
     WHERE i.organization_id = _org
       AND (_branch IS NULL OR o.branch_id = _branch)
       AND public.neo_branch_in_scope(o.branch_id)
       AND i.sent_at IS NOT NULL
       AND coalesce(i.status,'') NOT IN ('cancelled','voided')
       AND o.created_at > now() - interval '7 days'
       AND NOT EXISTS (SELECT 1 FROM public.station_ticket_items t WHERE t.order_item_id = i.id)
     LIMIT 200) m;

  SELECT coalesce(jsonb_agg(y), '[]'::jsonb) INTO _orphan FROM (
    SELECT jsonb_build_object('ticket_item_id', t.id, 'ticket_id', t.ticket_id) AS y
      FROM public.station_ticket_items t
      LEFT JOIN public.pos_order_items i ON i.id = t.order_item_id
     WHERE t.organization_id = _org AND i.id IS NULL
     LIMIT 200) o2;

  SELECT coalesce(jsonb_agg(z), '[]'::jsonb) INTO _dupes FROM (
    SELECT jsonb_build_object('order_item_id', t.order_item_id, 'tickets', count(*)) AS z
      FROM public.station_ticket_items t
     WHERE t.organization_id = _org AND t.remake_of_id IS NULL
     GROUP BY t.order_item_id HAVING count(*) > 1
     LIMIT 200) d;

  SELECT coalesce(jsonb_agg(w), '[]'::jsonb) INTO _unrouted FROM (
    SELECT jsonb_build_object('order_item_id', i.id, 'item_name', i.item_name,
             'order_id', i.order_id) AS w
      FROM public.pos_order_items i
      JOIN public.pos_orders o ON o.id = i.order_id
     WHERE i.organization_id = _org
       AND (_branch IS NULL OR o.branch_id = _branch)
       AND public.neo_branch_in_scope(o.branch_id)
       AND i.station_id IS NULL AND i.sent_at IS NOT NULL
       AND o.created_at > now() - interval '7 days'
     LIMIT 200) u;

  RETURN jsonb_build_object(
    'ok', true, 'generated_at', now(),
    'missing_tickets', _missing, 'orphan_ticket_items', _orphan,
    'duplicate_sources', _dupes, 'unassigned_station', _unrouted,
    'healthy', jsonb_array_length(_missing) = 0 AND jsonb_array_length(_orphan) = 0
               AND jsonb_array_length(_dupes) = 0 AND jsonb_array_length(_unrouted) = 0);
END $function$;

-- ==================================================================
-- C. PROCUREMENT / STORES integrity
-- ==================================================================
ALTER TABLE public.goods_receipt_lines
  ADD COLUMN IF NOT EXISTS over_receipt_reason text,
  ADD COLUMN IF NOT EXISTS over_receipt_authorised_by uuid;

CREATE OR REPLACE FUNCTION public.neo_grn_guard_over_receipt()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE _ordered numeric; _already numeric;
BEGIN
  IF NEW.order_line_id IS NULL THEN RETURN NEW; END IF;

  SELECT coalesce(l.quantity, 0) - coalesce(l.cancelled_quantity, 0)
    INTO _ordered FROM public.purchase_order_lines l WHERE l.id = NEW.order_line_id;
  IF _ordered IS NULL THEN RETURN NEW; END IF;

  SELECT coalesce(sum(coalesce(g.quantity_received, 0)), 0) INTO _already
    FROM public.goods_receipt_lines g
   WHERE g.order_line_id = NEW.order_line_id
     AND g.id <> coalesce(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid);

  IF _already + coalesce(NEW.quantity_received, 0) > _ordered + 0.0001 THEN
    IF nullif(btrim(coalesce(NEW.over_receipt_reason,'')),'') IS NULL THEN
      RAISE EXCEPTION 'Over-receipt refused: % ordered, % already received, % now. Record an authorised over-receipt reason to proceed.',
        _ordered, _already, coalesce(NEW.quantity_received, 0) USING ERRCODE = '23514';
    END IF;
    IF NEW.over_receipt_authorised_by IS NULL THEN
      NEW.over_receipt_authorised_by := auth.uid();
    END IF;
  END IF;

  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS neo_grn_over_receipt_guard ON public.goods_receipt_lines;
CREATE TRIGGER neo_grn_over_receipt_guard
BEFORE INSERT OR UPDATE OF quantity_received ON public.goods_receipt_lines
FOR EACH ROW EXECUTE FUNCTION public.neo_grn_guard_over_receipt();

CREATE OR REPLACE FUNCTION public.neo_procurement_reconciliation(_branch uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id();
  _overdue jsonb; _unposted jsonb; _orphan jsonb; _negative jsonb; _low jsonb;
BEGIN
  IF _org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.has_permission('procurement','overview.view')
          OR public.has_permission('stores','overview.view')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(jsonb_agg(x), '[]'::jsonb) INTO _overdue FROM (
    SELECT jsonb_build_object('order_id', p.id, 'order_number', p.order_number,
             'expected_date', p.expected_date, 'status', p.status) AS x
      FROM public.purchase_orders p
     WHERE p.organization_id = _org
       AND (_branch IS NULL OR p.branch_id = _branch)
       AND public.neo_branch_in_scope(p.branch_id)
       AND p.status IN ('approved','sent','partially-received','partially_received')
       AND p.expected_date IS NOT NULL AND p.expected_date < current_date
     LIMIT 200) a;

  SELECT coalesce(jsonb_agg(y), '[]'::jsonb) INTO _unposted FROM (
    SELECT jsonb_build_object('receipt_id', r.id, 'grn_number', r.grn_number,
             'received_at', r.received_at, 'status', r.status) AS y
      FROM public.goods_receipts r
     WHERE r.organization_id = _org
       AND (_branch IS NULL OR r.branch_id = _branch)
       AND public.neo_branch_in_scope(r.branch_id)
       AND r.status NOT IN ('cancelled','draft')
       AND NOT EXISTS (SELECT 1 FROM public.stock_movements m
                        WHERE m.organization_id = _org AND m.reference_type = 'goods_receipt'
                          AND m.reference_id = r.id)
     LIMIT 200) b;

  SELECT coalesce(jsonb_agg(z), '[]'::jsonb) INTO _orphan FROM (
    SELECT jsonb_build_object('movement_id', m.id, 'reference_id', m.reference_id,
             'created_at', m.created_at) AS z
      FROM public.stock_movements m
     WHERE m.organization_id = _org AND m.reference_type = 'goods_receipt'
       AND NOT EXISTS (SELECT 1 FROM public.goods_receipts r WHERE r.id = m.reference_id)
     LIMIT 200) c;

  SELECT coalesce(jsonb_agg(n), '[]'::jsonb) INTO _negative FROM (
    SELECT jsonb_build_object('stock_item_id', l.stock_item_id, 'location_id', l.location_id,
             'quantity', l.quantity_on_hand) AS n
      FROM public.stock_levels l
     WHERE l.organization_id = _org AND l.quantity_on_hand < 0
     LIMIT 200) d;

  SELECT coalesce(jsonb_agg(s), '[]'::jsonb) INTO _low FROM (
    SELECT jsonb_build_object('stock_item_id', l.stock_item_id, 'location_id', l.location_id,
             'quantity', l.quantity_on_hand, 'minimum', l.reorder_level) AS s
      FROM public.stock_levels l
     WHERE l.organization_id = _org AND l.reorder_level IS NOT NULL
       AND l.quantity_on_hand <= l.reorder_level
     LIMIT 200) e;

  RETURN jsonb_build_object('ok', true, 'generated_at', now(),
    'overdue_orders', _overdue, 'receipts_not_in_stock', _unposted,
    'stock_without_receipt', _orphan, 'negative_stock', _negative, 'below_minimum', _low,
    'healthy', jsonb_array_length(_unposted) = 0 AND jsonb_array_length(_orphan) = 0
               AND jsonb_array_length(_negative) = 0);
END $function$;

REVOKE EXECUTE ON FUNCTION public.neo_delivery_dispatch_candidates(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_delivery_assign(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_delivery_rider_audit(uuid, integer) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_delivery_rider_performance(uuid, date, date) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_pos_kds_reconciliation(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_procurement_reconciliation(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_grn_guard_over_receipt() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.neo_delivery_dispatch_candidates(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_delivery_assign(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_delivery_rider_audit(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_delivery_rider_performance(uuid, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_pos_kds_reconciliation(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_procurement_reconciliation(uuid) TO authenticated;