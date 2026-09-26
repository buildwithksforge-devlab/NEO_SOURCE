-- 1. Repair unambiguous station -> department links -------------------------
WITH candidate AS (
  SELECT s.id AS station_id,
         CASE
           WHEN coalesce(s.code,'') || ' ' || coalesce(s.name,'') ILIKE '%coffee%'
             OR coalesce(s.station_type,'') = 'beverage'
             OR coalesce(s.code,'') || ' ' || coalesce(s.name,'') ILIKE '%bar%'
             OR coalesce(s.code,'') || ' ' || coalesce(s.name,'') ILIKE '%beverage%'
           THEN 'bar'
           ELSE 'main-kitchen'
         END AS want_key,
         s.branch_id
    FROM public.operational_stations s
   WHERE s.department_id IS NULL
     AND s.branch_id IS NOT NULL
),
resolved AS (
  SELECT c.station_id, d.id AS department_id
    FROM candidate c
    JOIN LATERAL (
      SELECT d.id
        FROM public.departments d
       WHERE d.branch_id = c.branch_id
         AND coalesce(d.catalogue_key,'') = c.want_key
    ) d ON TRUE
   WHERE (
     SELECT count(*) FROM public.departments d2
      WHERE d2.branch_id = c.branch_id
        AND coalesce(d2.catalogue_key,'') = c.want_key
   ) = 1
)
UPDATE public.operational_stations s
   SET department_id = r.department_id,
       updated_at = now()
  FROM resolved r
 WHERE s.id = r.station_id;

-- 2. Permanent chain guard ---------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_station_assert_chain()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _dept_branch uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.branch_id IS NULL THEN
      RAISE EXCEPTION 'station_property_required: select a property before creating a station'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.department_id IS NULL THEN
      RAISE EXCEPTION 'station_department_required: select a department of that property before creating a station'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.department_id IS NOT NULL THEN
    SELECT d.branch_id INTO _dept_branch FROM public.departments d WHERE d.id = NEW.department_id;
    IF _dept_branch IS NOT NULL AND NEW.branch_id IS NOT NULL AND _dept_branch <> NEW.branch_id THEN
      RAISE EXCEPTION 'station_chain_mismatch: department belongs to another property'
        USING ERRCODE = 'check_violation';
    END IF;
    IF _dept_branch IS NOT NULL AND NEW.branch_id IS NULL THEN
      NEW.branch_id := _dept_branch;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS neo_station_assert_chain_trg ON public.operational_stations;
CREATE TRIGGER neo_station_assert_chain_trg
BEFORE INSERT OR UPDATE OF branch_id, department_id ON public.operational_stations
FOR EACH ROW EXECUTE FUNCTION public.neo_station_assert_chain();

-- 3. Integrity report --------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_station_integrity(_branch uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _org uuid := public.current_org_id();
  _unassigned jsonb;
  _mismatched jsonb;
  _ambiguous jsonb;
BEGIN
  IF _org IS NULL THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'station_id', s.id, 'station', s.name, 'branch_id', s.branch_id,
           'branch', b.name, 'station_type', s.station_type)
         ORDER BY b.name, s.name), '[]'::jsonb)
    INTO _unassigned
    FROM public.operational_stations s
    LEFT JOIN public.branches b ON b.id = s.branch_id
   WHERE s.department_id IS NULL
     AND (b.id IS NULL OR b.organization_id = _org)
     AND (_branch IS NULL OR s.branch_id = _branch);

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'station_id', s.id, 'station', s.name, 'branch', b.name,
           'department', d.name, 'department_branch', db.name)
         ORDER BY s.name), '[]'::jsonb)
    INTO _mismatched
    FROM public.operational_stations s
    JOIN public.departments d ON d.id = s.department_id
    LEFT JOIN public.branches b ON b.id = s.branch_id
    LEFT JOIN public.branches db ON db.id = d.branch_id
   WHERE d.branch_id IS NOT NULL
     AND s.branch_id IS NOT NULL
     AND d.branch_id <> s.branch_id
     AND (b.id IS NULL OR b.organization_id = _org)
     AND (_branch IS NULL OR s.branch_id = _branch);

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'branch', b.name, 'branch_id', b.id, 'catalogue_key', x.catalogue_key,
           'duplicates', x.n) ORDER BY b.name, x.catalogue_key), '[]'::jsonb)
    INTO _ambiguous
    FROM (
      SELECT d.branch_id, coalesce(d.catalogue_key,'') AS catalogue_key, count(*) AS n
        FROM public.departments d
       WHERE d.branch_id IS NOT NULL AND coalesce(d.catalogue_key,'') <> ''
       GROUP BY 1,2 HAVING count(*) > 1
    ) x
    JOIN public.branches b ON b.id = x.branch_id
   WHERE b.organization_id = _org
     AND (_branch IS NULL OR b.id = _branch);

  RETURN jsonb_build_object(
    'unassigned_stations', _unassigned,
    'mismatched_stations', _mismatched,
    'ambiguous_departments', _ambiguous,
    'healthy', jsonb_array_length(_unassigned) = 0
               AND jsonb_array_length(_mismatched) = 0
               AND jsonb_array_length(_ambiguous) = 0
  );
END;
$$;

REVOKE ALL ON FUNCTION public.neo_station_integrity(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_station_integrity(uuid) TO authenticated;