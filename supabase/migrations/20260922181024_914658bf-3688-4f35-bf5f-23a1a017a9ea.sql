DO $mig$
DECLARE
  src text;
  patched text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'neo_delivery_record_payment';

  patched := replace(
    src,
    'IF NOT (public.has_permission(''finance'',''payments'',''create'')
          OR public.has_permission(''finance'',''invoices'',''create'')
          OR public.has_permission(''finance'',''approve'')
          OR public.is_org_admin_for(org)) THEN',
    'IF NOT public.neo_delivery_can_record_payment(org) THEN'
  );

  IF patched = src THEN
    RAISE EXCEPTION 'Permission guard not found in neo_delivery_record_payment; aborting.';
  END IF;

  EXECUTE patched;
END
$mig$;
