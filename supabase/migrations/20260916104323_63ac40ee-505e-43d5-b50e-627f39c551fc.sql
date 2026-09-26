-- Usage inspection: what still references this structure record?
CREATE OR REPLACE FUNCTION public.neo_structure_usage(_kind text, _id uuid)
RETURNS TABLE(child_table text, child_column text, row_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  _parent regclass;
  _ignore text[] := ARRAY[]::text[];
  _org uuid;
  r record;
  _n bigint;
BEGIN
  IF _kind = 'role' THEN
    _parent := 'public.roles'::regclass;
    _ignore := ARRAY['role_permissions'];
    SELECT organization_id INTO _org FROM public.roles WHERE id = _id;
  ELSIF _kind = 'department' THEN
    _parent := 'public.departments'::regclass;
    SELECT organization_id INTO _org FROM public.departments WHERE id = _id;
  ELSE
    RAISE EXCEPTION 'Unsupported record type';
  END IF;

  IF _org IS NULL OR _org IS DISTINCT FROM public.current_org_id() THEN
    RAISE EXCEPTION 'Record not found in the active organization';
  END IF;
  IF NOT (public.is_org_admin() OR public.neo_can_manage_roles()) THEN
    RAISE EXCEPTION 'Not authorised to manage the organisation structure';
  END IF;

  FOR r IN
    SELECT c.conrelid::regclass::text AS tbl,
           c.conrelid::regclass AS tbl_oid,
           a.attname::text AS col
    FROM pg_constraint c
    JOIN LATERAL unnest(c.conkey) k(att) ON true
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.att
    WHERE c.contype = 'f' AND c.confrelid = _parent
  LOOP
    IF split_part(r.tbl, '.', greatest(1, array_length(string_to_array(r.tbl,'.'),1))) = ANY(_ignore) THEN
      CONTINUE;
    END IF;
    EXECUTE format('SELECT count(*) FROM %s WHERE %I = $1', r.tbl_oid, r.col)
      INTO _n USING _id;
    IF _n > 0 THEN
      child_table := r.tbl; child_column := r.col; row_count := _n;
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$fn$;
REVOKE ALL ON FUNCTION public.neo_structure_usage(text, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_structure_usage(text, uuid) TO authenticated, service_role;

-- Guarded deletion: only when nothing references the record.
CREATE OR REPLACE FUNCTION public.neo_delete_structure_record(_kind text, _id uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  _blockers jsonb;
  _name text;
  _org uuid;
BEGIN
  SELECT coalesce(jsonb_agg(jsonb_build_object('table', child_table, 'column', child_column, 'rows', row_count)
           ORDER BY row_count DESC), '[]'::jsonb)
    INTO _blockers
  FROM public.neo_structure_usage(_kind, _id);

  IF jsonb_array_length(_blockers) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'deleted', false, 'blockers', _blockers);
  END IF;

  IF _kind = 'role' THEN
    SELECT name, organization_id INTO _name, _org FROM public.roles WHERE id = _id;
    DELETE FROM public.role_permissions WHERE role_id = _id;
    DELETE FROM public.roles WHERE id = _id;
  ELSE
    SELECT name, organization_id INTO _name, _org FROM public.departments WHERE id = _id;
    DELETE FROM public.departments WHERE id = _id;
  END IF;

  INSERT INTO public.audit_logs(organization_id, action, module, record_id, new_value, actor_id)
  VALUES (_org, 'structure.' || _kind || '.deleted', 'administration', _id::text,
          jsonb_build_object('name', _name), auth.uid());

  RETURN jsonb_build_object('ok', true, 'deleted', true, 'blockers', '[]'::jsonb, 'name', _name);
END;
$fn$;
REVOKE ALL ON FUNCTION public.neo_delete_structure_record(text, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_delete_structure_record(text, uuid) TO authenticated, service_role;