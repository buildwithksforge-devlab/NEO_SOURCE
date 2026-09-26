ALTER TABLE public.waste_records
  ADD COLUMN IF NOT EXISTS stock_item_id uuid REFERENCES public.stock_items(id),
  ADD COLUMN IF NOT EXISTS location_id uuid REFERENCES public.stock_locations(id),
  ADD COLUMN IF NOT EXISTS posted_at timestamptz,
  ADD COLUMN IF NOT EXISTS posted_by uuid,
  ADD COLUMN IF NOT EXISTS posted_cost numeric;

CREATE OR REPLACE FUNCTION public.neo_kitchen_waste_post(_waste uuid, _location uuid DEFAULT NULL::uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_w public.waste_records;
  v_item uuid;
  v_unit text;
  v_qty numeric;
  v_loc uuid;
  v_stock public.stock_items;
  v_cost numeric := 0;
BEGIN
  SELECT * INTO v_w FROM public.waste_records WHERE id = _waste;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF v_w.organization_id IS DISTINCT FROM public.current_org_id() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;
  IF NOT (public.has_permission('kitchen', 'waste', 'approve')
          OR public.has_permission('stores', 'issues', 'create')) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_permitted');
  END IF;
  IF v_w.status IS DISTINCT FROM 'approved' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_approved');
  END IF;
  IF v_w.posted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_posted', 'posted_at', v_w.posted_at);
  END IF;

  v_qty := COALESCE(v_w.quantity, 0);
  IF v_qty <= 0 THEN RETURN jsonb_build_object('ok', false, 'reason', 'bad_quantity'); END IF;

  v_item := v_w.stock_item_id;
  IF v_item IS NULL AND v_w.menu_item_id IS NOT NULL THEN
    SELECT m.stock_item_id INTO v_item
      FROM public.menu_items m
     WHERE m.id = v_w.menu_item_id AND m.consumption_mode IN ('direct_stock', 'batch');
  END IF;
  IF v_item IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_stock_item'); END IF;

  SELECT * INTO v_stock FROM public.stock_items WHERE id = v_item;
  IF v_stock IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_stock_item'); END IF;

  v_loc := COALESCE(_location, v_w.location_id,
                    public.neo_item_group_store(v_w.organization_id, v_item, v_w.branch_id),
                    public.neo_station_consumption_location(v_w.organization_id, v_w.station_id, v_w.branch_id));
  IF v_loc IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_location'); END IF;

  v_unit := COALESCE(NULLIF(v_w.unit, ''), NULLIF(v_stock.unit_of_measure, ''), 'unit');
  v_cost := v_qty * COALESCE(v_stock.average_cost, 0);

  PERFORM public.inventory_apply_movement(
    v_item, v_loc, -v_qty, v_unit, 'waste',
    COALESCE(v_stock.average_cost, 0), 'waste_record', _waste,
    'Kitchen waste ' || COALESCE(v_w.waste_number, _waste::text) || ' · ' || COALESCE(v_w.category, 'waste'),
    'kitchenwaste:' || _waste::text, NULL, NULL);

  UPDATE public.waste_records
     SET posted_at = now(),
         posted_by = auth.uid(),
         posted_cost = v_cost,
         stock_item_id = v_item,
         location_id = v_loc,
         inventory_adjustment_status = 'posted',
         updated_at = now()
   WHERE id = _waste;

  PERFORM public.neo_evaluate_low_stock(v_w.organization_id, v_w.branch_id, v_item, 'waste', _waste);

  RETURN jsonb_build_object('ok', true, 'stock_item_id', v_item, 'location_id', v_loc,
                            'quantity', v_qty, 'cost', v_cost);
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_kitchen_waste_post(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_kitchen_waste_post(uuid, uuid) TO authenticated;