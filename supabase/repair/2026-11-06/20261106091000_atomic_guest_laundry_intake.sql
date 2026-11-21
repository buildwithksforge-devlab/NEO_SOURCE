-- Guest laundry intake: one atomic, scoped, priced and repeat-safe command.
-- Existing laundry lifecycle, batch and folio posting routines remain authoritative.
BEGIN;
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
COMMIT;