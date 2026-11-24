-- STAGED ONLY. Coordinated client/server release: new requests use neo_minibar_post_once.
-- Old posting signature refuses direct unkeyed requests; grants/owner are retained.
-- Installation performs no stock movement, folio charge or historical rewrite.
BEGIN;
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
COMMIT;
