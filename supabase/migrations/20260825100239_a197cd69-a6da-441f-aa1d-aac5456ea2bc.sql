-- 1. Save item: photo, code and currency ------------------------------------
CREATE OR REPLACE FUNCTION public.neo_menu_save_item(
  _id uuid DEFAULT NULL::uuid, _name text DEFAULT NULL::text, _description text DEFAULT NULL::text,
  _branch uuid DEFAULT NULL::uuid, _category uuid DEFAULT NULL::uuid, _department uuid DEFAULT NULL::uuid,
  _station uuid DEFAULT NULL::uuid, _base_price numeric DEFAULT 0, _tax_rate numeric DEFAULT 0,
  _prep_minutes integer DEFAULT 10, _availability text DEFAULT 'available'::text,
  _image_url text DEFAULT NULL::text, _sku text DEFAULT NULL::text, _currency text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _existing public.menu_items;
  _clean text := nullif(btrim(coalesce(_name,'')),'');
  _cat_branch uuid;
  _target_branch uuid := _branch;
  _id_out uuid;
  _code text := nullif(btrim(coalesce(_sku,'')),'');
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

  -- An item code identifies one item within a property, so a duplicate code
  -- would make a later import update the wrong record.
  IF _code IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.menu_items mi
     WHERE mi.organization_id = _org AND mi.branch_id IS NOT DISTINCT FROM _target_branch
       AND lower(mi.sku) = lower(_code) AND (_id IS NULL OR mi.id <> _id)
  ) THEN
    RAISE EXCEPTION 'Item code % is already used by another item at this property', _code;
  END IF;

  IF _id IS NULL THEN
    INSERT INTO public.menu_items(organization_id, branch_id, category_id, name, description,
                                  base_price, tax_rate, prep_minutes, station_id, availability,
                                  image_url, sku, currency, publish_status, created_by)
    VALUES (_org, _target_branch, _category, _clean, nullif(btrim(coalesce(_description,'')),''),
            coalesce(_base_price,0), coalesce(_tax_rate,0), greatest(coalesce(_prep_minutes,10),1),
            _station, _availability, nullif(btrim(coalesce(_image_url,'')),''), _code,
            coalesce(nullif(btrim(coalesce(_currency,'')),''),'KES'), 'published', auth.uid())
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
      image_url = nullif(btrim(coalesce(_image_url,'')),''),
      sku = _code,
      currency = coalesce(nullif(btrim(coalesce(_currency,'')),''), currency),
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
REVOKE ALL ON FUNCTION public.neo_menu_save_item(uuid,text,text,uuid,uuid,uuid,uuid,numeric,numeric,integer,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_menu_save_item(uuid,text,text,uuid,uuid,uuid,uuid,numeric,numeric,integer,text,text,text,text) TO authenticated;

-- 2. Catalogue reader exposes the operational data-quality facts -------------
DROP FUNCTION IF EXISTS public.neo_menu_catalogue(uuid, boolean);
CREATE OR REPLACE FUNCTION public.neo_menu_catalogue(_branch uuid DEFAULT NULL::uuid, _include_drafts boolean DEFAULT false)
RETURNS TABLE(id uuid, name text, sku text, description text, currency text, image_url text,
              prep_minutes integer, recipe_status text, recipe_id uuid,
              category_id uuid, category_name text, menu_id uuid, menu_name text,
              base_price numeric, tax_rate numeric, availability text, publish_status text,
              branch_id uuid, branch_name text, department_id uuid, department_name text,
              station_id uuid, station_name text, station_source text, station_missing boolean,
              assigned_station_id uuid, imported boolean, import_batch_id uuid, import_file_name text,
              import_batch_status text, published_at timestamp with time zone, updated_at timestamp with time zone)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
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
         r.category_id, r.cat_name, r.menu_ident, r.menu_nm,
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
REVOKE ALL ON FUNCTION public.neo_menu_catalogue(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_menu_catalogue(uuid, boolean) TO authenticated;

-- 3. Import: item codes, resolved stations, safe updates ---------------------
CREATE OR REPLACE FUNCTION public.pos_import_menu_drafts(
  _menu uuid, _branch uuid, _file_name text, _file_type text, _checksum text,
  _rows jsonb, _idempotency_key text, _correlation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_org uuid:=public.current_org_id(); v_batch uuid; v_row jsonb; v_category uuid; v_station uuid; v_item uuid;
  v_parsed int:=jsonb_array_length(coalesce(_rows,'[]'::jsonb)); v_valid int:=0; v_committed int:=0; v_updated int:=0;
  v_duplicates int:=0; v_mapping int:=0; v_rejected int:=0; v_event uuid; v_audit uuid; v_code text; v_row_station uuid;
BEGIN
  IF NOT public.has_permission('restaurant','menu','create') THEN RAISE EXCEPTION 'Missing permission: restaurant.menu.create'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.menus WHERE id=_menu AND organization_id=v_org AND branch_id=_branch) THEN RAISE EXCEPTION 'Select a canonical menu in your authorized property'; END IF;
  IF NOT public.in_my_config_scope(v_org,_branch) THEN RAISE EXCEPTION 'The selected property is outside your configuration scope'; END IF;
  SELECT id INTO v_batch FROM public.menu_import_batches WHERE organization_id=v_org AND checksum=_checksum AND menu_id=_menu AND status <> 'failed' LIMIT 1;
  IF v_batch IS NOT NULL THEN
    RETURN jsonb_build_object('ok',true,'idempotent',true,'batch_id',v_batch,'parsed_rows',(SELECT parsed_rows FROM public.menu_import_batches WHERE id=v_batch),'committed_rows',(SELECT committed_rows FROM public.menu_import_batches WHERE id=v_batch));
  END IF;
  INSERT INTO public.menu_import_batches(organization_id,branch_id,menu_id,file_name,file_type,total_rows,parsed_rows,status,checksum,correlation_id,created_by)
  VALUES(v_org,_branch,_menu,_file_name,_file_type,v_parsed,v_parsed,'processing',_checksum,_correlation,auth.uid()) RETURNING id INTO v_batch;

  FOR v_row IN SELECT value FROM jsonb_array_elements(coalesce(_rows,'[]'::jsonb)) LOOP
    IF nullif(btrim(v_row->>'name'),'') IS NULL OR nullif(btrim(v_row->>'category'),'') IS NULL OR (v_row->>'base_price') IS NULL THEN v_rejected:=v_rejected+1; CONTINUE; END IF;
    v_valid:=v_valid+1;
    v_code := nullif(btrim(coalesce(v_row->>'sku','')),'');

    SELECT id,station_id INTO v_category,v_station FROM public.menu_categories WHERE organization_id=v_org AND menu_id=_menu AND lower(name)=lower(btrim(v_row->>'category')) LIMIT 1;
    IF v_category IS NULL THEN
      INSERT INTO public.menu_categories(organization_id,menu_id,name) VALUES(v_org,_menu,btrim(v_row->>'category')) RETURNING id,station_id INTO v_category,v_station;
    END IF;

    -- A station named in the file is only accepted when the caller resolved it
    -- to a canonical station of this property; no station master data is ever
    -- invented from a spreadsheet value.
    v_row_station := nullif(v_row->>'station_id','')::uuid;
    IF v_row_station IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.operational_stations s
       WHERE s.id = v_row_station AND s.organization_id = v_org AND s.branch_id = _branch
    ) THEN
      v_row_station := NULL;
    END IF;
    IF v_row_station IS NOT NULL THEN
      v_station := v_row_station;
    ELSIF v_station IS NULL THEN
      SELECT mc.station_id INTO v_station FROM public.menu_categories mc
       WHERE mc.organization_id=v_org AND lower(mc.name)=lower(btrim(v_row->>'category')) AND mc.station_id IS NOT NULL LIMIT 1;
      IF v_station IS NOT NULL THEN UPDATE public.menu_categories SET station_id=v_station WHERE id=v_category AND station_id IS NULL; END IF;
    END IF;
    IF v_station IS NULL THEN v_mapping:=v_mapping+1; END IF;

    -- Identity: the item code wins, and a name match is only used when no code
    -- was supplied, so an existing item is never blindly duplicated or renamed.
    v_item := NULL;
    IF v_code IS NOT NULL THEN
      SELECT id INTO v_item FROM public.menu_items
       WHERE organization_id=v_org AND branch_id=_branch AND lower(sku)=lower(v_code) LIMIT 1;
    END IF;
    IF v_item IS NULL THEN
      SELECT id INTO v_item FROM public.menu_items WHERE organization_id=v_org AND branch_id=_branch AND category_id=v_category AND lower(name)=lower(btrim(v_row->>'name')) LIMIT 1;
      IF v_item IS NOT NULL THEN v_duplicates:=v_duplicates+1; CONTINUE; END IF;
    ELSE
      UPDATE public.menu_items SET
        name = btrim(v_row->>'name'),
        category_id = v_category,
        description = coalesce(nullif(v_row->>'description',''), description),
        base_price = (v_row->>'base_price')::numeric,
        currency = coalesce(nullif(v_row->>'currency',''), currency),
        availability = coalesce(nullif(v_row->>'availability',''), availability),
        tax_rate = coalesce(nullif(v_row->>'tax_rate','')::numeric, tax_rate),
        prep_minutes = coalesce(nullif(v_row->>'prep_minutes','')::integer, prep_minutes),
        station_id = coalesce(v_row_station, station_id),
        import_batch_id = v_batch,
        updated_at = now()
      WHERE id = v_item;
      v_updated := v_updated + 1;
      CONTINUE;
    END IF;

    INSERT INTO public.menu_items(organization_id,branch_id,category_id,station_id,name,description,base_price,currency,availability,publish_status,import_batch_id,created_by,tax_rate,prep_minutes,sku)
    VALUES(v_org,_branch,v_category,v_station,btrim(v_row->>'name'),nullif(v_row->>'description',''),(v_row->>'base_price')::numeric,coalesce(nullif(v_row->>'currency',''),'KES'),coalesce(nullif(v_row->>'availability',''),'available'),'draft',v_batch,auth.uid(),nullif(v_row->>'tax_rate','')::numeric,nullif(v_row->>'prep_minutes','')::integer,v_code)
    RETURNING id INTO v_item;
    v_committed:=v_committed+1;
  END LOOP;

  UPDATE public.menu_import_batches SET valid_rows=v_valid,imported_rows=v_committed,committed_rows=v_committed,rejected_rows=v_rejected,duplicate_rows=v_duplicates,mapping_rows=v_mapping,status=CASE WHEN v_committed=0 AND v_updated=0 THEN 'failed' WHEN v_rejected>0 THEN 'partial' ELSE 'completed' END WHERE id=v_batch;
  v_event:=public.emit_domain_event(v_org,_branch,'restaurant.menu.imported','restaurant',v_batch,jsonb_build_object('menu_id',_menu,'parsed',v_parsed,'valid',v_valid,'committed',v_committed,'updated',v_updated,'rejected',v_rejected,'duplicates',v_duplicates,'awaiting_mapping',v_mapping),'menu-import:'||coalesce(nullif(_idempotency_key,''),v_batch::text),NULL);
  v_audit:=public.log_audit_event('menu.import.completed','restaurant',v_batch::text,NULL,jsonb_build_object('file_name',_file_name,'checksum',_checksum,'menu_id',_menu,'parsed_rows',v_parsed,'valid_rows',v_valid,'committed_rows',v_committed,'updated_rows',v_updated,'rejected_rows',v_rejected,'duplicate_rows',v_duplicates,'mapping_rows',v_mapping),NULL,'restaurant.menu.create',_branch,NULL,NULL,coalesce(_correlation,gen_random_uuid())::text,NULL,NULL);
  RETURN jsonb_build_object('ok',(v_committed+v_updated)>0,'partial',(v_rejected+v_mapping)>0,'batch_id',v_batch,'parsed_rows',v_parsed,'valid_rows',v_valid,'committed_rows',v_committed,'updated_rows',v_updated,'rejected_rows',v_rejected,'duplicate_rows',v_duplicates,'mapping_rows',v_mapping,'workflow_event_id',v_event,'audit_event_id',v_audit);
END $function$;
REVOKE ALL ON FUNCTION public.pos_import_menu_drafts(uuid,uuid,text,text,text,jsonb,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pos_import_menu_drafts(uuid,uuid,text,text,text,jsonb,text,uuid) TO authenticated;