BEGIN;

-- Allocation is tied to the sold line and the same departmental store as its
-- ingredients. Existing batches without a recorded store may use their own
-- station's current mapping. Explicitly recorded stores are never reassigned.
DO $repair$
DECLARE
  routine regprocedure := 'public.neo_consume_prepared_batch(uuid,uuid,numeric,text,uuid)'::regprocedure;
  source text := pg_get_functiondef(routine);
  old_begin text := $old$BEGIN
  IF COALESCE(_quantity, 0) <= 0 THEN$old$;
  new_begin text := $new$  v_sale_org uuid;
  v_store uuid;
BEGIN
  SELECT o.organization_id,
         public.neo_station_consumption_location(
           o.organization_id, coalesce(oi.station_id, m.station_id, r.station_id), o.branch_id
         )
    INTO v_sale_org, v_store
    FROM public.pos_order_items oi
    JOIN public.pos_orders o ON o.id = oi.order_id AND o.organization_id = oi.organization_id
    JOIN public.menu_items m ON m.id = oi.menu_item_id AND m.organization_id = o.organization_id
      AND (m.branch_id IS NULL OR m.branch_id = o.branch_id)
    JOIN public.recipes r ON r.id = _recipe AND r.menu_item_id = m.id AND r.organization_id = o.organization_id
      AND (r.branch_id IS NULL OR r.branch_id = o.branch_id)
   WHERE oi.id = _order_item AND o.branch_id = _branch
     AND m.consumption_mode = 'batch';
  IF v_sale_org IS NULL OR v_store IS NULL
     OR v_sale_org IS DISTINCT FROM public.current_org_id()
     OR NOT coalesce(public.neo_branch_in_scope(_branch),false) THEN
    RAISE EXCEPTION 'The sold batch has no authorized departmental store' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('pos-consume:' || _order_item::text, 0));
  IF COALESCE(_quantity, 0) <= 0 OR _quantity::text IN ('NaN','Infinity','-Infinity') THEN$new$;
  old_filter text := $old$       AND pb.recipe_id = _recipe$old$;
  new_filter text := $new$       AND pb.recipe_id = _recipe
       AND coalesce(pb.output_location_id,
           public.neo_station_consumption_location(v_sale_org, pb.station_id, _branch)) = v_store$new$;
BEGIN
  IF position(old_begin IN source)=0 OR position(old_filter IN source)=0 OR
     position('batch.operational.consumed' IN source)=0 THEN
    RAISE EXCEPTION 'Unrecognized installed batch allocation contract';
  END IF;
  source := replace(source, old_begin, new_begin);
  source := replace(source, old_filter, new_filter);
  source := replace(source, 'pb.created_at' || chr(10) || '     FOR UPDATE',
                           'pb.created_at, pb.id' || chr(10) || '     FOR UPDATE');
  EXECUTE source;
END
$repair$;
REVOKE ALL ON FUNCTION public.neo_consume_prepared_batch(uuid,uuid,numeric,text,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_consume_prepared_batch(uuid,uuid,numeric,text,uuid) TO service_role;

-- POS availability and the actual allocator agree on the batch's store.
DO $repair$
DECLARE
  source text := pg_get_functiondef('public.neo_pos_department_menu_availability(uuid,text)'::regprocedure);
  before_filter text := $old$     FROM public.production_batches b WHERE b.organization_id=org AND b.branch_id=_branch AND b.recipe_id=recipe.id$old$;
BEGIN
  IF position(before_filter IN source)=0 THEN RAISE EXCEPTION 'Unrecognized installed batch availability contract'; END IF;
  source := replace(source,before_filter,before_filter || chr(10) ||
    '      AND coalesce(b.output_location_id,public.neo_station_consumption_location(org,b.station_id,_branch))=location');
  EXECUTE replace(source,'ORDER BY (r.recipe_type=', 'ORDER BY (r.branch_id IS NOT NULL) DESC,(r.recipe_type=');
END
$repair$;

-- Resolve the active recipe from the sale's property. A recipe version in a
-- different branch must never win the selection for a shared menu item.
DO $repair$
DECLARE
  source text := pg_get_functiondef('public.inventory_consume_order_item_core(uuid)'::regprocedure);
  before_recipe text := $old$     AND menu_item_id = v_item.menu_item_id
     AND recipe_type IN ('menu_item','direct_sale')
     AND status = 'active'
   ORDER BY (recipe_type = 'menu_item') DESC, version DESC$old$;
  after_recipe text := $new$     AND menu_item_id = v_item.menu_item_id
     AND (branch_id IS NULL OR branch_id = v_branch)
     AND recipe_type IN ('menu_item','direct_sale')
     AND status = 'active'
   ORDER BY (branch_id IS NOT NULL) DESC, (recipe_type = 'menu_item') DESC, version DESC, id$new$;
BEGIN
  IF position(before_recipe IN source)=0 OR position('neo_station_consumption_location' IN source)=0 THEN
    RAISE EXCEPTION 'Unrecognized installed POS consumption contract';
  END IF;
  EXECUTE replace(source,before_recipe,after_recipe);
END
$repair$;
-- Finishing production creates an operational batch in the mapped store.
-- It still records zero ingredient movements until a sale consumes the batch.
DO $repair$
DECLARE
  source text := pg_get_functiondef('public.neo_production_batch_post(uuid,uuid)'::regprocedure);
  old_routing text := $old$  v_loc := COALESCE(
    _location,
    v_b.output_location_id,
    public.neo_station_consumption_location(
      v_b.organization_id,
      v_b.station_id,
      v_b.branch_id
    )
  );$old$;
  new_routing text := $new$  v_loc := public.neo_station_consumption_location(
    v_b.organization_id, coalesce(v_b.station_id, v_recipe.station_id), v_b.branch_id
  );
  IF v_loc IS NULL OR (_location IS NOT NULL AND _location <> v_loc)
     OR (v_b.output_location_id IS NOT NULL AND v_b.output_location_id <> v_loc) THEN
    RETURN jsonb_build_object('ok',false,'reason','department_store_required');
  END IF;$new$;
BEGIN
  IF position(old_routing IN source)=0 OR position('batch_component_log_only' IN source)=0 THEN
    RAISE EXCEPTION 'Unrecognized installed batch production contract';
  END IF;
  source := replace(source,
     'IF v_b.organization_id IS DISTINCT FROM public.current_org_id() THEN',
     'IF v_b.organization_id IS DISTINCT FROM public.current_org_id() OR NOT coalesce(public.neo_branch_in_scope(v_b.branch_id),false) THEN');
  source := replace(source, 'WHERE id = v_b.recipe_id;',
    'WHERE id = v_b.recipe_id AND organization_id = v_b.organization_id
      AND (branch_id IS NULL OR branch_id = v_b.branch_id);');
  source := replace(source, 'IF COALESCE(v_b.actual_quantity, 0) <= 0 THEN',
    'IF COALESCE(v_b.actual_quantity, 0) <= 0 OR v_b.actual_quantity::text IN (''NaN'',''Infinity'',''-Infinity'') THEN');
  source := replace(source, 'IF COALESCE(v_b.waste_quantity, 0) < 0 THEN',
    'IF COALESCE(v_b.waste_quantity, 0) < 0 OR v_b.waste_quantity::text IN (''NaN'',''Infinity'',''-Infinity'') THEN');
  EXECUTE replace(source,old_routing,new_routing);
END
$repair$;
COMMIT;
