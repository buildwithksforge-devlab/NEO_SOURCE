CREATE OR REPLACE FUNCTION public.neo_bar_station_ids(_branch uuid DEFAULT NULL::uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  -- A bar station is decided by the property's own structure: any station that
  -- sits in a Bar department, plus any beverage station explicitly bound to one.
  -- Naming is never the test, so "Main Bar" and "Beverage" both qualify while a
  -- coffee station under Food & Beverage does not.
  SELECT s.id
    FROM public.operational_stations s
    JOIN public.departments d ON d.id = s.department_id
   WHERE (_branch IS NULL OR s.branch_id = _branch)
     AND coalesce(s.active, true)
     AND (upper(coalesce(d.code,'')) = 'BAR' OR d.name ILIKE 'bar%' OR d.name ILIKE '% bar%');
$fn$;

CREATE OR REPLACE FUNCTION public.neo_bar_menu(_branch uuid DEFAULT NULL::uuid, _include_drafts boolean DEFAULT false)
RETURNS TABLE(id uuid, name text, sku text, description text, currency text, image_url text,
  prep_minutes integer, recipe_status text, recipe_id uuid, category_id uuid, category_name text,
  menu_id uuid, menu_name text, base_price numeric, tax_rate numeric, availability text,
  publish_status text, branch_id uuid, branch_name text, department_id uuid, department_name text,
  station_id uuid, station_name text, station_source text, station_missing boolean,
  assigned_station_id uuid, updated_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE _org uuid := public.current_org_id();
BEGIN
  IF _org IS NULL THEN RETURN; END IF;
  IF NOT (public.has_permission('bar','menu','view')
          OR public.has_permission('bar','sell','view')
          OR public.has_permission('pos','menu','view')) THEN
    RAISE EXCEPTION 'You are not permitted to view the bar menu' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH src AS (
    SELECT mi.*, mc.name AS cat_name, m.id AS menu_ident, m.name AS menu_nm,
           br.name AS branch_nm,
           rc.id AS rec_id,
           rc.ingredient_count,
           public.neo_kitchen_resolve_station(_org, coalesce(mi.branch_id, _branch), mi.id, mi.category_id, NULL, NULL) AS res
      FROM public.menu_items mi
      LEFT JOIN public.menu_categories mc ON mc.id = mi.category_id
      LEFT JOIN public.menus m ON m.id = mc.menu_id
      LEFT JOIN public.branches br ON br.id = mi.branch_id
      LEFT JOIN LATERAL (
        SELECT r.id, (SELECT count(*) FROM public.recipe_ingredients ri WHERE ri.recipe_id = r.id) AS ingredient_count
          FROM public.recipes r
         WHERE r.menu_item_id = mi.id AND r.organization_id = _org
         ORDER BY r.version DESC NULLS LAST, r.created_at DESC
         LIMIT 1
      ) rc ON true
     WHERE mi.organization_id = _org
       AND (_include_drafts OR mi.publish_status = 'published')
       AND (_branch IS NULL OR mi.branch_id IS NULL OR mi.branch_id = _branch)
       AND public.neo_branch_in_scope(mi.branch_id)
  )
  SELECT r.id, r.name, r.sku, r.description, r.currency, r.image_url, r.prep_minutes,
         CASE WHEN r.rec_id IS NULL THEN 'not-linked'
              WHEN coalesce(r.ingredient_count,0) = 0 THEN 'incomplete'
              ELSE 'linked' END,
         r.rec_id,
         r.category_id, r.cat_name, r.menu_ident, r.menu_nm,
         r.base_price, r.tax_rate, r.availability, r.publish_status,
         r.branch_id, r.branch_nm,
         st.department_id, dp.name,
         st.id, st.name,
         coalesce(r.res->>'source', 'item'),
         coalesce((r.res->>'missing')::boolean, false),
         r.station_id,
         r.updated_at
    FROM src r
    -- The item's own station stands in when automatic resolution returns none,
    -- so a published bar drink never silently drops out of the selling list.
    JOIN public.operational_stations st
      ON st.id = coalesce(nullif(r.res->>'station_id','')::uuid, r.station_id)
    LEFT JOIN public.departments dp ON dp.id = st.department_id
   WHERE st.id IN (SELECT public.neo_bar_station_ids(_branch))
   ORDER BY r.branch_nm NULLS FIRST, r.cat_name NULLS LAST, r.name;
END
$fn$;

REVOKE ALL ON FUNCTION public.neo_bar_station_ids(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_bar_station_ids(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.neo_bar_menu(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_bar_menu(uuid, boolean) TO authenticated, service_role;