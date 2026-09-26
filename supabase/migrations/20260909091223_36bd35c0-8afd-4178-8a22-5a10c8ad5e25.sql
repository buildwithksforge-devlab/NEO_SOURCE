-- Generic, retry-safe purge: clears every public table that carries the test
-- workspace's organisation id, repeating until nothing more can be removed, then
-- removes the workspace row itself.
CREATE OR REPLACE FUNCTION public.neo_test_purge_org(_org uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _name text;
  _registered boolean;
  _t text;
  _pass int;
  _deleted bigint;
  _total bigint := 0;
  _errors jsonb := '[]'::jsonb;
  _tables text[];
BEGIN
  SELECT name INTO _name FROM public.organizations WHERE id = _org;
  IF _name IS NULL THEN
    RETURN jsonb_build_object('removed', true, 'reason', 'not_found');
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.neo_test_environments WHERE test_org_id = _org) INTO _registered;
  IF _name NOT LIKE 'NEØ Test Organization%' AND NOT _registered THEN
    RAISE EXCEPTION 'Refusing to purge % — it is not an automated test workspace', _name;
  END IF;

  PERFORM set_config('neo.test_purge', _org::text, true);

  SELECT array_agg(c.relname::text ORDER BY c.relname)
    INTO _tables
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'organization_id' AND a.attnum > 0 AND NOT a.attisdropped
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'organizations'
     AND c.relname <> 'neo_test_environments' AND c.relname <> 'neo_test_runs' AND c.relname <> 'neo_test_results';

  FOR _pass IN 1..6 LOOP
    _deleted := 0;
    FOREACH _t IN ARRAY coalesce(_tables, ARRAY[]::text[]) LOOP
      BEGIN
        EXECUTE format('DELETE FROM public.%I WHERE organization_id = $1', _t) USING _org;
        GET DIAGNOSTICS _total = ROW_COUNT;
        _deleted := _deleted + _total;
      EXCEPTION WHEN OTHERS THEN
        IF _pass = 6 THEN
          _errors := _errors || jsonb_build_object('table', _t, 'error', SQLERRM);
        END IF;
      END;
    END LOOP;
    EXIT WHEN _deleted = 0;
  END LOOP;

  BEGIN
    DELETE FROM public.organizations WHERE id = _org;
  EXCEPTION WHEN OTHERS THEN
    _errors := _errors || jsonb_build_object('table', 'organizations', 'error', SQLERRM);
  END;

  PERFORM set_config('neo.test_purge', '', true);

  RETURN jsonb_build_object(
    'removed', NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = _org),
    'organization', _org,
    'label', _name,
    'errors', _errors
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_test_purge_org(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_test_purge_org(uuid) TO service_role;