CREATE OR REPLACE FUNCTION public.neo_menu_catalogue(_branch uuid DEFAULT NULL::uuid, _include_drafts boolean DEFAULT false)
 RETURNS TABLE(id uuid, name text, sku text, description text, currency text, image_url text, prep_minutes integer, recipe_status text, consumption_mode text, recipe_id uuid, direct_stock_item_id uuid, direct_stock_item_name text, direct_stock_unit text, direct_stock_quantity numeric, issuing_location_id uuid, issuing_location_name text, consumption_channels text[], category_id uuid, category_name text, menu_id uuid, menu_name text, menu_outlet text, base_price numeric, tax_rate numeric, availability text, publish_status text, branch_id uuid, branch_name text, department_id uuid, department_name text, station_id uuid, station_name text, station_source text, station_missing boolean, assigned_station_id uuid, imported boolean, import_batch_id uuid, import_file_name text, import_batch_status text, published_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _manages boolean;
  _sells boolean;
BEGIN
  IF _org IS NULL THEN RETURN; END IF;

  -- Reading the sellable list and administering it are different rights.
  -- Anyone who takes orders must be able to see what they are selling; only
  -- menu managers see drafts and unpublished items.
  _manages := public.has_permission('pos','menu','view');
  _sells := _manages
    OR public.has_permission('restaurant','orders','view')
    OR public.has_permission('restaurant','orders','create')
    OR public.has_permission('restaurant','floor','view')
    OR public.has_permission('restaurant','kds','view');

  IF NOT _sells THEN
    RAISE EXCEPTION 'Not permitted to view the menu catalogue';
  END IF;
  IF _include_drafts AND NOT _manages THEN
    RAISE EXCEPTION 'Not permitted to view unpublished menu items';
  END IF;

  RETURN QUERY
  WITH src AS (
    SELECT mi.*, mc.name AS cat_name, m.id AS menu_ident, m.name AS menu_nm, m.outlet AS menu_out,
           b.file_name AS batch_file, b.status AS batch_status,
           br.name AS branch_nm,
           rc.id AS rec_id,
           rc.ingredient_count,
           rc.recipe_type AS rec_type,
           rc.output_stock_item_id AS rec_output,
           rc.yield_quantity AS rec_yield,
           rc.yield_unit AS rec_yield_unit,
           public.neo_kitchen_resolve_station(_org, coalesce(mi.branch_id, _branch), mi.id, mi.category_id, NULL, NULL) AS res
      FROM public.menu_items mi
      LEFT JOIN public.menu_categories mc ON mc.id = mi.category_id
      LEFT JOIN public.menus m ON m.id = mc.menu_id
      LEFT JOIN public.menu_import_batches b ON b.id = mi.import_batch_id
      LEFT JOIN public.branches br ON br.id = mi.branch_id
      LEFT JOIN LATERAL (
        SELECT r.id, r.recipe_type, r.output_stock_item_id, r.yield_quantity, r.yield_unit,
               (SELECT count(*) FROM public.recipe_ingredients ri WHERE ri.recipe_id = r.id) AS ingredient_count
          FROM public.recipes r
         WHERE r.menu_item_id = mi.id AND r.organization_id = _org
         ORDER BY r.version DESC NULLS LAST, r.created_at DESC
         LIMIT 1
      ) rc ON true
     WHERE mi.organization_id = _org
       AND (_include_drafts OR mi.publish_status = 'published')
       AND (_branch IS NULL OR mi.branch_id IS NULL OR mi.branch_id = _branch)
       AND public.neo_branch_in_scope(mi.branch_id)
  ), shaped AS (
    SELECT r.*,
           CASE
             WHEN COALESCE(r.consumption_mode,'none') <> 'none' THEN r.consumption_mode
             WHEN r.rec_type = 'direct_sale' AND r.rec_output IS NOT NULL THEN 'direct_stock'
             WHEN r.rec_id IS NOT NULL THEN 'recipe'
             ELSE 'none'
           END AS eff_mode,
           COALESCE(r.stock_item_id, CASE WHEN r.rec_type = 'direct_sale' THEN r.rec_output END) AS eff_stock_item
      FROM src r
  )
  SELECT s.id, s.name, s.sku, s.description, s.currency, s.image_url, s.prep_minutes,
         CASE
           WHEN s.eff_mode = 'none' THEN 'no-stock'
           WHEN s.eff_mode IN ('direct_stock','batch') THEN
             CASE WHEN s.eff_stock_item IS NOT NULL THEN 'direct-stock' ELSE 'incomplete' END
           WHEN s.rec_id IS NULL THEN 'not-linked'
           WHEN coalesce(s.ingredient_count,0) = 0 THEN 'incomplete'
           ELSE 'linked'
         END,
         s.eff_mode,
         s.rec_id,
         s.eff_stock_item,
         si.name,
         CASE WHEN s.eff_stock_item IS NOT NULL
              THEN coalesce(nullif(s.stock_unit,''), nullif(s.rec_yield_unit,''), si.base_unit) END,
         CASE WHEN s.eff_stock_item IS NOT NULL
              THEN coalesce(nullif(s.stock_quantity_per_sale,0), s.rec_yield, 1) END,
         s.issuing_location_id, iss.name, s.consumption_channels,
         s.category_id, s.cat_name, s.menu_ident, s.menu_nm, coalesce(s.menu_out,'all'),
         s.base_price, s.tax_rate, s.availability, s.publish_status,
         s.branch_id, s.branch_nm,
         st.department_id, dp.name,
         nullif(s.res->>'station_id','')::uuid,
         st.name,
         s.res->>'source',
         (s.res->>'missing')::boolean,
         s.station_id,
         s.import_batch_id IS NOT NULL,
         s.import_batch_id, s.batch_file, s.batch_status,
         s.published_at, s.updated_at
    FROM shaped s
    LEFT JOIN public.stock_items si ON si.id = s.eff_stock_item
    LEFT JOIN public.stock_locations iss ON iss.id = s.issuing_location_id
    LEFT JOIN public.operational_stations st ON st.id = nullif(s.res->>'station_id','')::uuid
    LEFT JOIN public.departments dp ON dp.id = st.department_id
   ORDER BY s.branch_nm NULLS FIRST, s.cat_name NULLS LAST, s.name;
END $function$;