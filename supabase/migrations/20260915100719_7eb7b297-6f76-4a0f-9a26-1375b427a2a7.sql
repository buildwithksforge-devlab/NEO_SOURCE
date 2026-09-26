DO $$
DECLARE src text;
BEGIN
  SELECT prosrc INTO src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='neo_delivery_bill';
  IF src IS NULL THEN RAISE EXCEPTION 'neo_delivery_bill not found'; END IF;
  IF position('''sales'', CURRENT_DATE' in src) = 0 THEN
    RAISE NOTICE 'already corrected';
  ELSE
    EXECUTE 'CREATE OR REPLACE FUNCTION public.neo_delivery_bill(_order uuid, _reason text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$'
      || replace(src, '''sales'', CURRENT_DATE', '''automatic'', CURRENT_DATE')
      || '$fn$';
  END IF;
END $$;
REVOKE EXECUTE ON FUNCTION public.neo_delivery_bill(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_delivery_bill(uuid, text) TO authenticated, service_role;