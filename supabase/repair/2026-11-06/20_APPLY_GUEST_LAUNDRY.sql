-- Apply as ONE submission after reviewing the laundry preflight.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
-- SOURCE: 20261106091000_atomic_guest_laundry_intake.sql
-- Guest laundry intake: one atomic, scoped, priced and repeat-safe command.
-- Existing laundry lifecycle, batch and folio posting routines remain authoritative.

ALTER TABLE public.guest_laundry_orders
  ADD COLUMN IF NOT EXISTS intake_idempotency_key text,
  ADD COLUMN IF NOT EXISTS intake_request_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS guest_laundry_orders_intake_identity_idx
  ON public.guest_laundry_orders(organization_id,branch_id,intake_idempotency_key)
  WHERE intake_idempotency_key IS NOT NULL;

CREATE OR REPLACE FUNCTION public.neo_laundry_order_create(
  _branch uuid,_room uuid,_items jsonb,_idempotency_key text,
  _express boolean DEFAULT false,_instructions text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public
AS $function$
DECLARE
  v_org uuid:=public.current_org_id(); v_actor uuid:=auth.uid();
  v_key text:=nullif(btrim(_idempotency_key),''); v_hash text;
  v_existing public.guest_laundry_orders; v_stay public.stays; v_res public.reservations;
  v_folio uuid; v_currency text; v_customer uuid; v_count integer; v_order uuid; v_number text; v_audit uuid;
  v_item jsonb; v_price public.laundry_price_items; v_qty numeric; v_unit numeric; v_tax_rate numeric;
  v_line numeric; v_subtotal numeric:=0; v_tax numeric:=0;
BEGIN
  IF v_org IS NULL OR v_actor IS NULL THEN RAISE EXCEPTION 'Authenticated organisation context required' USING ERRCODE='42501'; END IF;
  IF NOT (public.has_permission('laundry','orders','create') OR public.has_permission('laundry','create')
          OR public.has_permission('laundry','edit') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to create guest laundry orders' USING ERRCODE='42501';
  END IF;
  IF _branch IS NULL OR NOT public.neo_branch_in_scope(_branch) THEN
    RAISE EXCEPTION 'The selected property is outside your access scope' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM public.rooms WHERE id=_room AND organization_id=v_org AND branch_id=_branch;
  IF NOT FOUND THEN RAISE EXCEPTION 'Select a room in the authorised property'; END IF;
  IF v_key IS NULL OR length(v_key)>200 THEN RAISE EXCEPTION 'A laundry intake identity of 1 to 200 characters is required'; END IF;
  IF _items IS NULL OR jsonb_typeof(_items)<>'array' OR jsonb_array_length(_items)=0 THEN
    RAISE EXCEPTION 'Select at least one configured laundry item';
  END IF;
  v_hash:=md5(jsonb_build_object('room',_room,'items',_items,'express',coalesce(_express,false),'instructions',_instructions)::text);
  PERFORM pg_advisory_xact_lock(hashtextextended('laundry-intake:'||v_org::text||':'||_branch::text||':'||v_key,0));
  SELECT * INTO v_existing FROM public.guest_laundry_orders
    WHERE organization_id=v_org AND branch_id=_branch AND intake_idempotency_key=v_key;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.intake_request_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'This intake identity already belongs to different laundry. Open the saved order before starting another.';
    END IF;
    RETURN jsonb_build_object('ok',true,'idempotent',true,'order_id',v_existing.id,
      'laundry_number',v_existing.laundry_number,'folio_id',v_existing.folio_id,'reservation_id',v_existing.reservation_id,'total',v_existing.total);
  END IF;

  SELECT count(*) INTO v_count FROM public.stays
    WHERE organization_id=v_org AND branch_id=_branch AND room_id=_room AND checked_out_at IS NULL
      AND status IN ('in-house','checked-in');
  IF v_count<>1 THEN RAISE EXCEPTION 'The room must have exactly one active guest stay before laundry intake'; END IF;
  SELECT * INTO v_stay FROM public.stays
    WHERE organization_id=v_org AND branch_id=_branch AND room_id=_room AND checked_out_at IS NULL
      AND status IN ('in-house','checked-in') FOR SHARE;
  SELECT * INTO v_res FROM public.reservations
    WHERE id=v_stay.reservation_id AND organization_id=v_org AND branch_id=_branch FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'The active stay has no matching reservation in this property'; END IF;
  IF v_stay.customer_id IS NOT NULL AND v_res.customer_id IS NOT NULL AND v_stay.customer_id<>v_res.customer_id THEN
    RAISE EXCEPTION 'The stay and reservation guest links disagree; reconcile them before intake';
  END IF;
  v_customer:=coalesce(v_stay.customer_id,v_res.customer_id);
  IF v_customer IS NULL THEN RAISE EXCEPTION 'The active stay has no linked guest'; END IF;
  SELECT count(*) INTO v_count FROM public.folios
    WHERE organization_id=v_org AND branch_id=_branch AND reservation_id=v_stay.reservation_id
      AND (stay_id=v_stay.id OR stay_id IS NULL) AND folio_type='guest' AND status='open'
      AND (customer_id=v_customer OR customer_id IS NULL);
  IF v_count<>1 THEN RAISE EXCEPTION 'The active stay must have exactly one open guest folio'; END IF;
  SELECT id,currency INTO v_folio,v_currency FROM public.folios
    WHERE organization_id=v_org AND branch_id=_branch AND reservation_id=v_stay.reservation_id
      AND (stay_id=v_stay.id OR stay_id IS NULL) AND folio_type='guest' AND status='open'
      AND (customer_id=v_customer OR customer_id IS NULL) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'The guest folio changed during intake; reload and retry'; END IF;
  IF v_currency IS DISTINCT FROM public.neo_fact_currency(v_org,_branch) THEN
    RAISE EXCEPTION 'The guest folio currency differs from the property laundry price currency';
  END IF;

  v_number:=public.next_document_number('laundry');
  INSERT INTO public.guest_laundry_orders(
    organization_id,branch_id,laundry_number,customer_id,reservation_id,folio_id,room_id,
    service_type,express,express_charge,special_instructions,status,created_by,intake_idempotency_key,intake_request_hash
  ) VALUES(v_org,_branch,v_number,v_customer,v_stay.reservation_id,v_folio,_room,
    'normal',coalesce(_express,false),0,nullif(btrim(_instructions),''),'requested',v_actor,v_key,v_hash)
  RETURNING id INTO v_order;
  FOR v_item IN SELECT * FROM jsonb_array_elements(_items) LOOP
    SELECT * INTO v_price FROM public.laundry_price_items
      WHERE id=nullif(v_item->>'price_item_id','')::uuid AND organization_id=v_org
        AND (branch_id=_branch OR branch_id IS NULL) AND active FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Every garment must use an active price from this property''s laundry catalogue'; END IF;
    v_qty:=(v_item->>'quantity')::numeric;
    IF v_qty IS NULL OR v_qty::text IN ('NaN','Infinity','-Infinity') OR v_qty<=0 THEN RAISE EXCEPTION 'Every laundry quantity must be positive and finite'; END IF;
    v_unit:=CASE WHEN coalesce(_express,false) AND v_price.express_price>0 THEN v_price.express_price ELSE v_price.normal_price END;
    v_tax_rate:=coalesce(v_price.tax_rate,0);
    IF v_unit IS NULL OR v_unit::text IN ('NaN','Infinity','-Infinity') OR v_unit<0
       OR v_tax_rate::text IN ('NaN','Infinity','-Infinity') OR v_tax_rate<0 THEN
      RAISE EXCEPTION 'Correct the configured laundry price or tax before intake';
    END IF;
    v_line:=round(v_qty*v_unit,2);
    v_subtotal:=v_subtotal+v_line; v_tax:=v_tax+round(v_line*v_tax_rate/100,2);
    INSERT INTO public.guest_laundry_items(organization_id,order_id,price_item_id,description,service_type,quantity,unit_price,tax_rate,line_total)
    VALUES(v_org,v_order,v_price.id,v_price.name,v_price.service_type,v_qty,v_unit,v_tax_rate,v_line);
  END LOOP;
  IF v_subtotal<=0 THEN RAISE EXCEPTION 'The selected laundry must have a configured positive price'; END IF;
  UPDATE public.guest_laundry_orders SET subtotal=v_subtotal,tax_amount=v_tax,total=v_subtotal+v_tax,updated_at=now() WHERE id=v_order;
  v_audit:=public.log_audit_event('laundry.order.created','laundry',v_order::text,NULL,
    jsonb_build_object('order_id',v_order,'laundry_number',v_number,'room_id',_room,'reservation_id',v_stay.reservation_id,
      'folio_id',v_folio,'total',v_subtotal+v_tax,'items',jsonb_array_length(_items)),
    'Guest laundry intake','laundry.orders.create',_branch,NULL,NULL,v_key,NULL,NULL);
  IF v_audit IS NULL THEN RAISE EXCEPTION 'Laundry intake could not save its audit record'; END IF;
  RETURN jsonb_build_object('ok',true,'idempotent',false,'order_id',v_order,'laundry_number',v_number,
    'folio_id',v_folio,'reservation_id',v_stay.reservation_id,'total',v_subtotal+v_tax,'audit_id',v_audit);
END
$function$;
REVOKE ALL ON FUNCTION public.neo_laundry_order_create(uuid,uuid,jsonb,text,boolean,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.neo_laundry_order_create(uuid,uuid,jsonb,text,boolean,text) TO authenticated;

-- SOURCE: 20261106091100_laundry_folio_posting_boundary.sql
-- Laundry first-post repair. No historical orders or accounting rows are changed here.

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

-- SOURCE: 20261106091200_laundry_delivery_actor_type.sql
-- Guest laundry handover: preserve the text actor column and property boundary.

DO $neo_guard$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='guest_laundry_orders' AND column_name='delivery_confirmed_by' AND data_type='text') THEN
    RAISE EXCEPTION 'The laundry confirming-actor column differs from the reviewed text schema';
  END IF;
  IF replace((SELECT prosrc FROM pg_proc WHERE oid='public.neo_laundry_order_advance(uuid,text,text)'::regprocedure), E'\r\n', E'\n') IS DISTINCT FROM replace($neo_expected$
DECLARE
  _org uuid := public.current_org_id();
  _row public.guest_laundry_orders%ROWTYPE;
  _posting jsonb;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'No organisation context'; END IF;
  IF NOT (
    public.has_permission('laundry','orders','edit') OR
    public.has_permission('laundry','orders','approve') OR
    public.is_org_admin()
  ) THEN
    RAISE EXCEPTION 'Not permitted to update guest laundry' USING ERRCODE='42501';
  END IF;

  SELECT * INTO _row
    FROM public.guest_laundry_orders
   WHERE id=_order AND organization_id=_org
   FOR UPDATE;
  IF _row.id IS NULL THEN RAISE EXCEPTION 'Laundry order not found'; END IF;

  IF _status = _row.status THEN
    RETURN jsonb_build_object('ok',true,'idempotent',true,'status',_row.status,
      'posting_status',_row.posting_status);
  END IF;

  IF _status = 'delivered' THEN
    UPDATE public.guest_laundry_orders
       SET status='delivered',
           delivered_at=COALESCE(delivered_at,now()),
           delivery_confirmed_by=COALESCE(delivery_confirmed_by,auth.uid()),
           discrepancy_notes=concat_ws(' ',NULLIF(discrepancy_notes,''),NULLIF(btrim(_note),'')),
           updated_at=now()
     WHERE id=_order;

    -- Delivery and accounting are separate facts.  Retry the canonical Finance
    -- posting and leave the order visibly blocked when the guest/folio/payment
    -- context is not sufficient rather than pretending it was billed.
    _posting := public.neo_laundry_retry_posting(_order);

    SELECT * INTO _row FROM public.guest_laundry_orders WHERE id=_order;
    PERFORM public.log_audit_event(
      _org,'laundry.order.delivered','laundry',_order::text,
      jsonb_build_object('status','ready-for-delivery'),
      jsonb_build_object('status',_row.status,'delivered_at',_row.delivered_at,
                         'posting_status',_row.posting_status,'posting',_posting),
      COALESCE(NULLIF(btrim(_note),''),'Guest laundry handed back'));

    RETURN jsonb_build_object('ok',true,'status',_row.status,
      'delivered_at',_row.delivered_at,'posting_status',_row.posting_status,
      'posting',_posting);
  END IF;

  IF _status = 'completed' THEN
    UPDATE public.guest_laundry_orders
       SET status='completed',updated_at=now()
     WHERE id=_order;
    RETURN jsonb_build_object('ok',true,'status','completed');
  END IF;

  UPDATE public.guest_laundry_orders
     SET status=_status,
         collected_at=CASE WHEN _status='collected' AND collected_at IS NULL THEN now() ELSE collected_at END,
         discrepancy_notes=CASE WHEN _status IN ('on-hold','disputed')
           THEN concat_ws(' ',NULLIF(discrepancy_notes,''),NULLIF(btrim(_note),''))
           ELSE discrepancy_notes END,
         updated_at=now()
   WHERE id=_order;

  RETURN jsonb_build_object('ok',true,'status',_status);
END;
$neo_expected$, E'\r\n', E'\n') THEN
    RAISE EXCEPTION 'Laundry handover function differs from reviewed local source; inspect deployment before applying';
  END IF;
END
$neo_guard$;
CREATE OR REPLACE FUNCTION public.neo_laundry_order_advance(
  _order uuid,
  _status text,
  _note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _row public.guest_laundry_orders%ROWTYPE;
  _posting jsonb;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'No organisation context'; END IF;
  IF NOT (
    public.has_permission('laundry','orders','edit') OR
    public.has_permission('laundry','orders','approve') OR
    public.is_org_admin()
  ) THEN
    RAISE EXCEPTION 'Not permitted to update guest laundry' USING ERRCODE='42501';
  END IF;

  SELECT * INTO _row
    FROM public.guest_laundry_orders
   WHERE id=_order AND organization_id=_org
   FOR UPDATE;
  IF _row.id IS NULL THEN RAISE EXCEPTION 'Laundry order not found'; END IF;
  IF NOT public.neo_branch_in_scope(_row.branch_id) THEN
    RAISE EXCEPTION 'This laundry belongs to another property' USING ERRCODE='42501';
  END IF;

  IF _status = _row.status THEN
    RETURN jsonb_build_object('ok',true,'idempotent',true,'status',_row.status,
      'posting_status',_row.posting_status);
  END IF;

  IF _status = 'delivered' THEN
    UPDATE public.guest_laundry_orders
       SET status='delivered',
           delivered_at=COALESCE(delivered_at,now()),
           delivery_confirmed_by=COALESCE(delivery_confirmed_by,auth.uid()::text),
           discrepancy_notes=concat_ws(' ',NULLIF(discrepancy_notes,''),NULLIF(btrim(_note),'')),
           updated_at=now()
     WHERE id=_order;

    -- Delivery and accounting are separate facts.  Retry the canonical Finance
    -- posting and leave the order visibly blocked when the guest/folio/payment
    -- context is not sufficient rather than pretending it was billed.
    _posting := public.neo_laundry_retry_posting(_order);

    SELECT * INTO _row FROM public.guest_laundry_orders WHERE id=_order;
    PERFORM public.log_audit_event(
      _org,'laundry.order.delivered','laundry',_order::text,
      jsonb_build_object('status','ready-for-delivery'),
      jsonb_build_object('status',_row.status,'delivered_at',_row.delivered_at,
                         'posting_status',_row.posting_status,'posting',_posting),
      COALESCE(NULLIF(btrim(_note),''),'Guest laundry handed back'));

    RETURN jsonb_build_object('ok',true,'status',_row.status,
      'delivered_at',_row.delivered_at,'posting_status',_row.posting_status,
      'posting',_posting);
  END IF;

  IF _status = 'completed' THEN
    UPDATE public.guest_laundry_orders
       SET status='completed',updated_at=now()
     WHERE id=_order;
    RETURN jsonb_build_object('ok',true,'status','completed');
  END IF;

  UPDATE public.guest_laundry_orders
     SET status=_status,
         collected_at=CASE WHEN _status='collected' AND collected_at IS NULL THEN now() ELSE collected_at END,
         discrepancy_notes=CASE WHEN _status IN ('on-hold','disputed')
           THEN concat_ws(' ',NULLIF(discrepancy_notes,''),NULLIF(btrim(_note),''))
           ELSE discrepancy_notes END,
         updated_at=now()
   WHERE id=_order;

  RETURN jsonb_build_object('ok',true,'status',_status);
END;
$function$;

COMMIT;
