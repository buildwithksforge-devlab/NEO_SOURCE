CREATE TABLE IF NOT EXISTS public.rider_shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid,
  rider_id uuid NOT NULL REFERENCES public.rider_profiles(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled',
  notes text,
  cancelled_reason text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rider_shifts_rider_window_idx ON public.rider_shifts (rider_id, starts_at DESC);
CREATE INDEX IF NOT EXISTS rider_shifts_org_branch_idx ON public.rider_shifts (organization_id, branch_id, starts_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.rider_shifts TO authenticated;
GRANT ALL ON public.rider_shifts TO service_role;

ALTER TABLE public.rider_shifts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rider_shifts_read ON public.rider_shifts;
CREATE POLICY rider_shifts_read ON public.rider_shifts FOR SELECT TO authenticated
USING (
  organization_id = public.current_org_id()
  AND public.neo_branch_in_scope(branch_id)
  AND (
    public.has_permission('delivery','dispatch.view')
    OR public.has_permission('delivery','riders.manage')
    OR EXISTS (
      SELECT 1 FROM public.rider_profiles r
       WHERE r.id = rider_shifts.rider_id AND r.profile_id = auth.uid()
    )
  )
);

DROP POLICY IF EXISTS rider_shifts_write ON public.rider_shifts;
CREATE POLICY rider_shifts_write ON public.rider_shifts FOR ALL TO authenticated
USING (
  organization_id = public.current_org_id()
  AND public.neo_branch_in_scope(branch_id)
  AND public.has_permission('delivery','riders.manage')
)
WITH CHECK (
  organization_id = public.current_org_id()
  AND public.neo_branch_in_scope(branch_id)
  AND public.has_permission('delivery','riders.manage')
);

DROP TRIGGER IF EXISTS rider_shifts_touch ON public.rider_shifts;
CREATE TRIGGER rider_shifts_touch BEFORE UPDATE ON public.rider_shifts
FOR EACH ROW EXECUTE FUNCTION public.fin_touch_updated_at();

-- ------------------------------------------------------------------
-- Schedule a shift
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_delivery_shift_schedule(
  _rider uuid, _starts_at timestamptz, _ends_at timestamptz,
  _branch uuid DEFAULT NULL, _notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _r public.rider_profiles; _branch_use uuid; _id uuid;
BEGIN
  IF _org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT public.has_permission('delivery','riders.manage') THEN
    RAISE EXCEPTION 'The delivery.riders.manage permission is required.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _r FROM public.rider_profiles WHERE id = _rider AND organization_id = _org;
  IF _r.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'rider_not_found'); END IF;
  IF _r.active IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'rider_retired',
      'detail', 'This rider is not active on the roster.');
  END IF;

  _branch_use := coalesce(_branch, _r.branch_id);
  IF NOT public.neo_branch_in_scope(_branch_use) THEN
    RAISE EXCEPTION 'That property is outside your access scope.' USING ERRCODE = '42501';
  END IF;

  IF _ends_at <= _starts_at THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_window',
      'detail', 'The shift must end after it starts.');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.rider_shifts s
     WHERE s.rider_id = _rider AND s.status IN ('scheduled','active')
       AND s.starts_at < _ends_at AND s.ends_at > _starts_at
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'overlapping_shift',
      'detail', 'This rider already has a shift covering part of that window.');
  END IF;

  INSERT INTO public.rider_shifts (organization_id, branch_id, rider_id, starts_at, ends_at, notes, created_by)
  VALUES (_org, _branch_use, _rider, _starts_at, _ends_at, nullif(btrim(coalesce(_notes,'')),''), auth.uid())
  RETURNING id INTO _id;

  INSERT INTO public.notifications (organization_id, branch_id, category, title, body, link, user_id)
  VALUES (_org, _branch_use, 'operations', 'Delivery shift scheduled',
    coalesce(_r.display_name,'Rider') || ' — ' || to_char(_starts_at, 'DD Mon HH24:MI') || ' to ' ||
    to_char(_ends_at, 'DD Mon HH24:MI'), '/delivery', _r.profile_id);

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (_org, auth.uid(), '', 'delivery.rider.shift-schedule', 'delivery', _id::text,
    jsonb_build_object('rider_id', _rider, 'starts_at', _starts_at, 'ends_at', _ends_at));

  RETURN jsonb_build_object('ok', true, 'shift_id', _id);
END $function$;

-- ------------------------------------------------------------------
-- Cancel a shift
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_delivery_shift_cancel(_shift uuid, _reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _s public.rider_shifts; _r public.rider_profiles;
BEGIN
  IF NOT public.has_permission('delivery','riders.manage') THEN
    RAISE EXCEPTION 'The delivery.riders.manage permission is required.' USING ERRCODE = '42501';
  END IF;
  IF coalesce(btrim(_reason),'') = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'reason_required',
      'detail', 'Cancelling a shift requires a written reason.');
  END IF;

  SELECT * INTO _s FROM public.rider_shifts WHERE id = _shift AND organization_id = _org FOR UPDATE;
  IF _s.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF NOT public.neo_branch_in_scope(_s.branch_id) THEN
    RAISE EXCEPTION 'That property is outside your access scope.' USING ERRCODE = '42501';
  END IF;
  IF _s.status IN ('cancelled','completed') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_open',
      'detail', 'That shift is already ' || _s.status || '.');
  END IF;

  UPDATE public.rider_shifts
     SET status = 'cancelled', cancelled_reason = _reason, updated_at = now()
   WHERE id = _shift;

  SELECT * INTO _r FROM public.rider_profiles WHERE id = _s.rider_id;

  INSERT INTO public.notifications (organization_id, branch_id, category, title, body, link, user_id)
  VALUES (_org, _s.branch_id, 'operations', 'Delivery shift cancelled',
    to_char(_s.starts_at, 'DD Mon HH24:MI') || ' — ' || _reason, '/delivery', _r.profile_id);

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
  VALUES (_org, auth.uid(), '', 'delivery.rider.shift-cancel', 'delivery', _shift::text,
    jsonb_build_object('rider_id', _s.rider_id), _reason);

  RETURN jsonb_build_object('ok', true);
END $function$;

-- ------------------------------------------------------------------
-- Live dispatch board
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_delivery_dispatch_board(_branch uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _riders jsonb; _queue jsonb;
BEGIN
  IF _org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.has_permission('delivery','dispatch.view')
          OR public.has_permission('delivery','riders.manage')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(jsonb_agg(x ORDER BY x->>'display_name'), '[]'::jsonb) INTO _riders
  FROM (
    SELECT jsonb_build_object(
      'rider_id', r.id,
      'rider_code', r.rider_code,
      'display_name', r.display_name,
      'vehicle_type', r.vehicle_type,
      'availability_status', r.availability_status,
      'max_active', coalesce(r.max_active_deliveries, 3),
      'cash_handling_allowed', r.cash_handling_allowed,
      'branch_id', r.branch_id,
      'active_load', (
        SELECT count(*) FROM public.delivery_orders o
         WHERE o.rider_id = r.id
           AND o.order_status NOT IN ('delivered','cancelled','rejected','failed')
      ),
      'on_shift', EXISTS (
        SELECT 1 FROM public.rider_shifts s
         WHERE s.rider_id = r.id AND s.status IN ('scheduled','active')
           AND now() BETWEEN s.starts_at AND s.ends_at
      ),
      'next_shift', (
        SELECT min(s.starts_at) FROM public.rider_shifts s
         WHERE s.rider_id = r.id AND s.status = 'scheduled' AND s.starts_at > now()
      ),
      'delivered_today', (
        SELECT count(*) FROM public.delivery_orders o
         WHERE o.rider_id = r.id AND o.delivered_at >= date_trunc('day', now())
      )
    ) AS x
    FROM public.rider_profiles r
    WHERE r.organization_id = _org
      AND r.active IS TRUE
      AND (_branch IS NULL OR r.branch_id IS NULL OR r.branch_id = _branch)
      AND public.neo_branch_in_scope(r.branch_id)
  ) t;

  SELECT coalesce(jsonb_agg(y ORDER BY y->>'requested_at'), '[]'::jsonb) INTO _queue
  FROM (
    SELECT jsonb_build_object(
      'order_id', o.id,
      'order_number', o.order_number,
      'contact_name', o.contact_name,
      'order_status', o.order_status,
      'kitchen_status', o.kitchen_status,
      'dispatch_status', o.dispatch_status,
      'payment_method', o.payment_method,
      'grand_total', o.grand_total,
      'requested_at', o.requested_at,
      'waiting_minutes', round(extract(epoch FROM (now() - coalesce(o.ready_at, o.requested_at, o.created_at))) / 60.0),
      'branch_id', o.branch_id
    ) AS y
    FROM public.delivery_orders o
    WHERE o.organization_id = _org
      AND (_branch IS NULL OR o.branch_id = _branch)
      AND public.neo_branch_in_scope(o.branch_id)
      AND o.rider_id IS NULL
      AND o.order_status NOT IN ('delivered','cancelled','rejected','failed','draft')
    LIMIT 200
  ) q;

  RETURN jsonb_build_object('ok', true, 'generated_at', now(), 'riders', _riders, 'queue', _queue);
END $function$;

-- ------------------------------------------------------------------
-- Rider performance metrics
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_delivery_rider_performance(
  _branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL
) RETURNS TABLE(
  rider_id uuid, rider_code text, display_name text,
  assigned integer, delivered integer, failed integer,
  avg_delivery_minutes numeric, on_time_rate numeric,
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
    count(o.id) FILTER (WHERE o.id IS NOT NULL)::int,
    count(o.id) FILTER (WHERE o.order_status = 'delivered')::int,
    count(o.id) FILTER (WHERE o.order_status IN ('failed','rejected'))::int,
    round(avg(extract(epoch FROM (o.delivered_at - coalesce(o.collected_at, o.ready_at))) / 60.0)
          FILTER (WHERE o.delivered_at IS NOT NULL), 1),
    round(
      100.0 * count(o.id) FILTER (
        WHERE o.delivered_at IS NOT NULL
          AND (o.estimated_delivery_at IS NULL OR o.delivered_at <= o.estimated_delivery_at)
      )::numeric
      / nullif(count(o.id) FILTER (WHERE o.delivered_at IS NOT NULL), 0), 1),
    coalesce(sum(o.grand_total) FILTER (
      WHERE o.order_status = 'delivered' AND o.payment_method IN ('cash','cash-on-delivery')), 0),
    coalesce((
      SELECT round(sum(extract(epoch FROM (least(s.ends_at, _t) - greatest(s.starts_at, _f))) / 3600.0)::numeric, 1)
        FROM public.rider_shifts s
       WHERE s.rider_id = r.id AND s.status <> 'cancelled'
         AND s.starts_at < _t AND s.ends_at > _f
    ), 0)
  FROM public.rider_profiles r
  LEFT JOIN public.delivery_orders o
    ON o.rider_id = r.id
   AND o.created_at >= _f AND o.created_at < _t
   AND (_branch IS NULL OR o.branch_id = _branch)
  WHERE r.organization_id = _org
    AND (_branch IS NULL OR r.branch_id IS NULL OR r.branch_id = _branch)
    AND public.neo_branch_in_scope(r.branch_id)
  GROUP BY r.id, r.rider_code, r.display_name
  ORDER BY r.display_name;
END $function$;

-- ------------------------------------------------------------------
-- Rider activity log
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_delivery_rider_audit(_rider uuid, _limit integer DEFAULT 100)
RETURNS TABLE(
  created_at timestamptz, action text, order_number text, detail text, actor uuid
)
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
  SELECT s.updated_at,
         ('shift.' || s.status)::text,
         NULL::text,
         (to_char(s.starts_at,'DD Mon HH24:MI') || ' → ' || to_char(s.ends_at,'DD Mon HH24:MI')
           || coalesce(' · ' || s.cancelled_reason, ''))::text,
         s.created_by
    FROM public.rider_shifts s
   WHERE s.organization_id = _org AND s.rider_id = _rider
     AND public.neo_branch_in_scope(s.branch_id)
  ORDER BY 1 DESC
  LIMIT greatest(coalesce(_limit, 100), 1);
END $function$;

REVOKE EXECUTE ON FUNCTION public.neo_delivery_shift_schedule(uuid, timestamptz, timestamptz, uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_delivery_shift_cancel(uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_delivery_dispatch_board(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_delivery_rider_performance(uuid, date, date) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_delivery_rider_audit(uuid, integer) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.neo_delivery_shift_schedule(uuid, timestamptz, timestamptz, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_delivery_shift_cancel(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_delivery_dispatch_board(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_delivery_rider_performance(uuid, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_delivery_rider_audit(uuid, integer) TO authenticated;