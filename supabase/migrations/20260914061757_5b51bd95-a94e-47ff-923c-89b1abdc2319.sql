
-- ============================================================
-- 1. Kitchen production batches → stock
-- ============================================================

ALTER TABLE public.production_batches
  ADD COLUMN IF NOT EXISTS output_location_id uuid REFERENCES public.stock_locations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS posted_at timestamptz,
  ADD COLUMN IF NOT EXISTS posted_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS posted_cost numeric;

CREATE OR REPLACE FUNCTION public.neo_production_batch_post(_batch uuid, _location uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_b public.production_batches;
  v_recipe public.recipes;
  v_stock public.stock_items;
  v_comp record;
  v_loc uuid; v_line_loc uuid;
  v_batches numeric; v_cost numeric := 0; v_lines integer := 0;
  v_unit text;
BEGIN
  SELECT * INTO v_b FROM public.production_batches WHERE id = _batch;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF v_b.organization_id IS DISTINCT FROM public.current_org_id() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;
  IF NOT (public.has_permission('kitchen', 'production', 'edit')
          OR public.has_permission('stores', 'issues', 'create')) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_permitted');
  END IF;
  IF v_b.posted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_posted', 'posted_at', v_b.posted_at);
  END IF;
  IF COALESCE(v_b.actual_quantity, 0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_actual_quantity');
  END IF;

  SELECT * INTO v_recipe FROM public.recipes WHERE id = v_b.recipe_id;
  IF v_recipe IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_recipe'); END IF;
  IF v_recipe.output_stock_item_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_output_stock_item');
  END IF;
  IF COALESCE(v_recipe.yield_quantity, 0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_yield');
  END IF;

  v_loc := COALESCE(_location, v_b.output_location_id,
                    public.neo_station_consumption_location(v_b.organization_id, v_b.station_id, v_b.branch_id));
  IF v_loc IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_location'); END IF;

  v_batches := v_b.actual_quantity / v_recipe.yield_quantity;

  FOR v_comp IN
    SELECT e.stock_item_id AS item_id, sum(e.quantity) AS qty, min(e.unit) AS unit
      FROM public.recipe_expand_to_stock(v_recipe.id, v_batches, v_b.branch_id) e
     GROUP BY e.stock_item_id
  LOOP
    SELECT * INTO v_stock FROM public.stock_items WHERE id = v_comp.item_id;
    v_line_loc := COALESCE(public.neo_item_group_store(v_b.organization_id, v_comp.item_id, v_b.branch_id), v_loc);

    PERFORM public.inventory_apply_movement(
      v_comp.item_id, v_line_loc, -v_comp.qty, v_comp.unit, 'consumption',
      COALESCE(v_stock.average_cost, 0), 'production_batch', _batch,
      'Production batch ' || COALESCE(v_b.batch_number, _batch::text)
        || ' · ' || COALESCE(v_recipe.name, 'recipe'),
      'batchuse:' || _batch::text || ':' || v_comp.item_id::text, NULL, NULL);

    INSERT INTO public.batch_ingredient_usage (organization_id, batch_id, ingredient_name, quantity, unit, unit_cost)
    VALUES (v_b.organization_id, _batch, COALESCE(v_stock.name, 'Ingredient'), v_comp.qty, v_comp.unit,
            COALESCE(v_stock.average_cost, 0));

    v_cost := v_cost + v_comp.qty * COALESCE(v_stock.average_cost, 0);
    v_lines := v_lines + 1;
    PERFORM public.neo_evaluate_low_stock(v_b.organization_id, v_b.branch_id, v_comp.item_id, 'production', _batch);
  END LOOP;

  v_unit := COALESCE(NULLIF(v_b.unit, ''), NULLIF(v_recipe.yield_unit, ''), 'portion');

  PERFORM public.inventory_apply_movement(
    v_recipe.output_stock_item_id, v_loc, v_b.actual_quantity, v_unit, 'receipt',
    CASE WHEN v_b.actual_quantity > 0 THEN v_cost / v_b.actual_quantity ELSE 0 END,
    'production_batch', _batch,
    'Produced batch ' || COALESCE(v_b.batch_number, _batch::text) || ' · ' || COALESCE(v_recipe.name, 'recipe'),
    'batchout:' || _batch::text, v_b.batch_number, (v_b.use_by)::date);

  IF COALESCE(v_b.waste_quantity, 0) > 0 THEN
    PERFORM public.inventory_apply_movement(
      v_recipe.output_stock_item_id, v_loc, -v_b.waste_quantity, v_unit, 'waste',
      CASE WHEN v_b.actual_quantity > 0 THEN v_cost / v_b.actual_quantity ELSE 0 END,
      'production_batch', _batch,
      'Production waste · batch ' || COALESCE(v_b.batch_number, _batch::text),
      'batchwaste:' || _batch::text, NULL, NULL);
  END IF;

  UPDATE public.production_batches
     SET posted_at = now(), posted_by = auth.uid(), output_location_id = v_loc,
         posted_cost = v_cost, updated_at = now()
   WHERE id = _batch;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, action, module, record_id, new_value)
  VALUES (v_b.organization_id, v_b.branch_id, auth.uid(), 'kitchen.production.posted', 'kitchen', _batch::text,
          jsonb_build_object('batch_number', v_b.batch_number, 'produced', v_b.actual_quantity,
                             'unit', v_unit, 'ingredient_lines', v_lines, 'cost', v_cost,
                             'location_id', v_loc, 'output_stock_item_id', v_recipe.output_stock_item_id));

  RETURN jsonb_build_object('ok', true, 'ingredient_lines', v_lines, 'cost', v_cost,
                            'produced', v_b.actual_quantity, 'unit', v_unit, 'location_id', v_loc);
END;
$$;

REVOKE ALL ON FUNCTION public.neo_production_batch_post(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_production_batch_post(uuid, uuid) TO authenticated;

-- ============================================================
-- 2. Minibar
-- ============================================================

CREATE TABLE IF NOT EXISTS public.minibar_postings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  posting_number text NOT NULL,
  folio_id uuid NOT NULL REFERENCES public.folios(id) ON DELETE RESTRICT,
  room_id uuid REFERENCES public.rooms(id) ON DELETE SET NULL,
  location_id uuid REFERENCES public.stock_locations(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'posted',
  currency text,
  total_amount numeric NOT NULL DEFAULT 0,
  notes text,
  posted_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  posted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, posting_number)
);

CREATE TABLE IF NOT EXISTS public.minibar_posting_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  posting_id uuid NOT NULL REFERENCES public.minibar_postings(id) ON DELETE CASCADE,
  menu_item_id uuid REFERENCES public.menu_items(id) ON DELETE SET NULL,
  stock_item_id uuid REFERENCES public.stock_items(id) ON DELETE SET NULL,
  description text NOT NULL,
  quantity numeric NOT NULL CHECK (quantity > 0),
  unit text,
  unit_price numeric NOT NULL DEFAULT 0,
  amount numeric NOT NULL DEFAULT 0,
  folio_line_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS minibar_postings_org_branch_idx ON public.minibar_postings (organization_id, branch_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS minibar_posting_lines_posting_idx ON public.minibar_posting_lines (posting_id);

GRANT SELECT ON public.minibar_postings TO authenticated;
GRANT SELECT ON public.minibar_posting_lines TO authenticated;
GRANT ALL ON public.minibar_postings TO service_role;
GRANT ALL ON public.minibar_posting_lines TO service_role;

ALTER TABLE public.minibar_postings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.minibar_posting_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "minibar_postings_read" ON public.minibar_postings
  FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id()
         AND (branch_id IS NULL OR branch_id = ANY (public.current_branch_ids()))
         AND public.has_permission('front-office', 'folios', 'view'));

CREATE POLICY "minibar_posting_lines_read" ON public.minibar_posting_lines
  FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id()
         AND EXISTS (SELECT 1 FROM public.minibar_postings p
                      WHERE p.id = posting_id
                        AND p.organization_id = public.current_org_id()
                        AND (p.branch_id IS NULL OR p.branch_id = ANY (public.current_branch_ids()))));

CREATE TRIGGER minibar_postings_touch
  BEFORE UPDATE ON public.minibar_postings
  FOR EACH ROW EXECUTE FUNCTION public.fin_touch_updated_at();

-- Post a minibar consumption: stock out of the minibar store, charge on the folio.
CREATE OR REPLACE FUNCTION public.neo_minibar_post(
  _folio uuid,
  _location uuid,
  _lines jsonb,
  _room uuid DEFAULT NULL,
  _notes text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_folio public.folios;
  v_loc public.stock_locations;
  v_posting uuid := gen_random_uuid();
  v_number text;
  v_line jsonb; v_idx integer := 0;
  v_menu public.menu_items;
  v_stock public.stock_items;
  v_item uuid; v_qty numeric; v_price numeric; v_unit text; v_desc text;
  v_total numeric := 0; v_lines integer := 0;
  v_charge uuid; v_actor text;
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

    v_menu := NULL; v_stock := NULL;
    IF v_line ? 'menu_item_id' AND NULLIF(v_line->>'menu_item_id', '') IS NOT NULL THEN
      SELECT * INTO v_menu FROM public.menu_items
       WHERE id = (v_line->>'menu_item_id')::uuid AND organization_id = v_folio.organization_id;
      IF v_menu IS NULL THEN
        RAISE EXCEPTION 'Minibar line % refers to an unknown menu item', v_idx USING ERRCODE = 'data_exception';
      END IF;
    END IF;

    v_item := COALESCE(NULLIF(v_line->>'stock_item_id', '')::uuid, v_menu.stock_item_id);
    IF v_item IS NULL THEN
      RAISE EXCEPTION 'Minibar line % is not mapped to a stock item', v_idx USING ERRCODE = 'data_exception';
    END IF;
    SELECT * INTO v_stock FROM public.stock_items
     WHERE id = v_item AND organization_id = v_folio.organization_id;
    IF v_stock IS NULL THEN
      RAISE EXCEPTION 'Minibar line % refers to an unknown stock item', v_idx USING ERRCODE = 'data_exception';
    END IF;

    v_price := COALESCE(NULLIF(v_line->>'unit_price', '')::numeric, v_menu.base_price);
    IF v_price IS NULL THEN
      RAISE EXCEPTION 'Minibar line % has no price', v_idx USING ERRCODE = 'data_exception';
    END IF;
    v_unit := COALESCE(NULLIF(v_line->>'unit', ''), NULLIF(v_menu.stock_unit, ''), v_stock.base_unit, 'unit');
    v_desc := COALESCE(NULLIF(v_line->>'description', ''), v_menu.name, v_stock.name, 'Minibar item');

    PERFORM public.inventory_apply_movement(
      v_item, _location,
      -(v_qty * COALESCE(NULLIF(v_menu.stock_quantity_per_sale, 0), 1)),
      v_unit, 'consumption', COALESCE(v_stock.average_cost, 0),
      'minibar_posting', v_posting,
      'Minibar ' || v_number || ' · ' || v_desc || ' · folio ' || COALESCE(v_folio.folio_number, _folio::text),
      'minibar:' || v_posting::text || ':' || v_idx::text, NULL, NULL);

    v_charge := public.folio_post_charge(
      _folio, 'minibar', v_desc, v_qty, v_price, 0, 0, 0,
      'minibar', v_posting, 'minibar',
      'minibar:' || v_posting::text || ':' || v_idx::text, NULL);

    INSERT INTO public.minibar_posting_lines (organization_id, posting_id, menu_item_id, stock_item_id,
                                              description, quantity, unit, unit_price, amount, folio_line_id)
    VALUES (v_folio.organization_id, v_posting, v_menu.id, v_item, v_desc, v_qty, v_unit, v_price,
            v_qty * v_price, v_charge);

    v_total := v_total + v_qty * v_price;
    v_lines := v_lines + 1;
    PERFORM public.neo_evaluate_low_stock(v_folio.organization_id, v_folio.branch_id, v_item, 'minibar', v_posting);
  END LOOP;

  UPDATE public.minibar_postings SET total_amount = v_total, updated_at = now() WHERE id = v_posting;

  SELECT COALESCE(p.full_name, p.email) INTO v_actor FROM public.profiles p WHERE p.id = auth.uid();

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, action, module, record_id, new_value)
  VALUES (v_folio.organization_id, v_folio.branch_id, auth.uid(), 'pms.minibar.posted', 'front-office',
          v_posting::text,
          jsonb_build_object('posting_number', v_number, 'folio_id', _folio, 'room_id', _room,
                             'location_id', _location, 'lines', v_lines, 'total', v_total,
                             'posted_by', COALESCE(v_actor, 'system')));

  RETURN jsonb_build_object('ok', true, 'posting_id', v_posting, 'posting_number', v_number,
                            'lines', v_lines, 'total', v_total);
END;
$$;

REVOKE ALL ON FUNCTION public.neo_minibar_post(uuid, uuid, jsonb, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_minibar_post(uuid, uuid, jsonb, uuid, text) TO authenticated;
