CREATE OR REPLACE FUNCTION public.neo_station_department_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _d public.departments;
BEGIN
  IF NEW.department_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO _d FROM public.departments WHERE id = NEW.department_id;

  IF _d.id IS NULL THEN
    RAISE EXCEPTION 'Station department does not exist';
  END IF;

  IF NEW.organization_id IS NOT NULL AND _d.organization_id IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'A station must belong to a department in the same workspace';
  END IF;

  IF _d.branch_id IS NOT NULL AND NEW.branch_id IS NOT NULL AND _d.branch_id <> NEW.branch_id THEN
    RAISE EXCEPTION 'A station must belong to a department of the same property';
  END IF;

  -- Only block newly introduced references to a retired department; existing
  -- rows keep their history untouched.
  IF NOT COALESCE(_d.active, true)
     AND (TG_OP = 'INSERT' OR NEW.department_id IS DISTINCT FROM OLD.department_id) THEN
    RAISE EXCEPTION 'A station cannot be assigned to a retired department';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS neo_station_department_guard ON public.operational_stations;
CREATE TRIGGER neo_station_department_guard
BEFORE INSERT OR UPDATE OF department_id, branch_id, organization_id ON public.operational_stations
FOR EACH ROW EXECUTE FUNCTION public.neo_station_department_guard();