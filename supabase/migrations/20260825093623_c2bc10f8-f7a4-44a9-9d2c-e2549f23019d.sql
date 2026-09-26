REVOKE ALL ON FUNCTION public.neo_employee_number_default() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.neo_employee_number_default() FROM anon;
REVOKE ALL ON FUNCTION public.neo_employee_number_default() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.neo_employee_number_default() TO service_role;