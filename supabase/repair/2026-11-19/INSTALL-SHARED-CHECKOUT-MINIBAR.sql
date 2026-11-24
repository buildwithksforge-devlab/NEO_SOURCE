-- Shared checkout + durable minibar rollout for EVERY organisation.
-- Installs code and private retry storage only. No stock, guest, payment,
-- room-state, store mapping or historical business record is created/changed.
-- User-supplied installed body hashes checked by each migration guard.
BEGIN;
DO $prerequisites$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.stock_locations')
   AND attname='location_type' AND NOT attisdropped) THEN
  RAISE EXCEPTION 'Store location_type column is missing; installation rolled back';
 END IF;
 IF to_regprocedure('public.neo_recipe_sheet_save(jsonb,jsonb,uuid)') IS NULL THEN
  RAISE EXCEPTION 'Installed shared recipe contract is missing; reconcile project before rollout';
 END IF;
END $prerequisites$;

DO $guard$ BEGIN
 IF to_regprocedure('public.neo_folio_financial_components(uuid,uuid)') IS NULL THEN RAISE EXCEPTION 'Canonical Finance calculation is missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
 WHERE p.oid=to_regprocedure('public.pms_check_out(uuid,boolean,text)') AND r.rolname NOT IN ('anon','authenticated')
 AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g')) IN ('050eb10752ff4ae40265dcc7cb4c2e97','e9bd1cfa8cb67b4a76c7326459b338b1','07cc04cb81587b9938de7969fbc2ddf8')) THEN
 RAISE EXCEPTION 'Checkout differs from reviewed source; nothing replaced'; END IF;
END $guard$;
CREATE TEMP TABLE neo_multifolio_checkout_acl ON COMMIT DROP AS SELECT proowner,coalesce(proacl::text,'') acl
 FROM pg_proc WHERE oid='public.pms_check_out(uuid,boolean,text)'::regprocedure;
CREATE OR REPLACE FUNCTION public.pms_check_out(_reservation uuid, _force boolean DEFAULT false, _notes text DEFAULT ''::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  org uuid := public.current_org_id();
  stay_record public.stays;
  folio_record public.folios;
  parts jsonb;
  summaries jsonb := '[]'::jsonb;
  summary jsonb;
  result jsonb;
  primary_folio uuid;
  currency_code text;
  charges numeric;
  collected numeric;
  balance numeric;
  total_charges numeric := 0;
  total_collected numeric := 0;
  total_outstanding numeric := 0;
  forced boolean := false;
  previous_posting text;
BEGIN
  IF auth.uid() IS NULL OR org IS NULL OR NOT coalesce(
    public.has_permission('pms','checkout.perform') OR public.is_org_admin(),false
  ) THEN RAISE EXCEPTION 'Not permitted to check out guests' USING ERRCODE='42501'; END IF;

  -- Same reservation collection lock used by recorded/confirmed payments.
  PERFORM pg_advisory_xact_lock(hashtextextended(org::text||':reservation-collection:'||_reservation::text,0));
  SELECT * INTO stay_record FROM public.stays
    WHERE reservation_id=_reservation AND organization_id=org FOR UPDATE;
  IF stay_record.id IS NULL THEN RAISE EXCEPTION 'No stay found for this reservation'; END IF;
  IF NOT coalesce(public.neo_branch_in_scope(stay_record.branch_id),false) THEN
    RAISE EXCEPTION 'Stay outside authorized property scope' USING ERRCODE='42501';
  END IF;
  IF stay_record.status='checked-out' THEN
    SELECT a.new_value INTO result FROM public.audit_logs a
      WHERE a.organization_id=org AND a.branch_id=stay_record.branch_id
        AND a.action='pms.checkout' AND a.record_id=_reservation::text
        AND a.new_value->>'stay_id'=stay_record.id::text AND a.new_value ? 'folios'
      LIMIT 1;
    RETURN coalesce(result,jsonb_build_object('stay_id',stay_record.id,'legacy_result',true))
      || jsonb_build_object('idempotent',true);
  END IF;
  IF coalesce(stay_record.status,'') NOT IN ('checked-in','checked_in','in-house','in_house') THEN
    RAISE EXCEPTION 'Stay cannot check out from status %',stay_record.status;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.reservations r WHERE r.id=_reservation
    AND r.organization_id=org AND r.branch_id=stay_record.branch_id) THEN
    RAISE EXCEPTION 'Reservation and stay property require reconciliation';
  END IF;
  IF stay_record.room_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.rooms r
    WHERE r.id=stay_record.room_id AND r.organization_id=org AND r.branch_id=stay_record.branch_id) THEN
    RAISE EXCEPTION 'Assigned room and stay property require reconciliation';
  END IF;
  IF EXISTS(SELECT 1 FROM public.folios f WHERE f.stay_id=stay_record.id
    AND (f.organization_id IS DISTINCT FROM org OR f.branch_id IS DISTINCT FROM stay_record.branch_id
      OR (f.reservation_id IS NOT NULL AND f.reservation_id IS DISTINCT FROM _reservation))) THEN
    RAISE EXCEPTION 'Stay folios contain conflicting property or reservation ownership';
  END IF;

  -- Folios without reservation_id use their own collection lock in existing payment paths.
  FOR folio_record IN SELECT * FROM public.folios WHERE stay_id=stay_record.id AND organization_id=org ORDER BY id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(org::text||':reservation-collection:'||coalesce(folio_record.reservation_id,folio_record.id)::text,0));
  END LOOP;

  -- Existing canonical Finance counts a payment on its saved folio exactly once.
  -- Refuse ambiguous legacy cross-folio allocations instead of netting or guessing.
  IF EXISTS(SELECT 1 FROM public.payments p JOIN public.folios f ON f.id=p.folio_id
    WHERE f.stay_id=stay_record.id AND p.status IN ('confirmed','posted','completed')
      AND (p.organization_id IS DISTINCT FROM org OR p.currency IS DISTINCT FROM f.currency
        OR p.amount IS NULL OR p.amount::text IN ('NaN','Infinity','-Infinity') OR p.amount<>round(p.amount,2))) THEN
    RAISE EXCEPTION 'Confirmed folio collections require reconciliation';
  END IF;
  IF EXISTS(
    SELECT 1 FROM public.payment_allocations a
      JOIN public.payments p ON p.id=a.payment_id
      LEFT JOIN public.folios allocated ON allocated.id=a.folio_id
    WHERE (allocated.stay_id=stay_record.id OR p.folio_id IN (SELECT id FROM public.folios WHERE stay_id=stay_record.id))
      AND p.status IN ('confirmed','posted','completed')
      AND (a.organization_id IS DISTINCT FROM org OR p.organization_id IS DISTINCT FROM org
        OR allocated.organization_id IS DISTINCT FROM org OR allocated.branch_id IS DISTINCT FROM stay_record.branch_id
        OR p.folio_id IS DISTINCT FROM a.folio_id OR p.currency IS DISTINCT FROM allocated.currency
        OR a.amount IS NULL OR a.amount::text IN ('NaN','Infinity','-Infinity'))
  ) OR EXISTS(
    SELECT 1 FROM public.payments p WHERE p.folio_id IN (SELECT id FROM public.folios WHERE stay_id=stay_record.id)
      AND p.organization_id=org AND p.status IN ('confirmed','posted','completed')
      AND EXISTS(SELECT 1 FROM public.payment_allocations a WHERE a.payment_id=p.id)
      AND (SELECT sum(a.amount) FROM public.payment_allocations a WHERE a.payment_id=p.id) IS DISTINCT FROM p.amount
  ) THEN RAISE EXCEPTION 'Payment allocation requires per-folio reconciliation before checkout'; END IF;

  FOR folio_record IN SELECT * FROM public.folios WHERE stay_id=stay_record.id AND organization_id=org ORDER BY id FOR UPDATE LOOP
    IF nullif(btrim(folio_record.currency),'') IS NULL THEN RAISE EXCEPTION 'Folio currency is missing'; END IF;
    IF currency_code IS NULL THEN currency_code:=folio_record.currency;
    ELSIF currency_code IS DISTINCT FROM folio_record.currency THEN
      RAISE EXCEPTION 'Checkout requires reconciliation of mixed-currency folios';
    END IF;
    IF folio_record.status NOT IN ('open','under-review','reopened','settled','closed') OR folio_record.status IS NULL THEN
      RAISE EXCEPTION 'Folio % cannot be settled from status %',folio_record.id,folio_record.status;
    END IF;
    parts:=public.neo_folio_financial_components(folio_record.id,org);
    IF coalesce(parts->>'found','false')<>'true' OR parts->>'gross_obligation' IS NULL
      OR parts->>'collected' IS NULL OR parts->>'outstanding' IS NULL THEN
      RAISE EXCEPTION 'Checkout financial projection is incomplete';
    END IF;
    charges:=(parts->>'gross_obligation')::numeric;
    collected:=(parts->>'collected')::numeric;
    balance:=charges-collected;
    IF charges::text IN ('NaN','Infinity','-Infinity') OR collected::text IN ('NaN','Infinity','-Infinity')
      OR balance::text IN ('NaN','Infinity','-Infinity') OR (parts->>'outstanding')::numeric IS DISTINCT FROM balance THEN
      RAISE EXCEPTION 'Checkout financial amounts do not reconcile';
    END IF;
    charges:=round(charges,2); collected:=round(collected,2); balance:=round(charges-collected,2);
    IF balance<0 THEN RAISE EXCEPTION 'Folio % has a credit of %; resolve its refund or transfer before checkout',folio_record.id,-balance; END IF;
    IF balance>0 THEN
      IF NOT coalesce(_force,false) THEN RAISE EXCEPTION 'Folio % is not settled; outstanding balance %',folio_record.id,balance; END IF;
      IF NOT coalesce(public.has_permission('pms','folio.override') OR public.is_org_admin(),false) THEN
        RAISE EXCEPTION 'Checking out with an unsettled balance requires folio override authority';
      END IF;
      IF nullif(btrim(_notes),'') IS NULL THEN RAISE EXCEPTION 'A written reason is required to check out with an unsettled balance'; END IF;
      forced:=true;
    END IF;
    IF primary_folio IS NULL OR folio_record.folio_type='guest' THEN primary_folio:=folio_record.id; END IF;
    summaries:=summaries||jsonb_build_array(jsonb_build_object('folio_id',folio_record.id,
      'folio_number',folio_record.folio_number,'folio_type',folio_record.folio_type,'currency',folio_record.currency,
      'charges',charges,'collected',collected,'outstanding',balance,'status',CASE WHEN balance=0 THEN 'settled' ELSE 'under-review' END));
    total_charges:=total_charges+charges; total_collected:=total_collected+collected; total_outstanding:=total_outstanding+balance;
  END LOOP;
  IF jsonb_array_length(summaries)=0 THEN RAISE EXCEPTION 'No financial folio exists for this stay'; END IF;

  -- Apply only after every included folio passes. Operational failure rolls all summaries back.
  FOR summary IN SELECT value FROM jsonb_array_elements(summaries) LOOP
    UPDATE public.folios SET total_charges=(summary->>'charges')::numeric,
      total_payments=(summary->>'collected')::numeric,balance=(summary->>'outstanding')::numeric,
      status=summary->>'status',closed_at=CASE WHEN (summary->>'outstanding')::numeric=0 THEN coalesce(closed_at,now()) ELSE NULL END,
      updated_at=now() WHERE id=(summary->>'folio_id')::uuid AND organization_id=org;
  END LOOP;
  UPDATE public.stays SET status='checked-out',checked_out_at=now(),checked_out_by=auth.uid(),updated_at=now() WHERE id=stay_record.id AND organization_id=org;
  UPDATE public.reservations SET status='checked-out',payment_status=CASE WHEN total_outstanding=0 THEN 'paid' ELSE 'part-paid' END,
    updated_at=now() WHERE id=_reservation AND organization_id=org;
  UPDATE public.room_assignments SET status='released',updated_at=now()
    WHERE reservation_id=_reservation AND organization_id=org AND status='active';
  IF stay_record.room_id IS NOT NULL THEN
    previous_posting:=coalesce(current_setting('neo.system_posting',true),'off');
    BEGIN
      PERFORM set_config('neo.system_posting','on',true);
      -- Departure never releases an independently controlled maintenance hold.
      PERFORM public.ops_set_room_status(stay_record.room_id,'dirty',NULL,'Guest checked out','pms',_reservation,'vacant');
      PERFORM set_config('neo.system_posting',previous_posting,true);
    EXCEPTION WHEN OTHERS THEN
      PERFORM set_config('neo.system_posting',previous_posting,true);
      RAISE;
    END;
    IF NOT EXISTS(SELECT 1 FROM public.rooms r WHERE r.id=stay_record.room_id AND r.organization_id=org
      AND r.branch_id=stay_record.branch_id AND r.occupancy_status='vacant' AND r.housekeeping_status='dirty') THEN
      RAISE EXCEPTION 'Checkout room release was not saved; reconcile before retrying';
    END IF;
  END IF;
  INSERT INTO public.pms_workflow_events(organization_id,branch_id,event_type,reservation_id,stay_id,folio_id,idempotency_key,created_by)
    VALUES(org,stay_record.branch_id,'guest.checked-out',_reservation,stay_record.id,primary_folio,'checkout:'||_reservation::text,auth.uid())
    ON CONFLICT(organization_id,idempotency_key) DO NOTHING;
  result:=jsonb_build_object('ok',true,'reservation_id',_reservation,'stay_id',stay_record.id,'folio_id',primary_folio,
    'folio_count',jsonb_array_length(summaries),'folios',summaries,'charges',total_charges,'collected',total_collected,
    'outstanding',total_outstanding,'forced',forced,'idempotent',false,'room_state','vacant-dirty');
  INSERT INTO public.audit_logs(organization_id,branch_id,user_id,user_name,action,module,record_id,new_value,reason)
    VALUES(org,stay_record.branch_id,auth.uid(),'','pms.checkout','front-office',_reservation::text,result,_notes);
  RETURN result;
END;
$function$;
DO $verify$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN neo_multifolio_checkout_acl old
 WHERE p.oid='public.pms_check_out(uuid,boolean,text)'::regprocedure AND p.proowner=old.proowner AND coalesce(p.proacl::text,'')=old.acl) THEN
 RAISE EXCEPTION 'Checkout owner or grants changed'; END IF;
END $verify$;


DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=to_regprocedure('public.neo_minibar_post(uuid,uuid,jsonb,uuid,text)')
 AND r.rolname NOT IN ('anon','authenticated') AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g')) IN ('a915844bd162aa01add0d7ca60421979','02e573b16d42f6eadb1a8fbc3ee9c80a','c9e52620ae4b5ad21e6854b4994b93b3','e68e6e075ff34c023c793c39a1745a04')) THEN
 RAISE EXCEPTION 'Minibar engine differs from reviewed attempt source; nothing replaced'; END IF;
 IF to_regprocedure('public.next_document_number(text,text,uuid,uuid)') IS NULL THEN RAISE EXCEPTION 'Organization-scoped durable document numbering is missing'; END IF;
 IF to_regprocedure('public.neo_minibar_post_once(uuid,uuid,jsonb,uuid,text,uuid)') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pg_proc p
 WHERE p.oid=to_regprocedure('public.neo_minibar_post_once(uuid,uuid,jsonb,uuid,text,uuid)')
 AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g'))='ecf93bf89b68e7de581d383cbbba4bff') THEN
 RAISE EXCEPTION 'Minibar attempt wrapper differs from reviewed source'; END IF;
END $guard$;
DO $table_guard$ DECLARE columns_signature text[]; BEGIN
 IF to_regclass('public.minibar_posting_attempts') IS NOT NULL AND coalesce(obj_description(to_regclass('public.minibar_posting_attempts')),'')<>'neo.minibar.durable-attempts.v1' THEN
 RAISE EXCEPTION 'Unexpected preexisting minibar request table; reconcile before installation'; END IF;
 IF to_regclass('public.minibar_posting_attempts') IS NOT NULL THEN
  SELECT array_agg(a.attname::text||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull::text ORDER BY a.attnum)
   INTO columns_signature FROM pg_attribute a WHERE a.attrelid=to_regclass('public.minibar_posting_attempts') AND a.attnum>0 AND NOT a.attisdropped;
  IF columns_signature IS DISTINCT FROM ARRAY['organization_id:uuid:true','attempt_id:uuid:true','submitted_by:uuid:true','folio_id:uuid:true','location_id:uuid:true','room_id:uuid:true','request:jsonb:true','result:jsonb:false','created_at:timestamp with time zone:true']
   OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.minibar_posting_attempts') AND contype='p' AND pg_get_constraintdef(oid)='PRIMARY KEY (organization_id, attempt_id)')
   OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=to_regclass('public.minibar_posting_attempts'))
   OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.minibar_posting_attempts') AND NOT tgisinternal) THEN
   RAISE EXCEPTION 'Minibar request table differs from reviewed schema';
  END IF;
 END IF;
END $table_guard$;
CREATE TEMP TABLE neo_minibar_attempt_acl ON COMMIT DROP AS SELECT proowner,coalesce(proacl::text,'') acl FROM pg_proc WHERE oid='public.neo_minibar_post(uuid,uuid,jsonb,uuid,text)'::regprocedure;
CREATE TABLE IF NOT EXISTS public.minibar_posting_attempts(
 organization_id uuid NOT NULL,attempt_id uuid NOT NULL,submitted_by uuid NOT NULL,folio_id uuid NOT NULL,
 location_id uuid NOT NULL,room_id uuid NOT NULL,request jsonb NOT NULL,result jsonb,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,attempt_id)
);
COMMENT ON TABLE public.minibar_posting_attempts IS 'neo.minibar.durable-attempts.v1';
ALTER TABLE public.minibar_posting_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.minibar_posting_attempts FROM PUBLIC,anon,authenticated;
CREATE OR REPLACE FUNCTION public.neo_minibar_post(_folio uuid, _location uuid, _lines jsonb, _room uuid DEFAULT NULL::uuid, _notes text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_folio public.folios;
  v_loc public.stock_locations;
  v_posting uuid := gen_random_uuid();
  v_number text;
  v_line jsonb; v_idx integer := 0;
  v_menu public.menu_items;
  v_recipe public.recipes;
  v_stock public.stock_items;
  v_item uuid; v_qty numeric; v_price numeric; v_unit text; v_desc text;
  v_total numeric := 0; v_lines integer := 0;
  v_charge uuid; v_actor text;
  v_mode text; v_components jsonb; v_comp record; v_comp_idx integer;
  v_line_location uuid; v_ml numeric; v_batches numeric; v_store_name text; v_note text;
BEGIN
  SELECT * INTO v_folio FROM public.folios WHERE id = _folio FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'folio_not_found'); END IF;
  IF v_folio.organization_id IS DISTINCT FROM public.current_org_id() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;
  IF auth.uid() IS NULL OR public.has_permission('front-office', 'folios', 'create') IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_permitted');
  END IF;
  IF v_folio.branch_id IS NULL OR public.neo_branch_in_scope(v_folio.branch_id) IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;
  IF nullif(current_setting('neo.minibar_attempt',true),'') IS NULL OR NOT EXISTS(
    SELECT 1 FROM public.minibar_posting_attempts a WHERE a.organization_id=v_folio.organization_id
      AND a.attempt_id=nullif(current_setting('neo.minibar_attempt',true),'')::uuid AND a.submitted_by=auth.uid()
      AND a.result IS NULL AND a.folio_id=_folio AND a.location_id=_location AND a.room_id=_room
      AND a.request->'lines' IS NOT DISTINCT FROM _lines AND a.request->>'notes' IS NOT DISTINCT FROM _notes
  ) THEN RETURN jsonb_build_object('ok',false,'reason','attempt_required'); END IF;
  IF v_folio.status IS DISTINCT FROM 'open' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'folio_not_open', 'status', v_folio.status);
  END IF;

  SELECT * INTO v_loc FROM public.stock_locations WHERE id = _location;
  IF v_loc IS NULL OR v_loc.organization_id IS DISTINCT FROM v_folio.organization_id
     OR v_loc.branch_id IS DISTINCT FROM v_folio.branch_id OR v_loc.active IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'location_not_found');
  END IF;
  IF _lines IS NULL OR jsonb_typeof(_lines) IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_lines');
  END IF;
  IF jsonb_array_length(_lines) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_lines');
  END IF;

  -- Minibar itself is the authorised workflow actor for stock/folio side effects.
  PERFORM set_config('neo.system_posting', 'on', true);

  SELECT public.next_document_number('minibar_posting','MB',v_folio.branch_id,v_folio.organization_id) INTO v_number;

  SELECT COALESCE(p.full_name, p.email) INTO v_actor FROM public.profiles p WHERE p.id = auth.uid();

  INSERT INTO public.minibar_postings (id, organization_id, branch_id, posting_number, folio_id, room_id,
                                       location_id, currency, notes, posted_by)
  VALUES (v_posting, v_folio.organization_id, v_folio.branch_id, v_number, _folio, _room, _location,
          v_folio.currency, _notes, auth.uid());

  FOR v_line IN SELECT * FROM jsonb_array_elements(_lines)
  LOOP
    v_idx := v_idx + 1;
    v_qty := COALESCE((v_line->>'quantity')::numeric, 0);
    IF v_qty::text IN ('NaN','Infinity','-Infinity') OR v_qty <= 0 THEN
      RAISE EXCEPTION 'Minibar line % has no quantity', v_idx USING ERRCODE = 'data_exception';
    END IF;

    v_menu := NULL; v_recipe := NULL; v_stock := NULL; v_components := NULL;
    IF v_line ? 'menu_item_id' AND NULLIF(v_line->>'menu_item_id', '') IS NOT NULL THEN
      SELECT * INTO v_menu FROM public.menu_items
       WHERE id = (v_line->>'menu_item_id')::uuid AND organization_id = v_folio.organization_id;
      IF v_menu IS NULL THEN
        RAISE EXCEPTION 'Minibar line % refers to an unknown menu item', v_idx USING ERRCODE = 'data_exception';
      END IF;
      IF (v_menu.branch_id IS NOT NULL AND v_menu.branch_id IS DISTINCT FROM v_folio.branch_id)
         OR (coalesce(array_length(v_menu.consumption_channels, 1), 0) > 0
             AND ('minibar' = ANY(v_menu.consumption_channels)) IS NOT TRUE) THEN
        RAISE EXCEPTION 'Minibar line % is not available for this property and channel', v_idx USING ERRCODE = '23514';
      END IF;
      SELECT * INTO v_recipe FROM public.recipes
       WHERE organization_id = v_folio.organization_id
         AND menu_item_id = v_menu.id
         AND recipe_type IN ('menu_item','direct_sale')
         AND status = 'active'
       ORDER BY (recipe_type = 'menu_item') DESC, version DESC LIMIT 1;
    END IF;

    v_price := COALESCE(NULLIF(v_line->>'unit_price', '')::numeric, v_menu.base_price);
    IF v_price IS NULL OR v_price::text IN ('NaN','Infinity','-Infinity') OR v_price < 0 THEN
      RAISE EXCEPTION 'Minibar line % has no price', v_idx USING ERRCODE = 'data_exception';
    END IF;

    IF v_menu.id IS NOT NULL AND (v_menu.base_price IS NULL OR v_price IS DISTINCT FROM v_menu.base_price) THEN
      RAISE EXCEPTION 'Minibar menu price changed; refresh the item before posting' USING ERRCODE = '23514';
    END IF;

    -- Which consumption model applies: an explicit stock item, the menu item's
    -- own mode, or the recipe attached to it. Never guessed.
    v_item := NULLIF(v_line->>'stock_item_id', '')::uuid;
    v_mode := COALESCE(NULLIF(v_menu.consumption_mode, ''), 'none');
    IF v_item IS NOT NULL THEN
      v_mode := 'direct_stock';
    ELSIF v_mode = 'none' AND v_recipe IS NOT NULL THEN
      v_mode := CASE WHEN v_recipe.recipe_type = 'direct_sale' THEN 'direct_stock' ELSE 'recipe' END;
    END IF;

    IF v_mode IN ('direct_stock','batch') THEN
      v_item := COALESCE(v_item, v_menu.stock_item_id, v_recipe.output_stock_item_id);
      IF v_item IS NULL THEN
        RAISE EXCEPTION 'Minibar line % (%) is not mapped to a stock item', v_idx,
          COALESCE(v_menu.name, 'item') USING ERRCODE = 'data_exception';
      END IF;
      SELECT * INTO v_stock FROM public.stock_items
       WHERE id = v_item AND organization_id = v_folio.organization_id;
      IF v_stock IS NULL THEN
        RAISE EXCEPTION 'Minibar line % refers to an unknown stock item', v_idx USING ERRCODE = 'data_exception';
      END IF;
      v_unit := COALESCE(NULLIF(v_line->>'unit', ''), NULLIF(v_menu.stock_unit, ''),
                         NULLIF(v_recipe.yield_unit, ''), v_stock.base_unit, 'unit');
      v_components := jsonb_build_array(jsonb_build_object(
        'item_id', v_item,
        'qty', public.inventory_round_for_item(
                 v_qty * COALESCE(NULLIF(v_menu.stock_quantity_per_sale, 0),
                                  NULLIF(v_recipe.yield_quantity, 0), 1), v_unit, v_item),
        'unit', v_unit,
        'kind', 'use'));
    ELSIF v_mode = 'recipe' THEN
      IF v_recipe IS NULL OR COALESCE(v_recipe.yield_quantity, 0) <= 0 THEN
        RAISE EXCEPTION 'Minibar line % (%) has no usable recipe', v_idx,
          COALESCE(v_menu.name, 'item') USING ERRCODE = 'data_exception';
      END IF;
      v_batches := v_qty / v_recipe.yield_quantity;
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'item_id', x.stock_item_id, 'qty', x.qty, 'unit', x.unit, 'kind', x.kind)), '[]'::jsonb)
        INTO v_components
        FROM (SELECT e.stock_item_id, e.kind, sum(e.quantity) AS qty, min(e.unit) AS unit
                FROM public.recipe_expand_to_stock_kinds(v_recipe.id, v_batches, v_folio.branch_id) e
               GROUP BY e.stock_item_id, e.kind) x;
      IF v_components IS NULL OR jsonb_array_length(v_components) = 0 THEN
        RAISE EXCEPTION 'Minibar line % (%) has a recipe with no ingredients', v_idx,
          COALESCE(v_menu.name, 'item') USING ERRCODE = 'data_exception';
      END IF;
      v_item := COALESCE(v_menu.stock_item_id, (v_components->0->>'item_id')::uuid);
      v_unit := COALESCE(NULLIF(v_line->>'unit', ''), NULLIF(v_recipe.yield_unit, ''), 'unit');
    ELSE
      RAISE EXCEPTION 'Minibar line % (%) is not mapped to stock', v_idx,
        COALESCE(v_menu.name, 'item') USING ERRCODE = 'data_exception';
    END IF;

    v_desc := COALESCE(NULLIF(v_line->>'description', ''), v_menu.name, 'Minibar item');

    v_comp_idx := 0;
    FOR v_comp IN
      SELECT (e->>'item_id')::uuid AS item_id, (e->>'qty')::numeric AS qty, e->>'unit' AS unit,
             COALESCE(e->>'kind','use') AS kind
        FROM jsonb_array_elements(v_components) e
    LOOP
      v_comp_idx := v_comp_idx + 1;
      SELECT * INTO v_stock FROM public.stock_items WHERE id = v_comp.item_id;
      IF v_stock IS NULL THEN
        RAISE EXCEPTION 'Minibar line % refers to an unknown stock item', v_idx USING ERRCODE = 'data_exception';
      END IF;

      -- A minibar posting consumes from the explicitly selected property store.
      -- Bar menu defaults and catalogue group fallbacks must not override it.
      v_line_location := _location;
      SELECT sl.name INTO v_store_name FROM public.stock_locations sl WHERE sl.id = v_line_location;

      v_note := CASE WHEN v_comp.kind = 'waste' THEN 'Minibar wastage allowance · ' ELSE 'Minibar ' END
                || v_number || ' · ' || v_desc
                || ' · folio ' || COALESCE(v_folio.folio_number, _folio::text)
                || CASE WHEN v_store_name IS NOT NULL THEN ' · from ' || v_store_name ELSE '' END
                || CASE WHEN v_actor IS NOT NULL THEN ' · recorded by ' || v_actor ELSE '' END;

      IF lower(COALESCE(v_comp.unit,'')) IN ('ml','millilitre','millilitres','cl','l','litre','litres')
         AND COALESCE(v_stock.tracking_method,'whole') IN ('volume','both')
         AND COALESCE(v_stock.container_volume_ml,0) > 0 THEN
        v_ml := v_comp.qty * CASE lower(v_comp.unit)
                               WHEN 'cl' THEN 10
                               WHEN 'l' THEN 1000 WHEN 'litre' THEN 1000 WHEN 'litres' THEN 1000
                               ELSE 1 END;
        PERFORM public.inventory_consume_volume(
          v_comp.item_id, v_line_location, v_ml, v_note,
          CASE WHEN v_comp.kind = 'waste' THEN 'wastage' ELSE 'pour' END,
          'minibar_posting', v_posting,
          'minibar-pour:' || v_posting::text || ':' || v_idx::text || ':' || v_comp.item_id::text
            || ':' || v_comp.kind);
      ELSE
        PERFORM public.inventory_apply_movement(
          v_comp.item_id, v_line_location, -v_comp.qty,
          COALESCE(NULLIF(v_comp.unit,''), v_stock.base_unit, 'unit'),
          CASE WHEN v_comp.kind = 'waste' THEN 'wastage' ELSE 'consumption' END,
          COALESCE(v_stock.average_cost, 0),
          'minibar_posting', v_posting, v_note,
          'minibar:' || v_posting::text || ':' || v_idx::text || ':' || v_comp.item_id::text
            || ':' || v_comp.kind, NULL, NULL);
      END IF;

      PERFORM public.neo_evaluate_low_stock(v_folio.organization_id, v_folio.branch_id,
                                            v_comp.item_id, 'minibar', v_posting);
    END LOOP;

    v_charge := public.folio_post_charge(
      _folio, 'minibar', v_desc, v_qty, v_price, 0, 0, 0,
      'minibar', v_posting, 'minibar',
      'minibar:' || v_posting::text || ':' || v_idx::text, NULL);

    INSERT INTO public.minibar_posting_lines (organization_id, posting_id, menu_item_id, stock_item_id,
                                              description, quantity, unit, unit_price, amount, folio_line_id)
    VALUES (v_folio.organization_id, v_posting, v_menu.id, v_item, v_desc, v_qty,
            COALESCE(v_unit, 'unit'), v_price, v_qty * v_price, v_charge);

    v_total := v_total + v_qty * v_price;
    v_lines := v_lines + 1;
  END LOOP;

  UPDATE public.minibar_postings SET total_amount = v_total, updated_at = now() WHERE id = v_posting;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, action, module, record_id, new_value)
  VALUES (v_folio.organization_id, v_folio.branch_id, auth.uid(), 'pms.minibar.posted', 'front-office',
          v_posting::text,
          jsonb_build_object('posting_number', v_number, 'folio_id', _folio, 'room_id', _room,
                             'location_id', _location, 'lines', v_lines, 'total', v_total,
                             'posted_by', COALESCE(v_actor, 'system')));

  PERFORM set_config('neo.system_posting', 'off', true);
  RETURN jsonb_build_object('ok', true, 'posting_id', v_posting, 'posting_number', v_number,
                            'lines', v_lines, 'total', v_total);
END;
$function$;
CREATE OR REPLACE FUNCTION public.neo_minibar_post_once(
  _folio uuid,_location uuid,_lines jsonb,_room uuid,_notes text,_attempt uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
AS $function$
DECLARE
  org uuid:=public.current_org_id();
  folio_record public.folios;
  stay_record public.stays;
  prior public.minibar_posting_attempts;
  request jsonb:=jsonb_build_object('folio',_folio,'location',_location,'lines',_lines,'room',_room,'notes',_notes);
  response jsonb;
  previous_attempt text;
  previous_posting text;
BEGIN
  IF auth.uid() IS NULL OR org IS NULL OR public.has_permission('front-office','folios','create') IS NOT TRUE THEN
    RAISE EXCEPTION 'Not permitted to post minibar consumption' USING ERRCODE='42501';
  END IF;
  IF _attempt IS NULL THEN RAISE EXCEPTION 'A durable minibar attempt key is required'; END IF;
  SELECT * INTO folio_record FROM public.folios WHERE id=_folio AND organization_id=org FOR UPDATE;
  IF folio_record.id IS NULL OR NOT coalesce(public.neo_branch_in_scope(folio_record.branch_id),false) THEN
    RAISE EXCEPTION 'Minibar folio is outside your property scope' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(org::text||':minibar-attempt:'||_attempt::text,0));
  SELECT * INTO prior FROM public.minibar_posting_attempts WHERE organization_id=org AND attempt_id=_attempt;
  IF prior.attempt_id IS NOT NULL THEN
    IF prior.request IS DISTINCT FROM request THEN
      RAISE EXCEPTION 'Minibar attempt belongs to different work. Review saved posting % before starting a separate charge',prior.result->>'posting_number';
    END IF;
    IF prior.result IS NULL OR prior.result->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Minibar attempt needs reconciliation'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.minibar_postings p WHERE p.id=(prior.result->>'posting_id')::uuid
      AND p.organization_id=org AND p.folio_id=_folio AND p.location_id=_location AND p.room_id=prior.room_id
      AND p.posting_number=prior.result->>'posting_number' AND p.total_amount=(prior.result->>'total')::numeric)
      OR (SELECT count(*) FROM public.minibar_posting_lines l WHERE l.posting_id=(prior.result->>'posting_id')::uuid
        AND l.organization_id=org) IS DISTINCT FROM (prior.result->>'lines')::bigint THEN
      RAISE EXCEPTION 'Saved minibar posting evidence is missing; reconcile before retrying';
    END IF;
    RETURN prior.result||jsonb_build_object('replayed',true);
  END IF;
  IF folio_record.status IS DISTINCT FROM 'open' THEN RAISE EXCEPTION 'Minibar folio is not open'; END IF;
  IF _lines IS NULL OR jsonb_typeof(_lines) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Minibar items are required'; END IF;
  IF jsonb_array_length(_lines) NOT BETWEEN 1 AND 100 OR length(coalesce(_notes,''))>2000 THEN RAISE EXCEPTION 'Minibar draft is too large or empty'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.stock_locations s WHERE s.id=_location AND s.organization_id=org
    AND s.branch_id=folio_record.branch_id AND s.active IS TRUE AND s.location_type='minibar') THEN
    RAISE EXCEPTION 'Choose an active store explicitly configured as Minibar for this property';
  END IF;
  SELECT * INTO stay_record FROM public.stays WHERE id=folio_record.stay_id AND organization_id=org FOR UPDATE;
  IF stay_record.id IS NULL OR stay_record.branch_id IS DISTINCT FROM folio_record.branch_id
    OR coalesce(stay_record.status,'') NOT IN ('checked-in','checked_in','in-house','in_house')
    OR (folio_record.reservation_id IS NOT NULL AND stay_record.reservation_id IS DISTINCT FROM folio_record.reservation_id)
    OR stay_record.room_id IS NULL OR (_room IS NOT NULL AND _room IS DISTINCT FROM stay_record.room_id)
    OR NOT EXISTS(SELECT 1 FROM public.rooms r WHERE r.id=stay_record.room_id AND r.organization_id=org AND r.branch_id=folio_record.branch_id) THEN
    RAISE EXCEPTION 'Minibar room must match this folio current in-house stay';
  END IF;

  INSERT INTO public.minibar_posting_attempts(organization_id,attempt_id,submitted_by,folio_id,location_id,room_id,request)
    VALUES(org,_attempt,auth.uid(),_folio,_location,stay_record.room_id,request);
  previous_attempt:=coalesce(current_setting('neo.minibar_attempt',true),'');
  previous_posting:=coalesce(current_setting('neo.system_posting',true),'off');
  BEGIN
    PERFORM set_config('neo.minibar_attempt',_attempt::text,true);
    response:=public.neo_minibar_post(_folio,_location,_lines,stay_record.room_id,_notes);
    PERFORM set_config('neo.minibar_attempt',previous_attempt,true);
    PERFORM set_config('neo.system_posting',previous_posting,true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('neo.minibar_attempt',previous_attempt,true);
    PERFORM set_config('neo.system_posting',previous_posting,true);
    RAISE;
  END;
  IF response->>'ok' IS DISTINCT FROM 'true' OR nullif(response->>'posting_id','') IS NULL
    OR NOT EXISTS(SELECT 1 FROM public.minibar_postings p WHERE p.id=(response->>'posting_id')::uuid
      AND p.organization_id=org AND p.folio_id=_folio AND p.location_id=_location AND p.room_id=stay_record.room_id
      AND p.total_amount=(response->>'total')::numeric) THEN
    RAISE EXCEPTION 'Minibar command did not confirm its saved posting: %',response;
  END IF;
  response:=response||jsonb_build_object('attempt_id',_attempt,'folio_id',_folio,'location_id',_location,'room_id',stay_record.room_id,'replayed',false);
  UPDATE public.minibar_posting_attempts SET result=response WHERE organization_id=org AND attempt_id=_attempt;
  RETURN response;
END;
$function$;
DO $owner$ DECLARE engine_owner text; BEGIN
 SELECT r.rolname INTO engine_owner FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='public.neo_minibar_post(uuid,uuid,jsonb,uuid,text)'::regprocedure;
 EXECUTE format('ALTER TABLE public.minibar_posting_attempts OWNER TO %I',engine_owner);
 EXECUTE format('ALTER FUNCTION public.neo_minibar_post_once(uuid,uuid,jsonb,uuid,text,uuid) OWNER TO %I',engine_owner);
END $owner$;
REVOKE ALL ON FUNCTION public.neo_minibar_post_once(uuid,uuid,jsonb,uuid,text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.neo_minibar_post_once(uuid,uuid,jsonb,uuid,text,uuid) TO authenticated;
DO $verify$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN neo_minibar_attempt_acl old WHERE p.oid='public.neo_minibar_post(uuid,uuid,jsonb,uuid,text)'::regprocedure
 AND p.proowner=old.proowner AND coalesce(p.proacl::text,'')=old.acl) THEN RAISE EXCEPTION 'Minibar engine owner or grants changed'; END IF;
END $verify$;
NOTIFY pgrst,'reload schema';

NOTIFY pgrst,'reload schema';
COMMIT;
SELECT jsonb_build_object(
 'checkout_body_hash',(SELECT md5(regexp_replace(regexp_replace(prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g')) FROM pg_proc WHERE oid=to_regprocedure('public.pms_check_out(uuid,boolean,text)')),
 'minibar_retry_function',to_regprocedure('public.neo_minibar_post_once(uuid,uuid,jsonb,uuid,text,uuid)')::text,
 'retry_table',to_regclass('public.minibar_posting_attempts')::text,
 'staff_minibar',has_function_privilege('authenticated','public.neo_minibar_post_once(uuid,uuid,jsonb,uuid,text,uuid)','EXECUTE'),
 'anonymous_minibar',has_function_privilege('anon','public.neo_minibar_post_once(uuid,uuid,jsonb,uuid,text,uuid)','EXECUTE')
) AS shared_rollout_result;
