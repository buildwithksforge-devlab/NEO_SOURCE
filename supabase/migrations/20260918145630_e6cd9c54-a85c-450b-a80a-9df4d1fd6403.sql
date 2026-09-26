
CREATE OR REPLACE FUNCTION public.neo_stock_location_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _dept record;
BEGIN
  IF NEW.is_mini_store THEN
    IF NEW.department_id IS NULL THEN
      RAISE EXCEPTION 'A store that issues to a department must name that department'
        USING ERRCODE = '22023';
    END IF;
    SELECT * INTO _dept FROM public.departments WHERE id = NEW.department_id;
    IF _dept IS NULL OR _dept.organization_id <> NEW.organization_id THEN
      RAISE EXCEPTION 'The department must belong to this workspace' USING ERRCODE = '42501';
    END IF;
    IF _dept.branch_id IS NOT NULL AND NEW.branch_id IS NOT NULL AND _dept.branch_id <> NEW.branch_id THEN
      RAISE EXCEPTION 'The department must belong to the same property as the store'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    NEW.department_id := NULL;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.neo_stock_location_guard() FROM PUBLIC, anon, authenticated;
