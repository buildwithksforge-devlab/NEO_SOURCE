ALTER TABLE public.neo_test_environments
  ADD COLUMN IF NOT EXISTS cleanup_problems jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Verification now checks every table that carries an organisation id, not a
-- hand-written list, so nothing can be quietly left behind.
CREATE OR REPLACE FUNCTION public.neo_test_purge_verify(_org uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _res jsonb := '{}'::jsonb;
  _t text;
  _n bigint;
BEGIN
  FOR _t IN
    SELECT c.relname::text
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'organization_id'
                         AND a.attnum > 0 AND NOT a.attisdropped
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND c.relname NOT IN ('organizations','neo_test_environments','neo_test_runs','neo_test_results')
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id = $1', _t) INTO _n USING _org;
    IF _n > 0 THEN _res := _res || jsonb_build_object(_t, _n); END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'organization_exists', EXISTS (SELECT 1 FROM public.organizations WHERE id = _org),
    'remaining', _res,
    'clean', NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = _org) AND _res = '{}'::jsonb
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_test_purge_verify(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_test_purge_verify(uuid) TO service_role;