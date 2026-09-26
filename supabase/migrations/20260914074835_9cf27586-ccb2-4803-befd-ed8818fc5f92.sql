CREATE OR REPLACE FUNCTION public.neo_procurement_queue_due_reminders_all()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _org record;
  _result jsonb;
  _queued integer := 0;
  _skipped integer := 0;
BEGIN
  FOR _org IN
    SELECT DISTINCT po.organization_id
      FROM public.purchase_orders po
     WHERE po.status IN ('approved','pending-delivery','partially-received','partly-received','open')
       AND coalesce(po.expected_date, current_date) <= current_date
       AND EXISTS (
         SELECT 1
           FROM public.purchase_order_lines pol
          WHERE pol.order_id = po.id
            AND greatest(coalesce(pol.quantity,0) - coalesce(pol.accepted_quantity,pol.received_quantity,0) - coalesce(pol.cancelled_quantity,0),0) > 0
       )
  LOOP
    _result := public.neo_procurement_queue_due_reminders(_org.organization_id);
    _queued := _queued + coalesce((_result->>'queued')::integer,0);
    _skipped := _skipped + coalesce((_result->>'skipped')::integer,0);
  END LOOP;

  RETURN jsonb_build_object('queued',_queued,'skipped',_skipped,'cadence_days',2);
END
$function$;

REVOKE ALL ON FUNCTION public.neo_procurement_queue_due_reminders_all() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_procurement_queue_due_reminders_all() TO service_role;

DO $do$
DECLARE _job bigint;
BEGIN
  SELECT jobid INTO _job FROM cron.job WHERE jobname = 'neo-procurement-delivery-reminders' LIMIT 1;
  IF _job IS NOT NULL THEN PERFORM cron.unschedule(_job); END IF;
  PERFORM cron.schedule(
    'neo-procurement-delivery-reminders',
    '20 7 * * *',
    $job$SELECT public.neo_procurement_queue_due_reminders_all();$job$
  );
END
$do$;