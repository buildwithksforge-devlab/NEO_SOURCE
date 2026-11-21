-- Advisory one-sale availability from the same department, quantities and recipe expansion as consumption.
-- Existing order-send and inventory movement gates remain authoritative for actual quantities and concurrency.
BEGIN;
CREATE FUNCTION public.neo_pos_department_menu_availability(_branch uuid, _channel text)
RETURNS TABLE(menu_item_id uuid, available boolean, reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp
AS $function$
DECLARE
 org uuid:=public.current_org_id(); menu public.menu_items; recipe public.recipes;
 location uuid; store text; mode text; portions numeric; prepared numeric;
 components jsonb; missing text; allow_negative boolean;
BEGIN
 IF auth.uid() IS NULL OR org IS NULL OR NOT coalesce(public.neo_branch_in_scope(_branch),false)
  OR NOT EXISTS(SELECT 1 FROM public.branches b WHERE b.id=_branch AND b.organization_id=org)
  OR NOT (coalesce(public.has_permission('pos','orders.create'),false)
      OR coalesce(public.has_permission('pos','orders.view'),false) OR coalesce(public.is_org_admin(),false)) THEN
  RAISE EXCEPTION 'Menu stock is outside your property or POS access' USING ERRCODE='42501';
 END IF;
 allow_negative:=public.neo_inventory_allows_negative(org,_branch);
 FOR menu IN SELECT m.* FROM public.menu_items m WHERE m.organization_id=org
  AND (m.branch_id IS NULL OR m.branch_id=_branch) AND m.publish_status='published'
 LOOP
  menu_item_id:=menu.id;
  available:=false;
  reason:=NULL;
  IF cardinality(menu.consumption_channels)>0 AND NOT (
    replace(lower(coalesce(_channel,'')),'_','-')=ANY(menu.consumption_channels)
  ) THEN CONTINUE; END IF;
  SELECT r.* INTO recipe FROM public.recipes r WHERE r.organization_id=org
   AND r.menu_item_id=menu.id AND r.status='active' AND r.recipe_type IN ('menu_item','direct_sale')
   AND (r.branch_id IS NULL OR r.branch_id=_branch)
   ORDER BY (r.recipe_type='menu_item') DESC,r.version DESC,r.id LIMIT 1;
  mode:=coalesce(nullif(menu.consumption_mode,'none'),CASE recipe.recipe_type
    WHEN 'direct_sale' THEN 'direct_stock' WHEN 'menu_item' THEN 'recipe' ELSE 'none' END);
  IF mode='none' THEN CONTINUE; END IF;
  location:=public.neo_station_consumption_location(org,coalesce(menu.station_id,recipe.station_id),_branch);
  IF location IS NULL THEN
   reason:='No active departmental store is mapped to the production station';
   RETURN NEXT; CONTINUE;
  END IF;
  SELECT l.name INTO store FROM public.stock_locations l WHERE l.id=location AND l.organization_id=org;
  BEGIN
   IF mode IN ('direct_stock','batch') AND (
    menu.stock_quantity_per_sale IS NULL OR menu.stock_quantity_per_sale<=0
    OR menu.stock_quantity_per_sale::text IN ('NaN','Infinity','-Infinity')
   ) THEN RAISE data_exception USING MESSAGE='Per-sale quantity is invalid'; END IF;
   IF mode='direct_stock' THEN
    IF menu.stock_item_id IS NULL THEN
     reason:='Link the inventory item sold by this product';
     RETURN NEXT; CONTINUE;
    END IF;
    components:=jsonb_build_array(jsonb_build_object('item',menu.stock_item_id,'unit',coalesce(nullif(menu.stock_unit,''),'unit'),
     'quantity',public.inventory_round_for_item(menu.stock_quantity_per_sale,coalesce(nullif(menu.stock_unit,''),'unit'),menu.stock_item_id)));
   ELSE
    IF mode NOT IN ('recipe','batch') OR recipe.id IS NULL OR recipe.yield_quantity IS NULL
     OR recipe.yield_quantity<=0 OR recipe.yield_quantity::text IN ('NaN','Infinity','-Infinity') THEN
     reason:='An active recipe with a valid yield is required';
     RETURN NEXT; CONTINUE;
    END IF;
    portions:=1;
    IF mode='batch' THEN
     portions:=public.inventory_convert_strict(menu.stock_quantity_per_sale,
      coalesce(nullif(trim(menu.stock_unit),''),recipe.yield_unit),recipe.yield_unit);
     SELECT coalesce(sum(public.inventory_convert_strict(b.remaining_quantity,
      coalesce(nullif(trim(b.unit),''),recipe.yield_unit),recipe.yield_unit)),0) INTO prepared
     FROM public.production_batches b WHERE b.organization_id=org AND b.branch_id=_branch AND b.recipe_id=recipe.id
      AND b.posted_at IS NOT NULL AND b.status IN ('completed','partially-used')
      AND b.remaining_quantity>0 AND (b.use_by IS NULL OR b.use_by>=now());
     IF prepared<portions THEN reason:='No sufficient prepared batch is available'; RETURN NEXT; CONTINUE; END IF;
    END IF;
    SELECT jsonb_agg(jsonb_build_object('item',e.stock_item_id,'unit',e.unit,'quantity',e.quantity))
     INTO components FROM public.recipe_expand_to_stock_kinds(recipe.id,portions/recipe.yield_quantity,_branch) e;
   END IF;
   IF components IS NULL THEN reason:='The recipe has no usable stock components'; RETURN NEXT; CONTINUE; END IF;
   WITH demand AS (
    SELECT (c->>'item')::uuid id,c->>'unit' unit,sum((c->>'quantity')::numeric) qty
    FROM jsonb_array_elements(components) c GROUP BY 1,2
   ), mapped AS (
    SELECT s.id item_id,s.name,s.base_unit,d.qty,d.unit,s.container_volume_ml,
     d.unit IN ('ml','millilitre','millilitres','cl','l','litre','litres')
       AND s.tracking_method IN ('volume','both') AND s.container_volume_ml>0 AS by_volume
    FROM demand d LEFT JOIN public.stock_items s ON s.id=d.id AND s.organization_id=org
     AND (s.branch_id IS NULL OR s.branch_id=_branch)
   ), requirements AS (
    SELECT m.item_id,m.name,m.base_unit,m.container_volume_ml,
     sum(CASE WHEN m.by_volume THEN public.inventory_convert_strict(m.qty,m.unit,'ml') ELSE 0 END) volume_units,
     sum(CASE WHEN NOT coalesce(m.by_volume,false) AND m.item_id IS NOT NULL
      THEN public.inventory_convert_strict(m.qty,m.unit,m.base_unit) ELSE 0 END) whole_units,
     bool_or(m.qty IS NULL OR m.qty<=0 OR m.qty::text IN ('NaN','Infinity','-Infinity') OR nullif(trim(m.unit),'') IS NULL) invalid
    FROM mapped m GROUP BY m.item_id,m.name,m.base_unit,m.container_volume_ml
   )
   SELECT CASE WHEN r.item_id IS NULL OR r.invalid THEN 'A stock link or required quantity is invalid'
    ELSE format('Out of stock: %s in %s. Replenish this store from Main Store.',r.name,store) END
   INTO missing
   FROM requirements r
   LEFT JOIN public.stock_levels l ON l.stock_item_id=r.item_id AND l.location_id=location AND l.organization_id=org
   LEFT JOIN public.stock_open_containers c ON c.stock_item_id=r.item_id AND c.location_id=location AND c.organization_id=org
   WHERE r.item_id IS NULL OR r.invalid OR (NOT allow_negative AND (
    r.whole_units>coalesce(l.quantity_on_hand,0)
    OR r.volume_units>coalesce(c.open_volume_ml,0)+greatest(coalesce(l.quantity_on_hand,0)-r.whole_units,0)*coalesce(r.container_volume_ml,0)
   ))
   ORDER BY (r.item_id IS NULL OR r.invalid) DESC,r.name,r.item_id LIMIT 1;
   IF missing IS NOT NULL THEN reason:=missing; RETURN NEXT; END IF;
  EXCEPTION WHEN data_exception OR check_violation THEN
   reason:='Stock cannot be verified. Check the item, recipe quantities and unit conversions.';
   RETURN NEXT;
  END;
 END LOOP;
END;
$function$;
REVOKE ALL ON FUNCTION public.neo_pos_department_menu_availability(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.neo_pos_department_menu_availability(uuid,text) TO authenticated;
COMMIT;
