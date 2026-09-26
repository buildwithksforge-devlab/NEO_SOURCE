-- ---------------------------------------------------------------------------
-- Menu catalogue: canonical branch -> department -> station scoping
-- Additive only. No table is altered, dropped or truncated.
-- ---------------------------------------------------------------------------

-- 1. Departments valid for a property, deduplicated by canonical identity.
CREATE OR REPLACE FUNCTION public.neo_menu_departments(_branch uuid DEFAULT NULL::uuid)
RETURNS TABLE(id uuid, name text, catalogue_key text, branch_id uuid, branch_specific boolean)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT d.id, d.name, d.catalogue_key, d.branch_id,
           coalesce(
             nullif(btrim(coalesce(d.catalogue_key,'')),''),
             public.neo_department_catalogue_key(d.name),
             lower(btrim(d.name))
           ) AS ident
      FROM public.departments d
     WHERE d.organization_id = public.current_org_id()
       AND coalesce(d.active, true)
       AND coalesce(d.department_status, 'active') <> 'archived'
       AND (_branch IS NULL OR d.branch_id = _branch OR d.branch_id IS NULL)
       AND public.neo_branch_in_scope(d.branch_id)
  ), ranked AS (
    SELECT s.*,
           row_number() OVER (
             -- When one property is selected the canonical identity is unique;
             -- in All Properties mode each property keeps its own department.
             PARTITION BY s.ident, CASE WHEN _branch IS NULL THEN s.branch_id END
             -- A property-specific department always beats an organisation-wide
             -- one, so org-wide duplicates never surface alongside it.
             ORDER BY (s.branch_id IS NOT NULL) DESC, s.name, s.id
           ) AS rn
      FROM scoped s
  )
  SELECT r.id, r.name, r.catalogue_key, r.branch_id, r.branch_id IS NOT NULL
    FROM ranked r
   WHERE r.rn = 1
     AND public.has_permission('restaurant','menu','view')
   ORDER BY r.name;
$function$;

-- 2. Production stations valid for a property and (optionally) a department.
CREATE OR REPLACE FUNCTION public.neo_menu_stations(_branch uuid DEFAULT NULL::uuid, _department uuid DEFAULT NULL::uuid)
RETURNS TABLE(id uuid, name text, code text, station_type text, department_id uuid, branch_id uuid)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT s.id, s.name, s.code, s.station_type, s.department_id, s.branch_id,
           lower(btrim(s.name)) AS ident
      FROM public.operational_stations s
     WHERE s.organization_id = public.current_org_id()
       AND coalesce(s.active, true)
       AND coalesce(s.status, 'active') NOT IN ('retired','archived')
       AND (_branch IS NULL OR s.branch_id = _branch OR s.branch_id IS NULL)
       AND public.neo_branch_in_scope(s.branch_id)
       -- A station with no department cannot be proven invalid; one that names
       -- a different department is never offered.
       AND (_department IS NULL OR s.department_id IS NULL OR s.department_id = _department)
  ), ranked AS (
    SELECT x.*,
           row_number() OVER (
             PARTITION BY x.ident, CASE WHEN _branch IS NULL THEN x.branch_id END
             ORDER BY (x.branch_id IS NOT NULL) DESC,
                      (x.department_id IS NOT NULL) DESC,
                      x.name, x.id
           ) AS rn
      FROM scoped x
  )
  SELECT r.id, r.name, r.code, r.station_type, r.department_id, r.branch_id
    FROM ranked r
   WHERE r.rn = 1
     AND public.has_permission('restaurant','menu','view')
   ORDER BY r.name;
$function$;

-- 3. The single server-side authority for the chain. Raises, never returns false.
CREATE OR REPLACE FUNCTION public.neo_menu_assert_chain(_branch uuid, _department uuid, _station uuid)
RETURNS void
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _dept public.departments;
  _st   public.operational_stations;
BEGIN
  IF _branch IS NULL THEN
    RAISE EXCEPTION 'Select a property before a department or station';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = _branch AND organization_id = _org) THEN
    RAISE EXCEPTION 'That property does not belong to this organisation';
  END IF;
  IF NOT public.neo_branch_in_scope(_branch) THEN
    RAISE EXCEPTION 'That property is outside your access';
  END IF;

  IF _department IS NOT NULL THEN
    SELECT * INTO _dept FROM public.departments WHERE id = _department AND organization_id = _org;
    IF _dept.id IS NULL THEN
      RAISE EXCEPTION 'That department does not exist';
    END IF;
    IF _dept.branch_id IS NOT NULL AND _dept.branch_id <> _branch THEN
      RAISE EXCEPTION 'That department belongs to another property';
    END IF;
    IF NOT coalesce(_dept.active, true) OR coalesce(_dept.department_status,'active') = 'archived' THEN
      RAISE EXCEPTION 'That department is no longer active';
    END IF;
  END IF;

  IF _station IS NOT NULL THEN
    SELECT * INTO _st FROM public.operational_stations WHERE id = _station AND organization_id = _org;
    IF _st.id IS NULL THEN
      RAISE EXCEPTION 'That production station does not exist';
    END IF;
    IF _st.branch_id IS NOT NULL AND _st.branch_id <> _branch THEN
      RAISE EXCEPTION 'That production station belongs to another property';
    END IF;
    IF NOT coalesce(_st.active, true) OR coalesce(_st.status,'active') IN ('retired','archived') THEN
      RAISE EXCEPTION 'That production station is no longer active';
    END IF;
    IF _department IS NOT NULL AND _st.department_id IS NOT NULL AND _st.department_id <> _department THEN
      RAISE EXCEPTION 'That production station belongs to another department';
    END IF;
  END IF;
END $function$;

-- 4. Create or edit a menu.
CREATE OR REPLACE FUNCTION public.neo_menu_save(
  _id uuid DEFAULT NULL::uuid,
  _name text DEFAULT NULL::text,
  _description text DEFAULT NULL::text,
  _branch uuid DEFAULT NULL::uuid,
  _service_type text DEFAULT 'all-day'::text,
  _status text DEFAULT 'active'::text,
  _valid_from date DEFAULT NULL::date,
  _valid_to date DEFAULT NULL::date,
  _valid_days integer[] DEFAULT NULL::integer[],
  _valid_time_from time without time zone DEFAULT NULL::time without time zone,
  _valid_time_to time without time zone DEFAULT NULL::time without time zone
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _existing public.menus;
  _target_branch uuid := _branch;
  _clean text := nullif(btrim(coalesce(_name,'')),'');
  _id_out uuid;
BEGIN
  IF _clean IS NULL THEN RAISE EXCEPTION 'Menu name is required'; END IF;
  IF coalesce(_status,'active') NOT IN ('active','inactive','retired') THEN
    RAISE EXCEPTION 'Unknown menu status';
  END IF;

  IF _id IS NULL THEN
    IF NOT public.has_permission('restaurant','menu','create') THEN
      RAISE EXCEPTION 'Not permitted to create menus';
    END IF;
  ELSE
    IF NOT public.has_permission('restaurant','menu','edit') THEN
      RAISE EXCEPTION 'Not permitted to edit menus';
    END IF;
    SELECT * INTO _existing FROM public.menus WHERE id = _id AND organization_id = _org;
    IF _existing.id IS NULL THEN RAISE EXCEPTION 'Menu not found'; END IF;
    IF NOT public.neo_branch_in_scope(_existing.branch_id) THEN
      RAISE EXCEPTION 'That menu belongs to a property outside your access';
    END IF;
    -- A menu never migrates between properties: its items would follow.
    _target_branch := _existing.branch_id;
  END IF;

  PERFORM public.neo_menu_assert_chain(_target_branch, NULL, NULL);

  IF EXISTS (
    SELECT 1 FROM public.menus m
     WHERE m.organization_id = _org
       AND m.branch_id IS NOT DISTINCT FROM _target_branch
       AND lower(btrim(m.name)) = lower(_clean)
       AND (_id IS NULL OR m.id <> _id)
  ) THEN
    RAISE EXCEPTION 'A menu with that name already exists for this property';
  END IF;

  IF _id IS NULL THEN
    INSERT INTO public.menus(organization_id, branch_id, name, description, service_type, status,
                             valid_from, valid_to, valid_time_from, valid_time_to, created_by,
                             valid_days)
    VALUES (_org, _target_branch, _clean, nullif(btrim(coalesce(_description,'')),''),
            coalesce(nullif(_service_type,''),'all-day'), coalesce(_status,'active'),
            _valid_from, _valid_to, _valid_time_from, _valid_time_to, auth.uid(),
            coalesce(_valid_days, ARRAY[0,1,2,3,4,5,6]))
    RETURNING id INTO _id_out;
  ELSE
    UPDATE public.menus SET
      name = _clean,
      description = nullif(btrim(coalesce(_description,'')),''),
      service_type = coalesce(nullif(_service_type,''),'all-day'),
      status = coalesce(_status,'active'),
      valid_from = _valid_from,
      valid_to = _valid_to,
      valid_days = coalesce(_valid_days, valid_days),
      valid_time_from = _valid_time_from,
      valid_time_to = _valid_time_to,
      updated_at = now()
    WHERE id = _id
    RETURNING id INTO _id_out;
  END IF;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, action, module, record_id, previous_value, new_value)
  VALUES (_org, _target_branch, auth.uid(),
          CASE WHEN _id IS NULL THEN 'restaurant.menu.created' ELSE 'restaurant.menu.updated' END,
          'restaurant', _id_out,
          CASE WHEN _id IS NULL THEN NULL ELSE to_jsonb(_existing) END,
          (SELECT to_jsonb(m) FROM public.menus m WHERE m.id = _id_out));

  RETURN jsonb_build_object('ok', true, 'menu_id', _id_out,
                            'menu', (SELECT to_jsonb(m) FROM public.menus m WHERE m.id = _id_out));
END $function$;

-- 5. Deactivate / retire / reactivate a menu.
CREATE OR REPLACE FUNCTION public.neo_menu_set_status(_id uuid, _status text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _menu public.menus;
BEGIN
  IF NOT public.has_permission('restaurant','menu','edit') THEN
    RAISE EXCEPTION 'Not permitted to change a menu''s status';
  END IF;
  IF _status NOT IN ('active','inactive','retired') THEN
    RAISE EXCEPTION 'Unknown menu status';
  END IF;
  SELECT * INTO _menu FROM public.menus WHERE id = _id AND organization_id = _org;
  IF _menu.id IS NULL THEN RAISE EXCEPTION 'Menu not found'; END IF;
  IF NOT public.neo_branch_in_scope(_menu.branch_id) THEN
    RAISE EXCEPTION 'That menu belongs to a property outside your access';
  END IF;

  UPDATE public.menus SET status = _status, updated_at = now() WHERE id = _id;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, action, module, record_id, previous_value, new_value)
  VALUES (_org, _menu.branch_id, auth.uid(), 'restaurant.menu.status_changed', 'restaurant', _id,
          jsonb_build_object('status', _menu.status), jsonb_build_object('status', _status));

  RETURN jsonb_build_object('ok', true, 'menu_id', _id, 'status', _status);
END $function$;

-- 6. Permanent removal, allowed only when nothing references the menu.
CREATE OR REPLACE FUNCTION public.neo_menu_delete(_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _menu public.menus;
  _cats integer;
  _items integer;
BEGIN
  IF NOT public.has_permission('restaurant','menu','delete') THEN
    RAISE EXCEPTION 'Not permitted to remove menus';
  END IF;
  SELECT * INTO _menu FROM public.menus WHERE id = _id AND organization_id = _org;
  IF _menu.id IS NULL THEN RAISE EXCEPTION 'Menu not found'; END IF;
  IF NOT public.neo_branch_in_scope(_menu.branch_id) THEN
    RAISE EXCEPTION 'That menu belongs to a property outside your access';
  END IF;

  SELECT count(*) INTO _cats FROM public.menu_categories c WHERE c.menu_id = _id;
  SELECT count(*) INTO _items
    FROM public.menu_items mi
    JOIN public.menu_categories c ON c.id = mi.category_id
   WHERE c.menu_id = _id;

  IF _cats > 0 OR _items > 0 THEN
    RAISE EXCEPTION 'This menu still has % categor(y/ies) and % item(s). Deactivate or retire it instead of deleting.', _cats, _items;
  END IF;

  DELETE FROM public.menus WHERE id = _id;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, action, module, record_id, previous_value, new_value)
  VALUES (_org, _menu.branch_id, auth.uid(), 'restaurant.menu.deleted', 'restaurant', _id, to_jsonb(_menu), NULL);

  RETURN jsonb_build_object('ok', true, 'menu_id', _id, 'deleted', true);
END $function$;

-- 7. Create / edit a menu item under the enforced chain.
CREATE OR REPLACE FUNCTION public.neo_menu_save_item(
  _id uuid DEFAULT NULL::uuid,
  _name text DEFAULT NULL::text,
  _description text DEFAULT NULL::text,
  _branch uuid DEFAULT NULL::uuid,
  _category uuid DEFAULT NULL::uuid,
  _department uuid DEFAULT NULL::uuid,
  _station uuid DEFAULT NULL::uuid,
  _base_price numeric DEFAULT 0,
  _tax_rate numeric DEFAULT 0,
  _prep_minutes integer DEFAULT 10,
  _availability text DEFAULT 'available'::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _existing public.menu_items;
  _clean text := nullif(btrim(coalesce(_name,'')),'');
  _cat_branch uuid;
  _target_branch uuid := _branch;
  _id_out uuid;
BEGIN
  IF _clean IS NULL THEN RAISE EXCEPTION 'Item name is required'; END IF;
  IF _availability NOT IN ('available','temporarily-unavailable','sold-out','disabled') THEN
    RAISE EXCEPTION 'Unknown availability';
  END IF;

  IF _id IS NULL THEN
    IF NOT public.has_permission('restaurant','menu','create') THEN
      RAISE EXCEPTION 'Not permitted to create menu items';
    END IF;
  ELSE
    IF NOT public.has_permission('restaurant','menu','edit') THEN
      RAISE EXCEPTION 'Not permitted to edit menu items';
    END IF;
    SELECT * INTO _existing FROM public.menu_items WHERE id = _id AND organization_id = _org;
    IF _existing.id IS NULL THEN RAISE EXCEPTION 'Menu item not found'; END IF;
    IF NOT public.neo_branch_in_scope(_existing.branch_id) THEN
      RAISE EXCEPTION 'That item belongs to a property outside your access';
    END IF;
    _target_branch := coalesce(_branch, _existing.branch_id);
  END IF;

  -- The category proves which property the item really belongs to.
  IF _category IS NOT NULL THEN
    SELECT m.branch_id INTO _cat_branch
      FROM public.menu_categories c
      JOIN public.menus m ON m.id = c.menu_id
     WHERE c.id = _category AND c.organization_id = _org;
    IF NOT FOUND THEN RAISE EXCEPTION 'That category does not exist'; END IF;
    IF _cat_branch IS NOT NULL AND _target_branch IS NOT NULL AND _cat_branch <> _target_branch THEN
      RAISE EXCEPTION 'That category belongs to another property';
    END IF;
    _target_branch := coalesce(_target_branch, _cat_branch);
  END IF;

  PERFORM public.neo_menu_assert_chain(_target_branch, _department, _station);

  IF _id IS NULL THEN
    INSERT INTO public.menu_items(organization_id, branch_id, category_id, name, description,
                                  base_price, tax_rate, prep_minutes, station_id, availability,
                                  publish_status, created_by)
    VALUES (_org, _target_branch, _category, _clean, nullif(btrim(coalesce(_description,'')),''),
            coalesce(_base_price,0), coalesce(_tax_rate,0), greatest(coalesce(_prep_minutes,10),1),
            _station, _availability, 'published', auth.uid())
    RETURNING id INTO _id_out;
  ELSE
    UPDATE public.menu_items SET
      name = _clean,
      description = nullif(btrim(coalesce(_description,'')),''),
      category_id = coalesce(_category, category_id),
      branch_id = _target_branch,
      base_price = coalesce(_base_price, base_price),
      tax_rate = coalesce(_tax_rate, tax_rate),
      prep_minutes = greatest(coalesce(_prep_minutes, prep_minutes), 1),
      station_id = _station,
      availability = _availability,
      updated_at = now()
    WHERE id = _id
    RETURNING id INTO _id_out;
  END IF;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, action, module, record_id, previous_value, new_value)
  VALUES (_org, _target_branch, auth.uid(),
          CASE WHEN _id IS NULL THEN 'restaurant.menu.item_created' ELSE 'restaurant.menu.item_updated' END,
          'restaurant', _id_out,
          CASE WHEN _id IS NULL THEN NULL ELSE to_jsonb(_existing) END,
          (SELECT to_jsonb(mi) FROM public.menu_items mi WHERE mi.id = _id_out));

  RETURN jsonb_build_object('ok', true, 'item_id', _id_out, 'branch_id', _target_branch, 'station_id', _station);
END $function$;

-- 8. Station assignment from the catalogue table obeys the same chain.
CREATE OR REPLACE FUNCTION public.neo_menu_assign_station(_item_id uuid, _station_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _item public.menu_items;
BEGIN
  IF NOT public.has_permission('pos','menu','assign-station') THEN
    RAISE EXCEPTION 'Not permitted to assign production stations';
  END IF;
  SELECT * INTO _item FROM public.menu_items WHERE id = _item_id AND organization_id = _org;
  IF _item.id IS NULL THEN RAISE EXCEPTION 'Menu item not found'; END IF;
  IF NOT public.neo_branch_in_scope(_item.branch_id) THEN
    RAISE EXCEPTION 'That menu item belongs to a property outside your access';
  END IF;

  IF _station_id IS NOT NULL THEN
    IF _item.branch_id IS NOT NULL THEN
      -- Same single authority as item creation: never across properties.
      PERFORM public.neo_menu_assert_chain(_item.branch_id, NULL, _station_id);
    END IF;
    IF NOT public.neo_station_is_usable(_org, _item.branch_id, _station_id) THEN
      RAISE EXCEPTION 'That production station is not usable for this item';
    END IF;
  END IF;

  UPDATE public.menu_items SET station_id = _station_id, updated_at = now() WHERE id = _item_id;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, action, module, record_id, previous_value, new_value)
  VALUES (_org, _item.branch_id, auth.uid(), 'pos.menu.assign_station', 'pos', _item_id,
          jsonb_build_object('stationId', _item.station_id),
          jsonb_build_object('stationId', _station_id));

  RETURN jsonb_build_object('item_id', _item_id, 'station_id', _station_id);
END $function$;

-- 9. Catalogue now reports the property and department behind every row so
--    identical concepts across properties are never mistaken for duplicates.
DROP FUNCTION IF EXISTS public.neo_menu_catalogue(uuid, boolean);
CREATE OR REPLACE FUNCTION public.neo_menu_catalogue(_branch uuid DEFAULT NULL::uuid, _include_drafts boolean DEFAULT false)
RETURNS TABLE(id uuid, name text, sku text, category_id uuid, category_name text, menu_id uuid, menu_name text,
              base_price numeric, tax_rate numeric, availability text, publish_status text, branch_id uuid,
              branch_name text, department_id uuid, department_name text,
              station_id uuid, station_name text, station_source text, station_missing boolean,
              assigned_station_id uuid, imported boolean, import_batch_id uuid, import_file_name text,
              import_batch_status text, published_at timestamp with time zone, updated_at timestamp with time zone)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id();
BEGIN
  IF _org IS NULL THEN RETURN; END IF;
  IF NOT public.has_permission('pos','menu','view') THEN
    RAISE EXCEPTION 'Not permitted to view the menu catalogue';
  END IF;

  RETURN QUERY
  WITH src AS (
    SELECT mi.*, mc.name AS cat_name, m.id AS menu_ident, m.name AS menu_nm,
           b.file_name AS batch_file, b.status AS batch_status,
           br.name AS branch_nm,
           public.neo_kitchen_resolve_station(_org, coalesce(mi.branch_id, _branch), mi.id, mi.category_id, NULL, NULL) AS res
      FROM public.menu_items mi
      LEFT JOIN public.menu_categories mc ON mc.id = mi.category_id
      LEFT JOIN public.menus m ON m.id = mc.menu_id
      LEFT JOIN public.menu_import_batches b ON b.id = mi.import_batch_id
      LEFT JOIN public.branches br ON br.id = mi.branch_id
     WHERE mi.organization_id = _org
       AND (_include_drafts OR mi.publish_status = 'published')
       AND (_branch IS NULL OR mi.branch_id IS NULL OR mi.branch_id = _branch)
       AND public.neo_branch_in_scope(mi.branch_id)
  )
  SELECT r.id, r.name, r.sku, r.category_id, r.cat_name, r.menu_ident, r.menu_nm,
         r.base_price, r.tax_rate, r.availability, r.publish_status,
         r.branch_id, r.branch_nm,
         st.department_id, dp.name,
         nullif(r.res->>'station_id','')::uuid,
         st.name,
         r.res->>'source',
         (r.res->>'missing')::boolean,
         r.station_id,
         r.import_batch_id IS NOT NULL,
         r.import_batch_id, r.batch_file, r.batch_status,
         r.published_at, r.updated_at
    FROM src r
    LEFT JOIN public.operational_stations st ON st.id = nullif(r.res->>'station_id','')::uuid
    LEFT JOIN public.departments dp ON dp.id = st.department_id
   ORDER BY r.branch_nm NULLS FIRST, r.cat_name NULLS LAST, r.name;
END $function$;

-- Callable surface: signed-in staff only, never anonymous.
REVOKE ALL ON FUNCTION public.neo_menu_departments(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_menu_stations(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_menu_assert_chain(uuid, uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_menu_save(uuid, text, text, uuid, text, text, date, date, integer[], time without time zone, time without time zone) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_menu_set_status(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_menu_delete(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_menu_save_item(uuid, text, text, uuid, uuid, uuid, uuid, numeric, numeric, integer, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_menu_catalogue(uuid, boolean) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.neo_menu_departments(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_menu_stations(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_menu_assert_chain(uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_menu_save(uuid, text, text, uuid, text, text, date, date, integer[], time without time zone, time without time zone) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_menu_set_status(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_menu_delete(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_menu_save_item(uuid, text, text, uuid, uuid, uuid, uuid, numeric, numeric, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_menu_catalogue(uuid, boolean) TO authenticated;
