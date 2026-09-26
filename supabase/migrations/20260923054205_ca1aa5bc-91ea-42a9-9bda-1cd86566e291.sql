
ALTER TABLE public.neo_public_experience ADD COLUMN IF NOT EXISTS website_url text;

CREATE TABLE IF NOT EXISTS public.neo_traffic_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  entry_door text NOT NULL DEFAULT 'discover',
  source text,
  medium text,
  campaign text,
  referrer_host text,
  landing_path text,
  session_key text NOT NULL,
  day date NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS neo_traffic_events_unique_visit
  ON public.neo_traffic_events (branch_id, session_key, entry_door, day);
CREATE INDEX IF NOT EXISTS neo_traffic_events_branch_day
  ON public.neo_traffic_events (branch_id, day DESC);

GRANT SELECT ON public.neo_traffic_events TO authenticated;
GRANT ALL ON public.neo_traffic_events TO service_role;

ALTER TABLE public.neo_traffic_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Workspace can read its own traffic" ON public.neo_traffic_events;
CREATE POLICY "Workspace can read its own traffic"
  ON public.neo_traffic_events FOR SELECT TO authenticated
  USING (
    organization_id = public.current_org_id()
    AND (
      public.is_org_admin_for(organization_id)
      OR branch_id = ANY (public.current_branch_ids())
    )
  );

CREATE OR REPLACE FUNCTION public.neo_track_entry(
  _slug text,
  _door text DEFAULT 'discover',
  _source text DEFAULT NULL,
  _medium text DEFAULT NULL,
  _campaign text DEFAULT NULL,
  _referrer text DEFAULT NULL,
  _path text DEFAULT NULL,
  _session text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _org uuid;
  _branch uuid;
  _host text;
BEGIN
  IF _slug IS NULL OR _session IS NULL OR length(trim(_session)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'incomplete');
  END IF;

  SELECT e.organization_id, e.branch_id INTO _org, _branch
  FROM public.neo_public_experience e
  WHERE e.public_slug = lower(trim(_slug)) AND e.discoverable IS TRUE
  LIMIT 1;

  IF _branch IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_property');
  END IF;

  _host := NULLIF(regexp_replace(COALESCE(_referrer, ''), '^[a-z]+://([^/]+).*$', '\1'), '');

  INSERT INTO public.neo_traffic_events (
    organization_id, branch_id, entry_door, source, medium, campaign,
    referrer_host, landing_path, session_key
  ) VALUES (
    _org, _branch, COALESCE(NULLIF(trim(_door), ''), 'discover'),
    NULLIF(trim(COALESCE(_source, '')), ''),
    NULLIF(trim(COALESCE(_medium, '')), ''),
    NULLIF(trim(COALESCE(_campaign, '')), ''),
    _host, left(COALESCE(_path, ''), 300), left(trim(_session), 80)
  )
  ON CONFLICT (branch_id, session_key, entry_door, day) DO NOTHING;

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.neo_track_entry(text, text, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_track_entry(text, text, text, text, text, text, text, text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.neo_traffic_summary(
  _branch uuid,
  _from date DEFAULT (now() AT TIME ZONE 'utc')::date - 29,
  _to date DEFAULT (now() AT TIME ZONE 'utc')::date
) RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _org uuid;
  _result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('allowed', false, 'reason', 'not_signed_in'); END IF;
  SELECT organization_id INTO _org FROM public.branches WHERE id = _branch;
  IF _org IS NULL THEN RETURN jsonb_build_object('allowed', false, 'reason', 'unknown_property'); END IF;
  IF _org <> public.current_org_id() THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'not_permitted');
  END IF;
  IF NOT (public.is_org_admin_for(_org) OR _branch = ANY (public.current_branch_ids())) THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'not_permitted');
  END IF;

  SELECT jsonb_build_object(
    'allowed', true,
    'branch_id', _branch,
    'from', _from,
    'to', _to,
    'total', COALESCE((SELECT count(*) FROM public.neo_traffic_events t
                        WHERE t.branch_id = _branch AND t.day BETWEEN _from AND _to), 0),
    'by_door', COALESCE((SELECT jsonb_agg(x) FROM (
        SELECT t.entry_door AS door, count(*) AS visits
        FROM public.neo_traffic_events t
        WHERE t.branch_id = _branch AND t.day BETWEEN _from AND _to
        GROUP BY t.entry_door ORDER BY count(*) DESC) x), '[]'::jsonb),
    'by_source', COALESCE((SELECT jsonb_agg(x) FROM (
        SELECT COALESCE(t.source, 'direct') AS source, COALESCE(t.medium, '—') AS medium,
               COALESCE(t.campaign, '—') AS campaign, count(*) AS visits
        FROM public.neo_traffic_events t
        WHERE t.branch_id = _branch AND t.day BETWEEN _from AND _to
        GROUP BY 1,2,3 ORDER BY count(*) DESC LIMIT 20) x), '[]'::jsonb),
    'by_referrer', COALESCE((SELECT jsonb_agg(x) FROM (
        SELECT COALESCE(t.referrer_host, 'direct') AS referrer, count(*) AS visits
        FROM public.neo_traffic_events t
        WHERE t.branch_id = _branch AND t.day BETWEEN _from AND _to
        GROUP BY 1 ORDER BY count(*) DESC LIMIT 20) x), '[]'::jsonb),
    'by_day', COALESCE((SELECT jsonb_agg(x) FROM (
        SELECT t.day, count(*) AS visits
        FROM public.neo_traffic_events t
        WHERE t.branch_id = _branch AND t.day BETWEEN _from AND _to
        GROUP BY t.day ORDER BY t.day) x), '[]'::jsonb)
  ) INTO _result;

  RETURN _result;
END;
$$;

REVOKE ALL ON FUNCTION public.neo_traffic_summary(uuid, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_traffic_summary(uuid, date, date) TO authenticated;
