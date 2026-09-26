DO $$
DECLARE src text; newsrc text; args text;
BEGIN
  SELECT p.prosrc, pg_get_function_arguments(p.oid)
    INTO src, args
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='neo_ar_record_customer_payment';
  IF src IS NULL THEN RAISE EXCEPTION 'function missing'; END IF;
  IF position('shift_id' in src) > 0 THEN
    RAISE NOTICE 'already resolves the cashier shift';
  ELSE
    newsrc := replace(src,
      'source_module, source_record_id, idempotency_key)',
      'source_module, source_record_id, idempotency_key, shift_id)');
    newsrc := replace(newsrc,
      '''ar'', _invoice, _key)',
      '''ar'', _invoice, _key,
      CASE WHEN coalesce(_method,''cash'') = ''cash''
           THEN public.pos_resolve_open_shift(_inv.branch_id) END)');
    IF newsrc = src THEN RAISE EXCEPTION 'insert shape not recognised'; END IF;
    EXECUTE format(
      'CREATE OR REPLACE FUNCTION public.neo_ar_record_customer_payment(%s) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$%s$fn$',
      args, newsrc);
  END IF;
END $$;
REVOKE EXECUTE ON FUNCTION public.neo_ar_record_customer_payment FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_ar_record_customer_payment TO authenticated, service_role;