CREATE OR REPLACE FUNCTION public.neo_hr_leave_enforce_eligibility()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_scope text;
  v_gender text;
  v_name text;
BEGIN
  SELECT lt.gender_scope, lt.name INTO v_scope, v_name
    FROM public.leave_types lt WHERE lt.id = NEW.leave_type_id;

  IF v_scope IS NULL OR v_scope = 'any' THEN
    RETURN NEW;
  END IF;

  SELECT lower(btrim(coalesce(e.gender,''))) INTO v_gender
    FROM public.employees e WHERE e.id = NEW.employee_id;

  IF v_gender IS NULL OR v_gender = '' THEN
    RETURN NEW;
  END IF;

  IF v_gender <> v_scope THEN
    RAISE EXCEPTION '% does not apply to this employee under the company leave policy', coalesce(v_name, 'This leave type');
  END IF;

  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS leave_requests_enforce_eligibility ON public.leave_requests;
CREATE TRIGGER leave_requests_enforce_eligibility
  BEFORE INSERT ON public.leave_requests
  FOR EACH ROW EXECUTE FUNCTION public.neo_hr_leave_enforce_eligibility();