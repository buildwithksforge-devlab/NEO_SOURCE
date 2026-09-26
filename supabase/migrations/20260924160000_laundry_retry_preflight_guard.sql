-- NEØ certification hardening: laundry retry must validate guest-billing context
-- before attempting Finance posting. This keeps the posting invariant and the
-- recovery RPC aligned.

CREATE OR REPLACE FUNCTION public.neo_laundry_retry_posting(_order uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _row public.guest_laundry_orders;
  _res jsonb;
  _ok boolean;
BEGIN
  IF NOT (public.has_permission('laundry','orders','edit')
          OR public.has_permission('laundry','orders','approve')
          OR public.has_permission('pms','folios','post_charge')
          OR public.has_permission('finance','postings','edit')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to re-post laundry charges';
  END IF;

  SELECT * INTO _row
  FROM public.guest_laundry_orders
  WHERE id=_order AND organization_id=_org
  FOR UPDATE;

  IF _row.id IS NULL THEN RAISE EXCEPTION 'Unknown laundry order'; END IF;

  -- The canonical laundry posting invariant requires a real guest folio charge
  -- before the order may become posted. Never create Finance revenue first and
  -- discover missing guest context afterwards.
  IF _row.folio_id IS NULL OR _row.folio_line_id IS NULL THEN
    UPDATE public.guest_laundry_orders
       SET posting_status='blocked',
           discrepancy_notes=concat_ws(' ',
             NULLIF(discrepancy_notes,''),
             'Posting blocked: laundry order is not linked to a valid guest folio charge.'),
           updated_at=now()
     WHERE id=_order;

    RETURN jsonb_build_object(
      'ok',false,
      'reason','missing_folio_charge',
      'detail','Laundry posting requires a valid folio and folio charge line before Finance posting.',
      'folio_id',_row.folio_id,
      'folio_line_id',_row.folio_line_id
    );
  END IF;

  _res:=public.neo_finance_post_source('laundry',_order,true);
  _ok:=COALESCE((_res->>'ok')::boolean,false);

  IF _ok THEN
    UPDATE public.guest_laundry_orders
       SET posting_status='posted',posted_at=COALESCE(posted_at,now()),updated_at=now()
     WHERE id=_order AND COALESCE(posting_status,'unposted')<>'posted';
    RETURN _res || jsonb_build_object('folio_charged',true);
  END IF;

  UPDATE public.guest_laundry_orders
     SET posting_status='blocked',
         discrepancy_notes=COALESCE(_res->>'detail',_res->>'reason',discrepancy_notes),
         updated_at=now()
   WHERE id=_order AND COALESCE(posting_status,'unposted')<>'posted';
  RETURN _res;
END
$function$;
