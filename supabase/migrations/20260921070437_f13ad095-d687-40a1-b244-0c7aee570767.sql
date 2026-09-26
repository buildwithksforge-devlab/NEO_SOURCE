GRANT EXECUTE ON FUNCTION public.fin_period_for(uuid, date) TO authenticated, service_role;
ALTER FUNCTION public.neo_gl_cash_name(text) SET search_path TO 'public';