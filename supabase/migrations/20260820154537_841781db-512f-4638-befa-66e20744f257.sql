
CREATE OR REPLACE FUNCTION public.neo_autoseed_role_aliases()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _r record; _key text; _n integer := 0;
BEGIN
  FOR _r IN
    SELECT DISTINCT name FROM roles
     WHERE coalesce(role_status,'') <> 'archived'
       AND public.neo_norm_key(name) NOT IN (SELECT alias_key FROM role_catalogue_aliases)
  LOOP
    _key := public.neo_auto_alias_key(_r.name);
    IF _key IS NOT NULL THEN
      INSERT INTO role_catalogue_aliases (alias_key, role_key, ambiguous, review_reason)
      VALUES (public.neo_norm_key(_r.name), _key, false, '')
      ON CONFLICT (alias_key) DO NOTHING;
      _n := _n + 1;
    END IF;
  END LOOP;
  RETURN _n;
END $$;

REVOKE EXECUTE ON FUNCTION public.neo_autoseed_role_aliases() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_autoseed_role_aliases() TO service_role;

SELECT public.neo_autoseed_role_aliases();
