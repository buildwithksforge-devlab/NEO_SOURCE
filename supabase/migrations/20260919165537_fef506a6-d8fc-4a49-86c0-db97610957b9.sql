DO $do$
DECLARE _def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO _def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'neo_matching_policy'
   LIMIT 1;
  IF _def IS NOT NULL AND _def !~* 'neo_assert_tenant_context' THEN
    EXECUTE replace(_def, 'AS $function$', 'AS $function$') ;
  END IF;
END;
$do$;

GRANT EXECUTE ON FUNCTION public.neo_tenant_safety_scan() TO postgres;