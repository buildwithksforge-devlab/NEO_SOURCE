-- =============================================================
-- NEØ Delivery Department: permissions, supply requests, RPCs
-- =============================================================

-- 1. Permission registry -------------------------------------------------
DO $$
DECLARE f text; a text;
BEGIN
  FOREACH f IN ARRAY ARRAY['requisitions','maintenance','tasks','approvals','cod','my-work'] LOOP
    FOREACH a IN ARRAY ARRAY['view','create','edit','approve','reject','export','print'] LOOP
      INSERT INTO public.permissions (module, feature, action, label)
      VALUES ('delivery', f, a,
              initcap(a) || ' · Delivery ' || initcap(replace(f, '-', ' ')))
      ON CONFLICT DO NOTHING;
    END LOOP;
  END LOOP;
END $$;

-- 2. Delivery supply / equipment requests --------------------------------
CREATE TABLE IF NOT EXISTS public.delivery_supply_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid,
  rider_id uuid REFERENCES public.rider_profiles(id) ON DELETE SET NULL,
  requested_by uuid,
  item text NOT NULL,
  quantity numeric NOT NULL DEFAULT 1,
  unit text NOT NULL DEFAULT 'unit',
  priority text NOT NULL DEFAULT 'normal',
  notes text,
  status text NOT NULL DEFAULT 'pending',
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_notes text,
  requisition_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delivery_supply_requests_status_chk
    CHECK (status IN ('pending','approved','rejected','fulfilled','cancelled')),
  CONSTRAINT delivery_supply_requests_priority_chk
    CHECK (priority IN ('low','normal','high','urgent'))
);

CREATE INDEX IF NOT EXISTS delivery_supply_requests_org_idx
  ON public.delivery_supply_requests (organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS delivery_supply_requests_rider_idx
  ON public.delivery_supply_requests (rider_id);

GRANT SELECT ON public.delivery_supply_requests TO authenticated;
GRANT ALL ON public.delivery_supply_requests TO service_role;

ALTER TABLE public.delivery_supply_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "delivery supply requests readable in scope" ON public.delivery_supply_requests;
CREATE POLICY "delivery supply requests readable in scope"
  ON public.delivery_supply_requests FOR SELECT TO authenticated
  USING (
    organization_id = public.current_org_id()
    AND (
      public.has_permission('delivery','requisitions','view')
      OR requested_by = auth.uid()
      OR rider_id = public.my_rider_id()
    )
  );

DROP TRIGGER IF EXISTS delivery_supply_requests_touch ON public.delivery_supply_requests;
CREATE TRIGGER delivery_supply_requests_touch
  BEFORE UPDATE ON public.delivery_supply_requests
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 3. Create a supply / equipment need ------------------------------------
CREATE OR REPLACE FUNCTION public.neo_delivery_supply_request_create(
  _item text,
  _quantity numeric DEFAULT 1,
  _unit text DEFAULT 'unit',
  _priority text DEFAULT 'normal',
  _notes text DEFAULT NULL,
  _branch uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _org uuid := public.current_org_id();
  _rider uuid := public.my_rider_id();
  _id uuid;
  _branch_final uuid := _branch;
BEGIN
  IF _org IS NULL THEN
    RAISE EXCEPTION 'No organisation context' USING ERRCODE = '42501';
  END IF;

  IF _rider IS NULL AND NOT public.has_permission('delivery','requisitions','create') THEN
    RAISE EXCEPTION 'You are not permitted to report a delivery supply need' USING ERRCODE = '42501';
  END IF;

  IF coalesce(btrim(_item), '') = '' THEN
    RAISE EXCEPTION 'Describe the item that is needed' USING ERRCODE = '22023';
  END IF;

  IF coalesce(_quantity, 0) <= 0 THEN
    RAISE EXCEPTION 'Quantity must be greater than zero' USING ERRCODE = '22023';
  END IF;

  IF _branch_final IS NULL AND _rider IS NOT NULL THEN
    SELECT branch_id INTO _branch_final FROM public.rider_profiles WHERE id = _rider;
  END IF;

  INSERT INTO public.delivery_supply_requests (
    organization_id, branch_id, rider_id, requested_by,
    item, quantity, unit, priority, notes
  ) VALUES (
    _org, _branch_final, _rider, auth.uid(),
    btrim(_item), _quantity, coalesce(nullif(btrim(_unit), ''), 'unit'),
    coalesce(nullif(_priority, ''), 'normal'), nullif(btrim(coalesce(_notes, '')), '')
  ) RETURNING id INTO _id;

  RETURN _id;
END $$;

-- 4. Delivery Manager reviews a supply need ------------------------------
CREATE OR REPLACE FUNCTION public.neo_delivery_supply_request_review(
  _request uuid,
  _decision text,
  _notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _org uuid := public.current_org_id();
  _row public.delivery_supply_requests;
BEGIN
  IF NOT public.has_permission('delivery','requisitions','approve') THEN
    RAISE EXCEPTION 'You are not permitted to review delivery supply requests' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _row FROM public.delivery_supply_requests
   WHERE id = _request AND organization_id = _org;
  IF _row.id IS NULL THEN
    RAISE EXCEPTION 'Supply request not found' USING ERRCODE = 'P0002';
  END IF;

  IF _row.requested_by = auth.uid() THEN
    RAISE EXCEPTION 'You cannot review your own supply request' USING ERRCODE = '42501';
  END IF;

  IF _decision NOT IN ('approved','rejected','fulfilled','cancelled') THEN
    RAISE EXCEPTION 'Unsupported decision %', _decision USING ERRCODE = '22023';
  END IF;

  IF _row.status <> 'pending' AND _decision <> 'fulfilled' THEN
    RAISE EXCEPTION 'This request has already been reviewed' USING ERRCODE = '22023';
  END IF;

  UPDATE public.delivery_supply_requests
     SET status = _decision,
         reviewed_by = auth.uid(),
         reviewed_at = now(),
         review_notes = nullif(btrim(coalesce(_notes, '')), '')
   WHERE id = _request;

  RETURN jsonb_build_object('id', _request, 'status', _decision);
END $$;

-- 5. Delivery maintenance request ---------------------------------------
CREATE OR REPLACE FUNCTION public.neo_delivery_maintenance_request(
  _asset_label text,
  _description text,
  _priority text DEFAULT 'medium',
  _fault_category text DEFAULT 'vehicle',
  _branch uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _org uuid := public.current_org_id();
  _rider uuid := public.my_rider_id();
  _id uuid;
  _branch_final uuid := _branch;
  _dept uuid;
BEGIN
  IF _org IS NULL THEN
    RAISE EXCEPTION 'No organisation context' USING ERRCODE = '42501';
  END IF;

  IF _rider IS NULL AND NOT public.has_permission('delivery','maintenance','create') THEN
    RAISE EXCEPTION 'You are not permitted to raise a delivery maintenance request' USING ERRCODE = '42501';
  END IF;

  IF coalesce(btrim(_asset_label), '') = '' OR coalesce(btrim(_description), '') = '' THEN
    RAISE EXCEPTION 'Describe the asset and the fault' USING ERRCODE = '22023';
  END IF;

  IF _branch_final IS NULL AND _rider IS NOT NULL THEN
    SELECT branch_id INTO _branch_final FROM public.rider_profiles WHERE id = _rider;
  END IF;

  SELECT id INTO _dept FROM public.departments
   WHERE organization_id = _org AND name ILIKE '%delivery%'
   ORDER BY created_at LIMIT 1;

  INSERT INTO public.maintenance_work_orders (
    organization_id, branch_id, work_order_number, requesting_department_id,
    requested_by, location_label, fault_category, description, priority,
    status, source_module, created_by
  ) VALUES (
    _org, _branch_final,
    'DWO-' || to_char(now(), 'YYMMDD') || '-' || lpad((floor(random() * 9999) + 1)::text, 4, '0'),
    _dept, auth.uid(), btrim(_asset_label),
    coalesce(nullif(btrim(_fault_category), ''), 'vehicle'),
    btrim(_description),
    coalesce(nullif(_priority, ''), 'medium'),
    'reported', 'delivery', auth.uid()
  ) RETURNING id INTO _id;

  RETURN _id;
END $$;

-- 6. Faults reported by the caller (rider) or the whole department -------
CREATE OR REPLACE FUNCTION public.neo_delivery_maintenance_requests(
  _branch uuid DEFAULT NULL,
  _limit integer DEFAULT 50
) RETURNS TABLE (
  id uuid,
  work_order_number text,
  location_label text,
  fault_category text,
  description text,
  priority text,
  status text,
  reported_at timestamptz,
  completed_at timestamptz,
  mine boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _org uuid := public.current_org_id();
  _all boolean := public.has_permission('delivery','maintenance','view');
BEGIN
  IF _org IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT w.id, w.work_order_number, w.location_label, w.fault_category,
         w.description, w.priority, w.status, w.reported_at, w.completed_at,
         (w.requested_by = auth.uid()) AS mine
    FROM public.maintenance_work_orders w
   WHERE w.organization_id = _org
     AND w.source_module = 'delivery'
     AND (_branch IS NULL OR w.branch_id = _branch)
     AND (_all OR w.requested_by = auth.uid())
   ORDER BY w.reported_at DESC
   LIMIT greatest(coalesce(_limit, 50), 1);
END $$;

-- 7. Delivery Manager department performance ----------------------------
CREATE OR REPLACE FUNCTION public.neo_delivery_department_metrics(
  _branch uuid DEFAULT NULL,
  _from date DEFAULT (current_date - 29),
  _to date DEFAULT current_date
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _org uuid := public.current_org_id();
  _out jsonb;
BEGIN
  IF NOT public.has_permission('delivery','reports','view')
     AND NOT public.has_permission('delivery','overview','view') THEN
    RAISE EXCEPTION 'You are not permitted to view delivery performance' USING ERRCODE = '42501';
  END IF;

  WITH d AS (
    SELECT * FROM public.delivery_orders o
     WHERE o.organization_id = _org
       AND (_branch IS NULL OR o.branch_id = _branch)
       AND o.created_at::date BETWEEN _from AND _to
  ),
  today AS (SELECT * FROM d WHERE created_at::date = current_date)
  SELECT jsonb_build_object
  (
    'window', jsonb_build_object('from', _from, 'to', _to),
    'volume', jsonb_build_object(
      'total', (SELECT count(*) FROM d),
      'today', (SELECT count(*) FROM today),
      'delivered', (SELECT count(*) FROM d WHERE order_status = 'delivered'),
      'failed', (SELECT count(*) FROM d WHERE order_status = 'failed'),
      'cancelled', (SELECT count(*) FROM d WHERE order_status IN ('cancelled','rejected')),
      'unassigned', (SELECT count(*) FROM d WHERE rider_id IS NULL
                       AND order_status NOT IN ('delivered','cancelled','failed','rejected')),
      'in_flight', (SELECT count(*) FROM d WHERE order_status NOT IN ('delivered','cancelled','failed','rejected')
                       AND rider_id IS NOT NULL)
    ),
    'service', jsonb_build_object(
      'avg_delivery_minutes', (SELECT round(avg(extract(epoch FROM (delivered_at - coalesce(requested_at, created_at))) / 60.0)::numeric, 1)
                                 FROM d WHERE delivered_at IS NOT NULL),
      'on_time_rate', (SELECT round(100.0 * count(*) FILTER (
                                WHERE delivered_at IS NOT NULL AND estimated_delivery_at IS NOT NULL
                                  AND delivered_at <= estimated_delivery_at)::numeric
                              / nullif(count(*) FILTER (WHERE delivered_at IS NOT NULL AND estimated_delivery_at IS NOT NULL), 0), 1)
                         FROM d),
      'revenue', (SELECT coalesce(sum(grand_total), 0) FROM d WHERE order_status = 'delivered')
    ),
    'payments', jsonb_build_object(
      'paid', (SELECT count(*) FROM d WHERE payment_status = 'paid'),
      'unpaid', (SELECT count(*) FROM d WHERE payment_status <> 'paid'),
      'cod_orders', (SELECT count(*) FROM d WHERE payment_method = 'cash'),
      'cod_value', (SELECT coalesce(sum(grand_total), 0) FROM d
                     WHERE payment_method = 'cash' AND payment_status <> 'paid')
    ),
    'riders', jsonb_build_object(
      'total', (SELECT count(*) FROM public.rider_profiles r WHERE r.organization_id = _org
                  AND (_branch IS NULL OR r.branch_id IS NULL OR r.branch_id = _branch) AND r.active),
      'available', (SELECT count(*) FROM public.rider_profiles r WHERE r.organization_id = _org
                      AND (_branch IS NULL OR r.branch_id IS NULL OR r.branch_id = _branch)
                      AND r.active AND r.availability_status = 'available'),
      'on_delivery', (SELECT count(*) FROM public.rider_profiles r WHERE r.organization_id = _org
                      AND (_branch IS NULL OR r.branch_id IS NULL OR r.branch_id = _branch)
                      AND r.active AND r.availability_status IN ('on-delivery','busy')),
      'offline', (SELECT count(*) FROM public.rider_profiles r WHERE r.organization_id = _org
                      AND (_branch IS NULL OR r.branch_id IS NULL OR r.branch_id = _branch)
                      AND r.active AND r.availability_status NOT IN ('available','on-delivery','busy'))
    ),
    'exceptions', jsonb_build_object(
      'open_issues', (SELECT count(*) FROM public.delivery_issues i
                       JOIN d ON d.id = i.delivery_order_id
                      WHERE coalesce(i.status, 'open') <> 'resolved'),
      'supply_requests_pending', (SELECT count(*) FROM public.delivery_supply_requests s
                                   WHERE s.organization_id = _org AND s.status = 'pending'
                                     AND (_branch IS NULL OR s.branch_id IS NULL OR s.branch_id = _branch)),
      'maintenance_open', (SELECT count(*) FROM public.maintenance_work_orders w
                            WHERE w.organization_id = _org AND w.source_module = 'delivery'
                              AND w.status NOT IN ('completed','closed','cancelled')
                              AND (_branch IS NULL OR w.branch_id = _branch)),
      'approvals_pending', (SELECT count(*) FROM public.approval_requests a
                             WHERE a.organization_id = _org AND a.status = 'pending'
                               AND (_branch IS NULL OR a.branch_id = _branch))
    ),
    'rider_performance', coalesce((
      SELECT jsonb_agg(x) FROM (
        SELECT r.display_name AS rider,
               r.availability_status,
               count(o.id) FILTER (WHERE o.order_status = 'delivered') AS delivered,
               count(o.id) FILTER (WHERE o.order_status IN ('failed','rejected')) AS failed,
               count(o.id) FILTER (WHERE o.order_status NOT IN ('delivered','cancelled','failed','rejected')) AS active,
               round(avg(extract(epoch FROM (o.delivered_at - coalesce(o.accepted_at, o.requested_at, o.created_at))) / 60.0)
                     FILTER (WHERE o.delivered_at IS NOT NULL)::numeric, 1) AS avg_minutes
          FROM public.rider_profiles r
          LEFT JOIN d o ON o.rider_id = r.id
         WHERE r.organization_id = _org
           AND (_branch IS NULL OR r.branch_id IS NULL OR r.branch_id = _branch)
           AND r.active
         GROUP BY r.display_name, r.availability_status
         ORDER BY 3 DESC) x), '[]'::jsonb)
  ) INTO _out;

  RETURN _out;
END $$;

-- 8. Execution hygiene ---------------------------------------------------
REVOKE ALL ON FUNCTION public.neo_delivery_supply_request_create(text, numeric, text, text, text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_delivery_supply_request_review(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_delivery_maintenance_request(text, text, text, text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_delivery_maintenance_requests(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_delivery_department_metrics(uuid, date, date) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.neo_delivery_supply_request_create(text, numeric, text, text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_delivery_supply_request_review(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_delivery_maintenance_request(text, text, text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_delivery_maintenance_requests(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_delivery_department_metrics(uuid, date, date) TO authenticated;