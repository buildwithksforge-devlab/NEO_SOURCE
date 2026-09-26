ALTER TABLE public.menus ADD COLUMN IF NOT EXISTS outlet text NOT NULL DEFAULT 'all';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'menus_outlet_check') THEN
    ALTER TABLE public.menus ADD CONSTRAINT menus_outlet_check
      CHECK (outlet IN ('all','restaurant','bar','coffee','room-service','delivery','banqueting'));
  END IF;
END $$;

UPDATE public.menus
   SET outlet = 'bar'
 WHERE outlet = 'all'
   AND (upper(name) LIKE '%BAR%' OR upper(name) LIKE '%DRINK%' OR upper(name) LIKE '%BEVERAGE%');

DROP FUNCTION IF EXISTS public.neo_menu_catalogue(uuid, boolean);
CREATE OR REPLACE FUNCTION public.neo_menu_catalogue(_branch uuid DEFAULT NULL::uuid, _include_drafts boolean DEFAULT false)
 RETURNS TABLE(id uuid, name text, sku text, description text, currency text, image_url text, prep_minutes integer, recipe_status text, recipe_id uuid, category_id uuid, category_name text, menu_id uuid, menu_name text, menu_outlet text, base_price numeric, tax_rate numeric, availability text, publish_status text, branch_id uuid, branch_name text, department_id uuid, department_name text, station_id uuid, station_name text, station_source text, station_missing boolean, assigned_station_id uuid, imported boolean, import_batch_id uuid, import_file_name text, import_batch_status text, published_at timestamp with time zone, updated_at timestamp with time zone)
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
    SELECT mi.*, mc.name AS cat_name, m.id AS menu_ident, m.name AS menu_nm, m.outlet AS menu_out,
           b.file_name AS batch_file, b.status AS batch_status,
           br.name AS branch_nm,
           rc.id AS rec_id,
           rc.ingredient_count,
           public.neo_kitchen_resolve_station(_org, coalesce(mi.branch_id, _branch), mi.id, mi.category_id, NULL, NULL) AS res
      FROM public.menu_items mi
      LEFT JOIN public.menu_categories mc ON mc.id = mi.category_id
      LEFT JOIN public.menus m ON m.id = mc.menu_id
      LEFT JOIN public.menu_import_batches b ON b.id = mi.import_batch_id
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
         r.category_id, r.cat_name, r.menu_ident, r.menu_nm, coalesce(r.menu_out,'all'),
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

CREATE OR REPLACE FUNCTION public.pos_save_menu(_name text, _description text, _branch uuid, _service_type text, _idempotency_key text, _correlation uuid, _outlet text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_org uuid:=public.current_org_id(); v_id uuid; v_audit uuid; v_event uuid; v_outlet text;
BEGIN
  IF NOT public.has_permission('restaurant','menu','create') THEN RAISE EXCEPTION 'Missing permission: restaurant.menu.create'; END IF;
  IF nullif(btrim(coalesce(_name,'')),'') IS NULL THEN RAISE EXCEPTION 'Menu name is required'; END IF;
  IF _branch IS NULL OR NOT EXISTS(SELECT 1 FROM public.branches WHERE id=_branch AND organization_id=v_org) THEN RAISE EXCEPTION 'Select an authorized property'; END IF;
  IF NOT public.in_my_config_scope(v_org,_branch) THEN RAISE EXCEPTION 'The selected property is outside your configuration scope'; END IF;
  v_outlet := coalesce(nullif(btrim(coalesce(_outlet,'')),''),'all');
  IF v_outlet NOT IN ('all','restaurant','bar','coffee','room-service','delivery','banqueting') THEN
    RAISE EXCEPTION 'Unknown outlet: %', v_outlet;
  END IF;
  SELECT id INTO v_id FROM public.menus WHERE organization_id=v_org AND branch_id=_branch AND lower(name)=lower(btrim(_name)) LIMIT 1;
  IF v_id IS NULL THEN
    INSERT INTO public.menus(organization_id,branch_id,name,description,service_type,outlet,created_by)
    VALUES(v_org,_branch,btrim(_name),nullif(btrim(coalesce(_description,'')),''),coalesce(nullif(_service_type,''),'all-day'),v_outlet,auth.uid()) RETURNING id INTO v_id;
  ELSE
    UPDATE public.menus
       SET description=coalesce(nullif(btrim(coalesce(_description,'')),''),description),
           service_type=coalesce(nullif(_service_type,''),service_type),
           outlet=v_outlet,
           updated_at=now()
     WHERE id=v_id;
  END IF;
  v_event:=public.emit_domain_event(v_org,_branch,'restaurant.menu.saved','restaurant',v_id,jsonb_build_object('name',btrim(_name),'outlet',v_outlet),'menu-save:'||coalesce(nullif(_idempotency_key,''),v_id::text),NULL);
  v_audit:=public.log_audit_event('menu.saved','restaurant',v_id::text,NULL,jsonb_build_object('name',btrim(_name),'branch_id',_branch,'outlet',v_outlet),NULL,'restaurant.menu.create',_branch,NULL,NULL,coalesce(_correlation,gen_random_uuid())::text,NULL,NULL);
  RETURN jsonb_build_object('ok',true,'menu_id',v_id,'workflow_event_id',v_event,'audit_event_id',v_audit,'menu',(SELECT to_jsonb(m) FROM public.menus m WHERE m.id=v_id));
END $function$;