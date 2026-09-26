ALTER TABLE public.delivery_zones
  ADD COLUMN IF NOT EXISTS configured_distance_km numeric;

COMMENT ON COLUMN public.delivery_zones.configured_distance_km IS
  'Administrator-confirmed reference distance for this delivery zone; NULL means not configured.';

ALTER TABLE public.neo_test_runs
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS current_suite text,
  ADD COLUMN IF NOT EXISTS failure_detail text;

UPDATE public.neo_test_runs
   SET heartbeat_at = coalesce(heartbeat_at, updated_at, started_at)
 WHERE heartbeat_at IS NULL;

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY control_org_id
           ORDER BY coalesce(heartbeat_at, updated_at, started_at) DESC, started_at DESC
         ) AS position
    FROM public.neo_test_runs
   WHERE status = 'running'
)
UPDATE public.neo_test_runs r
   SET status = 'interrupted',
       finished_at = now(),
       duration_ms = greatest(0, (extract(epoch FROM (now() - r.started_at)) * 1000)::integer),
       failure_detail = 'A newer run superseded this unfinished run. Persisted results are retained; this run is not certified.'
  FROM ranked
 WHERE r.id = ranked.id
   AND ranked.position > 1;

CREATE UNIQUE INDEX IF NOT EXISTS neo_test_runs_one_active_per_org_idx
  ON public.neo_test_runs(control_org_id)
  WHERE status = 'running';

CREATE OR REPLACE FUNCTION public.neo_test_run_recover_stale(_older_than interval DEFAULT interval '15 minutes')
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _count integer := 0;
BEGIN
  IF _org IS NULL OR NOT public.is_org_admin_for(_org) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  WITH stale AS (
    SELECT r.id,
           jsonb_build_object(
             'tests', count(x.id),
             'passed', count(x.id) FILTER (WHERE x.status = 'pass'),
             'warnings', count(x.id) FILTER (WHERE x.status = 'warn'),
             'failed', count(x.id) FILTER (WHERE x.status = 'fail'),
             'critical', count(x.id) FILTER (WHERE x.status = 'critical'),
             'skipped', count(x.id) FILTER (WHERE x.status = 'skip')
           ) AS totals
      FROM public.neo_test_runs r
      LEFT JOIN public.neo_test_results x ON x.run_id = r.id
     WHERE r.control_org_id = _org
       AND r.status = 'running'
       AND coalesce(r.heartbeat_at, r.updated_at, r.started_at) < now() - _older_than
     GROUP BY r.id
  ), repaired AS (
    UPDATE public.neo_test_runs r
       SET status = 'interrupted',
           totals = stale.totals,
           finished_at = now(),
           duration_ms = greatest(0, (extract(epoch FROM (now() - r.started_at)) * 1000)::integer),
           failure_detail = 'The runner stopped before finalisation. Persisted results are retained; this run is not certified.'
      FROM stale
     WHERE r.id = stale.id
     RETURNING r.id
  )
  SELECT count(*) INTO _count FROM repaired;

  RETURN _count;
END
$function$;

REVOKE ALL ON FUNCTION public.neo_test_run_recover_stale(interval) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_test_run_recover_stale(interval) TO authenticated, service_role;

CREATE TABLE IF NOT EXISTS public.procurement_delivery_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  branch_id uuid REFERENCES public.branches(id),
  purchase_order_id uuid NOT NULL REFERENCES public.purchase_orders(id),
  recipient_kind text NOT NULL CHECK (recipient_kind IN ('supplier','requester')),
  recipient_email text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','skipped','sent','failed')),
  reason text,
  communication_queue_id uuid REFERENCES public.communication_queue(id),
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key)
);
GRANT SELECT ON public.procurement_delivery_reminders TO authenticated;
GRANT ALL ON public.procurement_delivery_reminders TO service_role;
ALTER TABLE public.procurement_delivery_reminders ENABLE ROW LEVEL SECURITY;
CREATE POLICY procurement_delivery_reminders_read
  ON public.procurement_delivery_reminders FOR SELECT TO authenticated
  USING (
    organization_id = public.current_org_id()
    AND public.neo_branch_in_scope(branch_id)
    AND (public.has_permission('procurement','orders.view') OR public.is_org_admin_for(organization_id))
  );
CREATE TRIGGER procurement_delivery_reminders_touch
  BEFORE UPDATE ON public.procurement_delivery_reminders
  FOR EACH ROW EXECUTE FUNCTION public.bi_touch_updated_at();

CREATE OR REPLACE FUNCTION public.neo_procurement_queue_due_reminders(_organization uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _org uuid := coalesce(_organization, public.current_org_id());
  _queued integer := 0;
  _skipped integer := 0;
  _row record;
  _recipient record;
  _queue_id uuid;
  _key text;
  _bucket bigint := floor(extract(epoch FROM now()) / 172800);
BEGIN
  IF _org IS NULL THEN
    RAISE EXCEPTION 'no_organisation';
  END IF;
  IF _organization IS NULL AND NOT (
    public.has_permission('procurement','orders.edit') OR public.is_org_admin_for(_org)
  ) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  FOR _row IN
    SELECT po.id, po.organization_id, po.branch_id, po.order_number, po.expected_date,
           s.name AS supplier_name, s.email AS supplier_email,
           requester.email AS requester_email
      FROM public.purchase_orders po
      JOIN public.suppliers s ON s.id = po.supplier_id AND s.organization_id = po.organization_id
      LEFT JOIN public.purchase_requests pr ON pr.id = po.request_id AND pr.organization_id = po.organization_id
      LEFT JOIN public.profiles requester ON requester.id = pr.requested_by AND requester.organization_id = po.organization_id
     WHERE po.organization_id = _org
       AND po.status IN ('approved','pending-delivery','partially-received','partly-received','open')
       AND coalesce(po.expected_date, current_date) <= current_date
       AND EXISTS (
         SELECT 1 FROM public.purchase_order_lines pol
          WHERE pol.order_id = po.id
            AND greatest(coalesce(pol.quantity,0) - coalesce(pol.accepted_quantity,pol.received_quantity,0) - coalesce(pol.cancelled_quantity,0),0) > 0
       )
  LOOP
    FOR _recipient IN
      SELECT * FROM (VALUES
        ('supplier'::text, nullif(trim(_row.supplier_email),'')),
        ('requester'::text, nullif(trim(_row.requester_email),''))
      ) AS recipients(kind,email)
    LOOP
      _key := 'po-reminder:' || _row.id::text || ':' || _recipient.kind || ':' || _bucket::text;
      IF EXISTS (SELECT 1 FROM public.procurement_delivery_reminders WHERE organization_id = _org AND idempotency_key = _key) THEN
        CONTINUE;
      END IF;

      IF _recipient.email IS NULL THEN
        INSERT INTO public.procurement_delivery_reminders(
          organization_id, branch_id, purchase_order_id, recipient_kind,
          recipient_email, status, reason, idempotency_key
        ) VALUES (
          _org, _row.branch_id, _row.id, _recipient.kind,
          NULL, 'skipped', 'No stored email address is available for this recipient.', _key
        );
        _skipped := _skipped + 1;
      ELSE
        INSERT INTO public.communication_queue(
          organization_id, branch_id, template_key, channel, recipient, subject,
          rendered_body, variables, scheduled_for, status, max_attempts,
          source_module, source_record_id, idempotency_key, is_marketing
        ) VALUES (
          _org, _row.branch_id, 'purchase-order-delivery-reminder', 'email', _recipient.email,
          'Delivery follow-up — ' || _row.order_number,
          '<p>Delivery follow-up for purchase order <strong>' || replace(_row.order_number,'<','&lt;') || '</strong>.</p>' ||
          '<p>The order still has outstanding quantities' ||
          CASE WHEN _row.expected_date IS NOT NULL THEN ' and was expected by ' || _row.expected_date::text ELSE '' END ||
          '.</p><p>Please review the purchase order and update the delivery position.</p>',
          jsonb_build_object('purchase_order_id',_row.id,'order_number',_row.order_number,'recipient_kind',_recipient.kind),
          now(), 'queued', 3, 'procurement', _row.id, _key, false
        )
        ON CONFLICT (organization_id, idempotency_key) DO UPDATE SET updated_at = now()
        RETURNING id INTO _queue_id;

        INSERT INTO public.procurement_delivery_reminders(
          organization_id, branch_id, purchase_order_id, recipient_kind,
          recipient_email, status, communication_queue_id, idempotency_key
        ) VALUES (
          _org, _row.branch_id, _row.id, _recipient.kind,
          _recipient.email, 'queued', _queue_id, _key
        );
        _queued := _queued + 1;
      END IF;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object('queued',_queued,'skipped',_skipped,'cadence_days',2);
END
$function$;

REVOKE ALL ON FUNCTION public.neo_procurement_queue_due_reminders(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_procurement_queue_due_reminders(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_delivery_rider_performance_distance(
  _branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL
) RETURNS TABLE(
  rider_id uuid, rider_code text, display_name text,
  assigned integer, delivered integer, failed integer, active_orders integer,
  avg_delivery_minutes numeric, avg_assignment_minutes numeric, on_time_rate numeric,
  cash_collected numeric, scheduled_hours numeric,
  configured_distance_km numeric, avg_minutes_per_km numeric, distance_coverage integer
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
          OR public.is_org_admin_for(_org)) THEN
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
    round(100.0 * count(o.id) FILTER (
        WHERE o.delivered_at IS NOT NULL AND o.estimated_delivery_at IS NOT NULL
          AND o.delivered_at <= o.estimated_delivery_at)::numeric
      / nullif(count(o.id) FILTER (WHERE o.delivered_at IS NOT NULL AND o.estimated_delivery_at IS NOT NULL), 0), 1),
    coalesce(sum(o.grand_total) FILTER (
      WHERE o.order_status = 'delivered' AND o.payment_method IN ('cash','cash-on-delivery','cod')), 0),
    coalesce((SELECT round(sum(extract(epoch FROM (least(s.ends_at, _t) - greatest(s.starts_at, _f))) / 3600.0)::numeric, 1)
        FROM public.rider_shifts s
       WHERE s.rider_id = r.id AND s.status <> 'cancelled'
         AND s.starts_at < _t AND s.ends_at > _f), 0),
    round(coalesce(sum(z.configured_distance_km) FILTER (WHERE o.order_status='delivered'),0),1),
    round(
      sum(extract(epoch FROM (o.delivered_at - coalesce(o.collected_at,o.ready_at))) / 60.0)
        FILTER (WHERE o.delivered_at IS NOT NULL AND z.configured_distance_km > 0)
      / nullif(sum(z.configured_distance_km) FILTER (WHERE o.delivered_at IS NOT NULL),0), 1),
    count(o.id) FILTER (WHERE o.order_status='delivered' AND z.configured_distance_km IS NOT NULL)::int
  FROM public.rider_profiles r
  LEFT JOIN public.delivery_orders o
    ON o.rider_id = r.id AND o.created_at >= _f AND o.created_at < _t
   AND (_branch IS NULL OR o.branch_id = _branch)
  LEFT JOIN public.delivery_zones z ON z.id = o.zone_id AND z.organization_id = _org
  WHERE r.organization_id = _org
    AND (_branch IS NULL OR r.branch_id IS NULL OR r.branch_id = _branch)
    AND public.neo_branch_in_scope(r.branch_id)
  GROUP BY r.id, r.rider_code, r.display_name
  ORDER BY r.display_name;
END
$function$;

REVOKE ALL ON FUNCTION public.neo_delivery_rider_performance_distance(uuid,date,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_delivery_rider_performance_distance(uuid,date,date) TO authenticated, service_role;