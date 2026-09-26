
CREATE OR REPLACE FUNCTION public.neo_squash(_t text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT regexp_replace(regexp_replace(lower(coalesce(_t,'')), '[^a-z0-9]', '', 'g'), '(.)\1+', '\1', 'g')
$$;

CREATE OR REPLACE FUNCTION public.neo_role_tokens(_t text)
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT array_agg(DISTINCT tok ORDER BY tok)
  FROM (
    SELECT public.neo_squash(t) AS tok
    FROM unnest(regexp_split_to_array(
      regexp_replace(
        regexp_replace(lower(coalesce(_t,'')), '\m(hr)\M', 'human resources', 'g'),
        '\m(f&b|fnb)\M', 'food beverage', 'g'),
      '[^a-z0-9]+')) AS t
    WHERE t <> ''
      AND t NOT IN ('and','of','the','a','or','de')
  ) s
$$;

CREATE OR REPLACE FUNCTION public.neo_auto_alias_key(_name text)
RETURNS text LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE _key text; _n text; _tok text[]; _cnt integer;
BEGIN
  IF coalesce(_name,'') = '' THEN RETURN NULL; END IF;

  SELECT role_key INTO _key FROM role_catalogue_aliases
   WHERE alias_key = public.neo_norm_key(_name) AND NOT ambiguous LIMIT 1;
  IF _key IS NOT NULL THEN RETURN _key; END IF;

  IF EXISTS (SELECT 1 FROM role_catalogue_aliases
              WHERE alias_key = public.neo_norm_key(_name) AND ambiguous) THEN
    RETURN NULL;
  END IF;

  _n := public.neo_squash(_name);

  SELECT role_key INTO _key FROM role_catalogue
   WHERE public.neo_squash(role_name) = _n OR public.neo_squash(role_key) = _n LIMIT 1;
  IF _key IS NOT NULL THEN RETURN _key; END IF;

  SELECT role_key INTO _key FROM role_catalogue_aliases
   WHERE NOT ambiguous AND public.neo_squash(alias_key) = _n LIMIT 1;
  IF _key IS NOT NULL THEN RETURN _key; END IF;

  _tok := public.neo_role_tokens(_name);
  IF _tok IS NULL OR array_length(_tok,1) = 0 THEN RETURN NULL; END IF;

  SELECT count(*), min(role_key) INTO _cnt, _key
    FROM role_catalogue
   WHERE public.neo_role_tokens(role_name) @> _tok;
  IF _cnt = 1 THEN RETURN _key; END IF;

  RETURN NULL;
END $$;

REVOKE EXECUTE ON FUNCTION public.neo_squash(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.neo_role_tokens(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.neo_auto_alias_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_squash(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_role_tokens(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_auto_alias_key(text) TO authenticated, service_role;

INSERT INTO public.role_catalogue_aliases (alias_key, role_key, ambiguous, review_reason)
VALUES
  (public.neo_norm_key('HR Manager'), 'human-resources-manager', false, ''),
  (public.neo_norm_key('Human Resource Manager'), 'human-resources-manager', false, ''),
  (public.neo_norm_key('Waitress'), 'waiter', false, ''),
  (public.neo_norm_key('Waiter'), 'waiter', false, ''),
  (public.neo_norm_key('Hot Kitchen Chef'), 'hot-kitchen-chef', false, ''),
  (public.neo_norm_key('Finance Manager'), 'finance-manager', false, ''),
  (public.neo_norm_key('Events Manager'), 'sales-and-events-manager', false, ''),
  (public.neo_norm_key('Sales Manager'), 'sales-and-events-manager', false, ''),
  (public.neo_norm_key('Front Office Manager'), 'front-office-supervisor', false, '')
ON CONFLICT (alias_key) DO UPDATE
  SET role_key = EXCLUDED.role_key, ambiguous = false, review_reason = '';
