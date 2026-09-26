DO $$
DECLARE src text; newsrc text; args text; oldblk text; newblk text;
BEGIN
  SELECT p.prosrc, pg_get_function_arguments(p.oid) INTO src, args
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='neo_ar_record_customer_payment';

  oldblk := '  _res := public.neo_gl_post(
    _org, _inv.branch_id, ''finance'', ''customer_payment'', _pay, ''settlement'',
    _date, coalesce(_inv.currency,''KES''),
    ''Customer receipt '' || _receipt || '' against invoice '' || _inv.invoice_number,
    jsonb_build_array(
      jsonb_build_object(''code'', _cash_code, ''debit'', _amt, ''description'', ''Money received''),
      jsonb_build_object(''code'', _ar_code, ''credit'', _amt, ''description'', ''Customer debt settled'')
    ),
    _inv.customer_id);

  _journal := (_res->>''journal_id'')::uuid;';

  newblk := '  -- The payment insert already triggers the canonical settlement posting.
  -- Reuse it so one receipt never books cash twice.
  SELECT je.id INTO _journal FROM public.journal_entries je
   WHERE je.organization_id = _org AND je.source_document_id = _pay
   ORDER BY je.created_at LIMIT 1;

  IF _journal IS NULL THEN
    _res := public.neo_gl_post(
      _org, _inv.branch_id, ''finance'', ''customer_payment'', _pay, ''settlement'',
      _date, coalesce(_inv.currency,''KES''),
      ''Customer receipt '' || _receipt || '' against invoice '' || _inv.invoice_number,
      jsonb_build_array(
        jsonb_build_object(''code'', _cash_code, ''debit'', _amt, ''description'', ''Money received''),
        jsonb_build_object(''code'', _ar_code, ''credit'', _amt, ''description'', ''Customer debt settled'')
      ),
      _inv.customer_id);
    _journal := (_res->>''journal_id'')::uuid;
  END IF;';

  IF position(oldblk in src) = 0 THEN RAISE EXCEPTION 'posting block not found'; END IF;
  newsrc := replace(src, oldblk, newblk);
  EXECUTE format('CREATE OR REPLACE FUNCTION public.neo_ar_record_customer_payment(%s) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$%s$fn$', args, newsrc);
END $$;
REVOKE EXECUTE ON FUNCTION public.neo_ar_record_customer_payment FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_ar_record_customer_payment TO authenticated, service_role;