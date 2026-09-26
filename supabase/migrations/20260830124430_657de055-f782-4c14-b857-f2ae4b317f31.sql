-- 1. Retryable status + resolution trail on M-Pesa callback events
ALTER TABLE public.mpesa_callback_events
  ADD COLUMN IF NOT EXISTS retryable boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS resolution text,
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_by uuid;

-- 2. Staff-triggered safe re-apply of a failed callback.
CREATE OR REPLACE FUNCTION public.neo_mpesa_retry_callback(_event uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE _e public.mpesa_callback_events; _t public.mpesa_transactions; _res jsonb; _payload jsonb;
BEGIN
  IF NOT public.neo_mpesa_admin() THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'You do not have authority to re-apply payment callbacks.');
  END IF;

  SELECT * INTO _e FROM public.mpesa_callback_events WHERE id = _event FOR UPDATE;
  IF _e.id IS NULL OR _e.organization_id IS DISTINCT FROM public.current_org_id() THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'Callback event not found in this workspace.');
  END IF;
  IF NOT _e.retryable THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'This callback event is not marked as retryable.');
  END IF;

  SELECT * INTO _t FROM public.mpesa_transactions
   WHERE organization_id = _e.organization_id
     AND (id = _e.transaction_id OR checkout_request_id = _e.checkout_request_id)
   LIMIT 1;
  IF _t.id IS NULL THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'No matching transaction for this callback.');
  END IF;
  IF _t.applied_at IS NOT NULL THEN
    UPDATE public.mpesa_callback_events
       SET retryable = false, resolution = 'Already applied', resolved_at = now(), resolved_by = auth.uid()
     WHERE id = _e.id;
    RETURN jsonb_build_object('applied', false, 'duplicate', true, 'status', _t.status);
  END IF;

  _payload := COALESCE(_e.payload, '{}'::jsonb);
  _res := public.neo_mpesa_apply_result(
    _t.id,
    COALESCE((_payload #>> '{Body,stkCallback,ResultCode}')::integer, -1),
    _payload #>> '{Body,stkCallback,ResultDesc}',
    NULL,
    NULL,
    _payload,
    'manual-retry'
  );

  UPDATE public.mpesa_callback_events
     SET retryable = false,
         resolution = 'Re-applied by staff',
         resolved_at = now(),
         resolved_by = auth.uid()
   WHERE id = _e.id;

  RETURN COALESCE(_res, jsonb_build_object('applied', false, 'reason', 'No result returned.'));
END; $fn$;

GRANT EXECUTE ON FUNCTION public.neo_mpesa_retry_callback(uuid) TO authenticated;

-- 3. Execute-privilege health check for critical routines.
CREATE OR REPLACE FUNCTION public.neo_rpc_execute_privileges(_names text[])
RETURNS TABLE(routine text, arguments text, anon boolean, authenticated boolean, service_role boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $fn$
  SELECT p.proname::text,
         pg_get_function_identity_arguments(p.oid),
         has_function_privilege('anon', p.oid, 'EXECUTE'),
         has_function_privilege('authenticated', p.oid, 'EXECUTE'),
         has_function_privilege('service_role', p.oid, 'EXECUTE')
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = ANY(_names)
   ORDER BY 1, 2;
$fn$;

GRANT EXECUTE ON FUNCTION public.neo_rpc_execute_privileges(text[]) TO authenticated;

-- 4. Re-assert grants for the critical delivery/HR routines the app depends on.
DO $do$
DECLARE _sig text;
BEGIN
  FOR _sig IN
    SELECT format('public.%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid))
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         'neo_delivery_dispatch_candidates','neo_delivery_rider_candidates',
         'neo_delivery_rider_directory','neo_delivery_rider_roster',
         'neo_delivery_notification_audit','neo_hr_reconcile_staff')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', _sig);
  END LOOP;
END $do$;