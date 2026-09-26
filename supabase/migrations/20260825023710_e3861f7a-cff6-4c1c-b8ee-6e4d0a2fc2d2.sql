CREATE OR REPLACE FUNCTION public.neo_housekeeping_department(_org uuid, _branch uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT d.id FROM public.departments d
   WHERE d.organization_id = _org
     AND (d.catalogue_key = 'housekeeping' OR d.name ILIKE 'housekeeping%')
   ORDER BY (d.branch_id IS DISTINCT FROM _branch), d.branch_id NULLS LAST, d.name
   LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.neo_housekeeping_department(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_housekeeping_department(uuid, uuid) TO authenticated;

DO $do$
DECLARE
  v_specs text[][] := ARRAY[
    ARRAY['public.hk_raise_cleaning_task(uuid,text,text,text,timestamptz,uuid,text,uuid,text,uuid,text,uuid)', 'v_room.branch_id'],
    ARRAY['public.hk_assign_job(uuid,uuid,text,uuid)', 'v_job.branch_id'],
    ARRAY['public.tg_checkout_housekeeping_handoff()', 'NEW.branch_id']
  ];
  v_i int; v_def text; v_new text; v_org_expr text;
BEGIN
  FOR v_i IN 1 .. array_length(v_specs, 1) LOOP
    v_def := pg_get_functiondef(v_specs[v_i][1]::regprocedure);
    v_org_expr := CASE WHEN v_specs[v_i][2] = 'NEW.branch_id' THEN 'NEW.organization_id' ELSE 'v_org' END;
    v_new := regexp_replace(
      v_def,
      'SELECT\s+id\s+INTO\s+v_department\s+FROM\s+public\.departments[^;]*;',
      'v_department := public.neo_housekeeping_department(' || v_org_expr || ', ' || v_specs[v_i][2] || ');',
      'i'
    );
    IF v_new = v_def THEN
      RAISE EXCEPTION 'Could not patch department lookup in %', v_specs[v_i][1];
    END IF;
    EXECUTE v_new;
  END LOOP;
END
$do$;

UPDATE public.housekeeping_jobs j
   SET department_id = public.neo_housekeeping_department(j.organization_id, j.branch_id),
       updated_at = now()
  FROM public.departments d
 WHERE d.id = j.department_id
   AND (d.branch_id IS DISTINCT FROM j.branch_id OR d.catalogue_key IS DISTINCT FROM 'housekeeping')
   AND public.neo_housekeeping_department(j.organization_id, j.branch_id) IS NOT NULL;
