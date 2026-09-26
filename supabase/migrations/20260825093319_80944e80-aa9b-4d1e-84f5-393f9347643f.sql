CREATE OR REPLACE FUNCTION public.neo_allocate_employee_number(_org uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _n integer; _candidate text;
BEGIN
  LOOP
    SELECT COALESCE(MAX((regexp_replace(employee_number, '^EMP-', ''))::int), 0) + 1
      INTO _n
      FROM public.employees
     WHERE organization_id = _org
       AND employee_number ~ '^EMP-[0-9]+$';
    _candidate := 'EMP-' || lpad(_n::text, 3, '0');
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.employees
       WHERE organization_id = _org AND employee_number = _candidate);
  END LOOP;
  RETURN _candidate;
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_allocate_employee_number(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_allocate_employee_number(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_employee_number_default()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.employee_number IS NULL OR trim(NEW.employee_number) = '' THEN
    NEW.employee_number := public.neo_allocate_employee_number(NEW.organization_id);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_neo_employee_number_default ON public.employees;
CREATE TRIGGER trg_neo_employee_number_default
BEFORE INSERT ON public.employees
FOR EACH ROW EXECUTE FUNCTION public.neo_employee_number_default();

ALTER TABLE public.employees ALTER COLUMN employee_number DROP NOT NULL;