CREATE OR REPLACE FUNCTION public.neo_menu_save(_id uuid DEFAULT NULL::uuid, _name text DEFAULT NULL::text, _description text DEFAULT NULL::text, _branch uuid DEFAULT NULL::uuid, _service_type text DEFAULT 'all-day'::text, _status text DEFAULT 'active'::text, _valid_from date DEFAULT NULL::date, _valid_to date DEFAULT NULL::date, _valid_days integer[] DEFAULT NULL::integer[], _valid_time_from time without time zone DEFAULT NULL::time without time zone, _valid_time_to time without time zone DEFAULT NULL::time without time zone, _outlet text DEFAULT NULL::text)
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
  _outlet_clean text := nullif(btrim(coalesce(_outlet,'')),'');
  _id_out uuid;
BEGIN
  IF _clean IS NULL THEN RAISE EXCEPTION 'Menu name is required'; END IF;
  IF coalesce(_status,'active') NOT IN ('active','inactive','retired') THEN
    RAISE EXCEPTION 'Unknown menu status';
  END IF;
  IF _outlet_clean IS NOT NULL AND _outlet_clean NOT IN ('all','restaurant','bar','coffee','room-service','delivery','banqueting') THEN
    RAISE EXCEPTION 'Unknown outlet: %', _outlet_clean;
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
                             valid_days, outlet)
    VALUES (_org, _target_branch, _clean, nullif(btrim(coalesce(_description,'')),''),
            coalesce(nullif(_service_type,''),'all-day'), coalesce(_status,'active'),
            _valid_from, _valid_to, _valid_time_from, _valid_time_to, auth.uid(),
            coalesce(_valid_days, ARRAY[0,1,2,3,4,5,6]), coalesce(_outlet_clean,'all'))
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
      outlet = coalesce(_outlet_clean, outlet),
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