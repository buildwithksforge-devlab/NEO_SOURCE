CREATE OR REPLACE FUNCTION public.neo_laundry_retry_posting(_order uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _res jsonb; _ok boolean; _line uuid; _folio uuid;
BEGIN
  IF NOT (public.has_permission('laundry','orders','edit')
          OR public.has_permission('laundry','orders','approve')
          OR public.has_permission('pms','folios','post_charge')
          OR public.has_permission('finance','postings','edit')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to re-post laundry charges';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.guest_laundry_orders
                  WHERE id = _order AND organization_id = _org) THEN
    RAISE EXCEPTION 'Unknown laundry order';
  END IF;

  _res := public.neo_finance_post_source('laundry', _order, true);
  _ok := COALESCE((_res->>'ok')::boolean, false);

  SELECT folio_line_id, folio_id INTO _line, _folio
    FROM public.guest_laundry_orders WHERE id = _order;

  -- A charge that reached Finance but never reached a guest folio is still a
  -- completed posting; it is recorded as such with the reason kept visible.
  IF _ok THEN
    UPDATE public.guest_laundry_orders
       SET posting_status = 'posted',
           posted_at = COALESCE(posted_at, now()),
           discrepancy_notes = CASE
             WHEN _line IS NULL AND _folio IS NULL
               THEN 'Recognised in Finance as laundry revenue. No open guest folio was attached, so nothing was charged to a guest bill.'
             ELSE discrepancy_notes END
     WHERE id = _order AND COALESCE(posting_status,'unposted') <> 'posted';
    RETURN _res || jsonb_build_object('folio_charged', _line IS NOT NULL);
  END IF;

  UPDATE public.guest_laundry_orders
     SET posting_status = 'blocked',
         discrepancy_notes = COALESCE(_res->>'detail', _res->>'reason', discrepancy_notes)
   WHERE id = _order AND COALESCE(posting_status,'unposted') <> 'posted';
  RETURN _res;
END $function$;