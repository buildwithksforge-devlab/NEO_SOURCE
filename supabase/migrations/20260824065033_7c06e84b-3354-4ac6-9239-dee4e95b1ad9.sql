
-- 1. Guard violation inbox -------------------------------------------------
CREATE TABLE IF NOT EXISTS public.guard_violations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid,
  guard_name text NOT NULL,
  source_table text NOT NULL,
  operation text NOT NULL DEFAULT 'update',
  record_id text,
  record_label text,
  attempted_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text NOT NULL,
  error_code text,
  actor_id uuid,
  actor_name text,
  status text NOT NULL DEFAULT 'open',
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.guard_violations TO authenticated;
GRANT ALL ON public.guard_violations TO service_role;
ALTER TABLE public.guard_violations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS guard_violations_read ON public.guard_violations;
CREATE POLICY guard_violations_read ON public.guard_violations
  FOR SELECT TO authenticated
  USING (
    organization_id = public.current_org_id()
    AND (
      public.is_org_admin()
      OR public.has_permission('administration','audit-logs.view')
      OR public.has_permission('administration','workspace.edit')
      OR actor_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS guard_violations_insert ON public.guard_violations;
CREATE POLICY guard_violations_insert ON public.guard_violations
  FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS guard_violations_update ON public.guard_violations;
CREATE POLICY guard_violations_update ON public.guard_violations
  FOR UPDATE TO authenticated
  USING (
    organization_id = public.current_org_id()
    AND (public.is_org_admin() OR public.has_permission('administration','workspace.edit'))
  )
  WITH CHECK (organization_id = public.current_org_id());

CREATE INDEX IF NOT EXISTS guard_violations_org_created_idx
  ON public.guard_violations (organization_id, created_at DESC);

DROP TRIGGER IF EXISTS guard_violations_touch ON public.guard_violations;
CREATE TRIGGER guard_violations_touch BEFORE UPDATE ON public.guard_violations
  FOR EACH ROW EXECUTE FUNCTION public.fin_touch_updated_at();

CREATE OR REPLACE FUNCTION public.neo_log_guard_violation(
  _guard text,
  _source_table text,
  _reason text,
  _payload jsonb DEFAULT '{}'::jsonb,
  _record_id text DEFAULT NULL,
  _record_label text DEFAULT NULL,
  _operation text DEFAULT 'update',
  _error_code text DEFAULT NULL,
  _branch uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE _org uuid := public.current_org_id(); _id uuid;
BEGIN
  IF _org IS NULL THEN RETURN NULL; END IF;
  INSERT INTO public.guard_violations
    (organization_id, branch_id, guard_name, source_table, operation, record_id, record_label,
     attempted_payload, reason, error_code, actor_id, actor_name)
  VALUES
    (_org, _branch, _guard, _source_table, coalesce(_operation,'update'), _record_id, _record_label,
     coalesce(_payload,'{}'::jsonb), _reason, _error_code, auth.uid(),
     (SELECT full_name FROM public.profiles WHERE id = auth.uid()))
  RETURNING id INTO _id;
  RETURN _id;
END $$;

CREATE OR REPLACE FUNCTION public.neo_review_guard_violation(_id uuid, _note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE _org uuid := public.current_org_id();
BEGIN
  IF NOT (public.is_org_admin() OR public.has_permission('administration','workspace.edit')) THEN
    RAISE EXCEPTION 'Reviewing guard violations requires administration authority.' USING ERRCODE='42501';
  END IF;
  UPDATE public.guard_violations
     SET status = 'reviewed', reviewed_by = auth.uid(), reviewed_at = now(), review_note = _note
   WHERE id = _id AND organization_id = _org;
  IF NOT FOUND THEN RAISE EXCEPTION 'Guard violation not found.' USING ERRCODE='P0002'; END IF;
  RETURN jsonb_build_object('ok', true, 'id', _id);
END $$;

REVOKE EXECUTE ON FUNCTION public.neo_log_guard_violation(text,text,text,jsonb,text,text,text,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_log_guard_violation(text,text,text,jsonb,text,text,text,text,uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.neo_review_guard_violation(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_review_guard_violation(uuid,text) TO authenticated;

-- 2. Lifecycle repair history ---------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_lifecycle_repairs(_limit integer DEFAULT 200)
RETURNS TABLE(
  id uuid, created_at timestamptz, action text, module text, record_id text,
  actor_name text, reason text, previous_value jsonb, new_value jsonb, guard_rule text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT a.id, a.created_at, a.action, a.module, a.record_id,
         coalesce(nullif(a.user_name,''), p.full_name, 'System'),
         a.reason, a.previous_value, a.new_value,
         CASE
           WHEN a.action LIKE 'pos.lifecycle%' THEN 'neo_pos_lifecycle_guard'
           WHEN a.action LIKE 'restaurant.order.void%' OR a.action LIKE 'restaurant.order.discount%'
             THEN 'neo_pos_guard_void_discount'
           WHEN a.action LIKE 'laundry%' THEN 'neo_laundry_completion_guard'
           ELSE 'manual'
         END
    FROM public.audit_logs a
    LEFT JOIN public.profiles p ON p.id = a.user_id
   WHERE a.organization_id = public.current_org_id()
     AND (public.is_org_admin() OR public.has_permission('administration','audit-logs.view')
          OR public.has_permission('administration','workspace.edit'))
     AND (
       a.action LIKE 'pos.lifecycle%'
       OR a.action LIKE '%.repair%'
       OR a.action LIKE 'restaurant.order.void%'
       OR a.action LIKE 'restaurant.order.cancelled%'
       OR a.action LIKE 'restaurant.order.discount%'
       OR a.action LIKE 'laundry.%repair%'
     )
   ORDER BY a.created_at DESC
   LIMIT greatest(1, least(coalesce(_limit,200), 1000));
$$;

REVOKE EXECUTE ON FUNCTION public.neo_lifecycle_repairs(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_lifecycle_repairs(integer) TO authenticated;

-- 3. Scheduled integrity checks -------------------------------------------
CREATE TABLE IF NOT EXISTS public.integrity_check_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  check_key text NOT NULL,
  check_label text NOT NULL,
  status text NOT NULL,
  anomaly_count integer NOT NULL DEFAULT 0,
  details jsonb NOT NULL DEFAULT '[]'::jsonb,
  triggered_by text NOT NULL DEFAULT 'schedule',
  run_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.integrity_check_runs TO authenticated;
GRANT ALL ON public.integrity_check_runs TO service_role;
ALTER TABLE public.integrity_check_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS integrity_check_runs_read ON public.integrity_check_runs;
CREATE POLICY integrity_check_runs_read ON public.integrity_check_runs
  FOR SELECT TO authenticated
  USING (
    organization_id = public.current_org_id()
    AND (public.is_org_admin() OR public.has_permission('administration','audit-logs.view')
         OR public.has_permission('administration','workspace.edit'))
  );

CREATE INDEX IF NOT EXISTS integrity_check_runs_org_idx
  ON public.integrity_check_runs (organization_id, run_at DESC);

CREATE OR REPLACE FUNCTION public.neo_run_integrity_checks(_org uuid DEFAULT NULL, _trigger text DEFAULT 'schedule')
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  _target uuid;
  _laundry jsonb;
  _pos jsonb;
  _lc integer;
  _pc integer;
  _out jsonb := '[]'::jsonb;
BEGIN
  FOR _target IN
    SELECT o.id FROM public.organizations o
     WHERE (_org IS NULL OR o.id = _org)
  LOOP
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'id', l.id, 'laundry_number', l.laundry_number,
             'status', l.status, 'total', l.total)), '[]'::jsonb)
      INTO _laundry
      FROM public.guest_laundry_orders l
     WHERE l.organization_id = _target
       AND l.status IN ('delivered','completed','closed')
       AND (coalesce(btrim(l.laundry_number),'') = '' OR coalesce(l.total,0) <= 0);

    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'id', o.id, 'order_number', o.order_number, 'status', o.status,
             'payment_status', o.payment_status, 'paid_total', o.paid_total,
             'grand_total', o.grand_total)), '[]'::jsonb)
      INTO _pos
      FROM public.pos_orders o
     WHERE o.organization_id = _target
       AND (
         (o.status IN ('draft','cancelled','voided','void')
          AND (coalesce(o.payment_status,'unpaid') IN ('paid','partial','partially_paid')
               OR coalesce(o.paid_total,0) > 0))
         OR (o.status IN ('closed','completed','settled')
             AND coalesce(o.payment_status,'unpaid')
                 NOT IN ('paid','settled','complimentary','transferred','charged_to_room')
             AND coalesce(o.grand_total,0) > 0)
         OR (o.status IN ('sent','confirmed','preparing','ready','served','partially-served')
             AND coalesce(o.payment_status,'unpaid') IN ('paid','settled')
             AND coalesce(o.grand_total,0) > 0
             AND coalesce(o.paid_total,0) >= coalesce(o.grand_total,0))
       );

    _lc := jsonb_array_length(_laundry);
    _pc := jsonb_array_length(_pos);

    INSERT INTO public.integrity_check_runs
      (organization_id, check_key, check_label, status, anomaly_count, details, triggered_by)
    VALUES
      (_target, 'laundry_number_value',
       'Laundry orders completed without a number or value',
       CASE WHEN _lc = 0 THEN 'clean' ELSE 'anomaly' END, _lc, _laundry, coalesce(_trigger,'schedule')),
      (_target, 'pos_status_payment',
       'Impossible restaurant order status / payment combinations',
       CASE WHEN _pc = 0 THEN 'clean' ELSE 'anomaly' END, _pc, _pos, coalesce(_trigger,'schedule'));

    IF _lc + _pc > 0 THEN
      INSERT INTO public.notifications
        (organization_id, user_id, category, title, body, link, priority,
         source_module, event_type, idempotency_key, action_required)
      SELECT _target, ur.user_id, 'system',
             'Data integrity anomaly detected',
             format('%s laundry and %s restaurant order anomalies were found by the scheduled integrity check.', _lc, _pc),
             '/admin/integrity', 'high', 'administration', 'integrity.anomaly',
             'integrity:' || _target::text || ':' || to_char(now(),'YYYYMMDDHH24MI'), true
        FROM public.user_roles ur
        JOIN public.roles r ON r.id = ur.role_id
       WHERE ur.organization_id = _target AND r.access_scope = 'organisation'
       GROUP BY ur.user_id
      ON CONFLICT DO NOTHING;

      INSERT INTO public.dashboard_alerts
        (organization_id, severity, title, body, metric, observed_value, status)
      VALUES (_target, 'critical', 'Data integrity anomaly detected',
              format('%s laundry and %s restaurant order anomalies await review.', _lc, _pc),
              'integrity_anomalies', _lc + _pc, 'open');
    END IF;

    _out := _out || jsonb_build_object(
      'organization_id', _target,
      'laundry_anomalies', _lc,
      'pos_anomalies', _pc);
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'ran_at', now(), 'results', _out);
END $$;

CREATE OR REPLACE FUNCTION public.neo_run_integrity_checks_now()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  IF NOT (public.is_org_admin() OR public.has_permission('administration','workspace.edit')) THEN
    RAISE EXCEPTION 'Running integrity checks requires administration authority.' USING ERRCODE='42501';
  END IF;
  RETURN public.neo_run_integrity_checks(public.current_org_id(), 'manual');
END $$;

REVOKE EXECUTE ON FUNCTION public.neo_run_integrity_checks(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.neo_run_integrity_checks_now() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_run_integrity_checks_now() TO authenticated;
