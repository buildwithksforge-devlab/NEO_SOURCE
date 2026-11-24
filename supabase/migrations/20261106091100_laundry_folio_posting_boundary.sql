-- Laundry first-post repair. No historical orders or accounting rows are changed here.
BEGIN;
DO $neo_guard$
BEGIN
  IF replace((SELECT prosrc FROM pg_proc WHERE oid='public.neo_laundry_retry_posting(uuid)'::regprocedure), E'\r\n', E'\n') IS DISTINCT FROM replace($neo_expected$
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
$neo_expected$, E'\r\n', E'\n') THEN
    RAISE EXCEPTION 'Laundry posting function differs from reviewed local source; inspect deployment before applying';
  END IF;

  IF replace((SELECT prosrc FROM pg_proc WHERE oid='public.neo_laundry_autopost_after_delivery()'::regprocedure), E'\r\n', E'\n') IS DISTINCT FROM replace($neo_expected$
DECLARE _res jsonb;
BEGIN
  IF NEW.status IN ('delivered','completed','closed')
     AND COALESCE(NEW.posting_status,'unposted') <> 'posted'
     AND (NEW.status IS DISTINCT FROM OLD.status
          OR NEW.total IS DISTINCT FROM OLD.total
          OR NEW.folio_id IS DISTINCT FROM OLD.folio_id) THEN
    _res := public.neo_finance_post_source('laundry',NEW.id,true);
    IF NOT COALESCE((_res->>'ok')::boolean,false) THEN
      UPDATE public.guest_laundry_orders
         SET posting_status='blocked',
             discrepancy_notes=concat_ws(' ',NULLIF(discrepancy_notes,''),
               COALESCE(_res->>'detail',_res->>'reason','Laundry finance posting failed.'))
       WHERE id=NEW.id AND COALESCE(posting_status,'unposted') <> 'posted';
    END IF;
  END IF;
  RETURN NEW;
END;
$neo_expected$, E'\r\n', E'\n') THEN
    RAISE EXCEPTION 'Laundry posting function differs from reviewed local source; inspect deployment before applying';
  END IF;
END
$neo_guard$;
CREATE OR REPLACE FUNCTION public.neo_laundry_retry_posting(_order uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public
AS $function$
DECLARE
  v_org uuid:=public.current_org_id(); v_row public.guest_laundry_orders;
  v_folio public.folios; v_count integer; v_result jsonb; v_ok boolean:=false;
  v_reason text; v_detail text;
  v_prior text:=coalesce(current_setting('neo.system_posting',true),'off');
BEGIN
  IF v_org IS NULL OR auth.uid() IS NULL THEN RAISE EXCEPTION 'Authenticated organisation context required' USING ERRCODE='42501'; END IF;
  IF NOT (public.has_permission('laundry','orders','edit') OR public.has_permission('laundry','orders','approve')
          OR public.has_permission('pms','folios','post_charge') OR public.has_permission('finance','postings','edit')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to re-post laundry charges' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_row FROM public.guest_laundry_orders WHERE id=_order AND organization_id=v_org FOR UPDATE;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'Unknown laundry order'; END IF;
  IF NOT public.neo_branch_in_scope(v_row.branch_id) THEN RAISE EXCEPTION 'This laundry belongs to another property' USING ERRCODE='42501'; END IF;
  IF v_row.status NOT IN ('delivered','completed','closed') THEN
    RETURN jsonb_build_object('ok',false,'reason','not_delivered','detail','Confirm guest handover through the laundry lifecycle before posting.');
  END IF;

  IF v_row.posting_status='posted' THEN
    IF EXISTS(SELECT 1 FROM public.folio_lines l JOIN public.folios f ON f.id=l.folio_id
      WHERE l.id=v_row.folio_line_id AND l.folio_id=v_row.folio_id AND l.organization_id=v_org
        AND l.branch_id=v_row.branch_id AND f.organization_id=v_org AND f.branch_id=v_row.branch_id
        AND (v_row.reservation_id IS NULL OR f.reservation_id=v_row.reservation_id)
        AND l.source_module='laundry' AND l.source_record_id::text=_order::text
        AND coalesce(l.status,'posted') NOT IN ('void','voided','reversed')
        AND round(l.net_amount,2)=round(v_row.total,2)) THEN
      RETURN jsonb_build_object('ok',true,'already_posted',true,'folio_charged',true,
        'folio_id',v_row.folio_id,'folio_line_id',v_row.folio_line_id);
    END IF;
    RETURN jsonb_build_object('ok',false,'reason','invalid_posted_link','detail','This posted laundry does not have a matching folio charge. Reconcile the historical posting before retrying.');
  END IF;

  IF v_row.folio_id IS NOT NULL THEN
    SELECT * INTO v_folio FROM public.folios
      WHERE id=v_row.folio_id AND organization_id=v_org AND branch_id=v_row.branch_id
        AND (v_row.reservation_id IS NULL OR reservation_id=v_row.reservation_id) FOR UPDATE;
  ELSIF v_row.reservation_id IS NOT NULL THEN
    SELECT count(*) INTO v_count FROM public.folios
      WHERE organization_id=v_org AND branch_id=v_row.branch_id AND reservation_id=v_row.reservation_id
        AND folio_type='guest' AND status='open';
    IF v_count=1 THEN
      SELECT * INTO v_folio FROM public.folios
        WHERE organization_id=v_org AND branch_id=v_row.branch_id AND reservation_id=v_row.reservation_id
          AND folio_type='guest' AND status='open' FOR UPDATE;
    END IF;
  END IF;
  IF v_folio.id IS NULL OR v_folio.status<>'open' THEN
    v_reason:='missing_open_folio'; v_detail:='Link this delivered laundry to exactly one open guest folio in the same property before posting.';
  ELSE
    -- The existing Finance coordinator creates the first folio charge itself.
    -- Requiring folio_line_id before this call would prevent that first posting.
    BEGIN
      v_result:=public.neo_finance_post_source('laundry',_order,true);
      PERFORM set_config('neo.system_posting',v_prior,true);
      IF coalesce((v_result->>'ok')::boolean,false) IS NOT TRUE THEN
        RAISE EXCEPTION '%',coalesce(v_result->>'detail',v_result->>'reason','The laundry posting did not return success');
      END IF;
      SELECT * INTO v_row FROM public.guest_laundry_orders WHERE id=_order AND organization_id=v_org;
      IF v_row.folio_id IS DISTINCT FROM v_folio.id OR NOT EXISTS(
        SELECT 1 FROM public.folio_lines l WHERE l.id=v_row.folio_line_id AND l.folio_id=v_folio.id
          AND l.organization_id=v_org AND l.branch_id=v_row.branch_id
          AND l.source_module='laundry' AND l.source_record_id::text=_order::text
          AND coalesce(l.status,'posted') NOT IN ('void','voided','reversed')
          AND round(l.net_amount,2)=round(v_row.total,2)
      ) THEN RAISE EXCEPTION 'The posting did not persist the matching laundry charge on the selected guest folio'; END IF;
      v_ok:=true;
    EXCEPTION WHEN OTHERS THEN
      -- Roll back any partial folio/journal writes from this attempt, then
      -- retain a visible blocked outcome outside the failed subtransaction.
      v_reason:='posting_failed'; v_detail:=SQLERRM; v_ok:=false;
    END;
    PERFORM set_config('neo.system_posting',v_prior,true);
  END IF;
  IF v_ok THEN
    UPDATE public.guest_laundry_orders SET posting_status='posted',posted_at=coalesce(posted_at,now()),updated_at=now()
      WHERE id=_order AND coalesce(posting_status,'unposted')<>'posted';
    RETURN v_result || jsonb_build_object('ok',true,'folio_charged',true,'folio_id',v_folio.id,'folio_line_id',v_row.folio_line_id);
  END IF;
  UPDATE public.guest_laundry_orders
    SET posting_status='blocked',updated_at=now(),
      discrepancy_notes=CASE WHEN position(v_detail IN coalesce(discrepancy_notes,''))>0 THEN discrepancy_notes
        ELSE concat_ws(' ',nullif(discrepancy_notes,''),v_detail) END
    WHERE id=_order AND status='delivered';
  RETURN jsonb_build_object('ok',false,'reason',v_reason,'detail',v_detail,'folio_charged',false);
END
$function$;
CREATE OR REPLACE FUNCTION public.neo_laundry_autopost_after_delivery()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _res jsonb;
BEGIN
  IF NEW.status IN ('delivered','completed','closed')
     AND COALESCE(NEW.posting_status,'unposted') <> 'posted'
     AND (NEW.status IS DISTINCT FROM OLD.status
          OR NEW.total IS DISTINCT FROM OLD.total
          OR NEW.folio_id IS DISTINCT FROM OLD.folio_id) THEN
    _res := public.neo_laundry_retry_posting(NEW.id);
    IF NOT COALESCE((_res->>'ok')::boolean,false) THEN
      UPDATE public.guest_laundry_orders
         SET posting_status='blocked',
             discrepancy_notes=concat_ws(' ',NULLIF(discrepancy_notes,''),
               COALESCE(_res->>'detail',_res->>'reason','Laundry finance posting failed.'))
       WHERE id=NEW.id AND COALESCE(posting_status,'unposted') <> 'posted';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
COMMIT;
