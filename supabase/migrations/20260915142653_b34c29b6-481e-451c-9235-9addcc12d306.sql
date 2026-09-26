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
  SELECT * INTO v_folio FROM public.folios WHERE id = _folio;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'folio_not_found'); END IF;
  IF v_folio.organization_id IS DISTINCT FROM public.current_org_id() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;
  IF NOT public.has_permission('front-office', 'folios', 'create') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_permitted');
  END IF;
  IF v_folio.status <> 'open' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'folio_not_open', 'status', v_folio.status);
  END IF;

  SELECT * INTO v_loc FROM public.stock_locations WHERE id = _location;
  IF v_loc IS NULL OR v_loc.organization_id IS DISTINCT FROM v_folio.organization_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'location_not_found');
  END IF;
  IF _lines IS NULL OR jsonb_array_length(_lines) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_lines');
  END IF;

  SELECT 'MB-' || to_char(now(), 'YYMM') || '-' ||
         lpad((count(*) + 1)::text, 5, '0') INTO v_number
    FROM public.minibar_postings
   WHERE organization_id = v_folio.organization_id;

  SELECT COALESCE(p.full_name, p.email) INTO v_actor FROM public.profiles p WHERE p.id = auth.uid();

  INSERT INTO public.minibar_postings (id, organization_id, branch_id, posting_number, folio_id, room_id,
                                       location_id, currency, notes, posted_by)
  VALUES (v_posting, v_folio.organization_id, v_folio.branch_id, v_number, _folio, _room, _location,
          v_folio.currency, _notes, auth.uid());

  FOR v_line IN SELECT * FROM jsonb_array_elements(_lines)
  LOOP
    v_idx := v_idx + 1;
    v_qty := COALESCE((v_line->>'quantity')::numeric, 0);
    IF v_qty <= 0 THEN
      RAISE EXCEPTION 'Minibar line % has no quantity', v_idx USING ERRCODE = 'data_exception';
    END IF;

    v_menu := NULL; v_recipe := NULL; v_stock := NULL; v_components := NULL;
    IF v_line ? 'menu_item_id' AND NULLIF(v_line->>'menu_item_id', '') IS NOT NULL THEN
      SELECT * INTO v_menu FROM public.menu_items
       WHERE id = (v_line->>'menu_item_id')::uuid AND organization_id = v_folio.organization_id;
      IF v_menu IS NULL THEN
        RAISE EXCEPTION 'Minibar line % refers to an unknown menu item', v_idx USING ERRCODE = 'data_exception';
      END IF;
      SELECT * INTO v_recipe FROM public.recipes
       WHERE organization_id = v_folio.organization_id
         AND menu_item_id = v_menu.id
         AND recipe_type IN ('menu_item','direct_sale')
         AND status = 'active'
       ORDER BY (recipe_type = 'menu_item') DESC, version DESC LIMIT 1;
    END IF;

    v_price := COALESCE(NULLIF(v_line->>'unit_price', '')::numeric, v_menu.base_price);
    IF v_price IS NULL THEN
      RAISE EXCEPTION 'Minibar line % has no price', v_idx USING ERRCODE = 'data_exception';
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

      v_line_location := COALESCE(
        v_menu.issuing_location_id,
        public.neo_item_group_store(v_folio.organization_id, v_comp.item_id, v_folio.branch_id),
        _location);
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

  RETURN jsonb_build_object('ok', true, 'posting_id', v_posting, 'posting_number', v_number,
                            'lines', v_lines, 'total', v_total);
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_minibar_post(uuid, uuid, jsonb, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_minibar_post(uuid, uuid, jsonb, uuid, text) TO authenticated, service_role;