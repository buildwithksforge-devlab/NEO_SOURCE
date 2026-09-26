
CREATE TABLE IF NOT EXISTS public.ai_provider_settings (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'lovable',
  model text NOT NULL DEFAULT 'google/gemini-3-flash-preview',
  base_url text,
  api_key text,
  enabled boolean NOT NULL DEFAULT true,
  last_check_at timestamptz,
  last_check_status text,
  last_check_detail text,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.ai_provider_settings TO service_role;
ALTER TABLE public.ai_provider_settings ENABLE ROW LEVEL SECURITY;
-- No policies for anon/authenticated: reachable only through the guarded routines below.

CREATE OR REPLACE FUNCTION public.neo_ai_provider_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(public.is_org_admin(), false)
      OR COALESCE(public.has_permission('administration', 'workspace', 'edit'), false);
$$;

CREATE OR REPLACE FUNCTION public.neo_ai_provider_get()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _org uuid := public.current_org_id();
  _row public.ai_provider_settings%ROWTYPE;
BEGIN
  IF _org IS NULL THEN
    RETURN jsonb_build_object('authorised', false, 'reason', 'No organisation is linked to this account.');
  END IF;
  IF NOT public.neo_ai_provider_admin() THEN
    RETURN jsonb_build_object('authorised', false, 'reason', 'You do not have permission to configure the AI provider.');
  END IF;

  SELECT * INTO _row FROM public.ai_provider_settings WHERE organization_id = _org;

  RETURN jsonb_build_object(
    'authorised', true,
    'configured', _row.organization_id IS NOT NULL,
    'provider', COALESCE(_row.provider, 'lovable'),
    'model', COALESCE(_row.model, 'google/gemini-3-flash-preview'),
    'base_url', _row.base_url,
    'enabled', COALESCE(_row.enabled, true),
    'has_key', COALESCE(NULLIF(btrim(COALESCE(_row.api_key, '')), ''), NULL) IS NOT NULL,
    'last_check_at', _row.last_check_at,
    'last_check_status', _row.last_check_status,
    'last_check_detail', _row.last_check_detail,
    'updated_at', _row.updated_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.neo_ai_provider_save(
  _provider text,
  _model text,
  _base_url text DEFAULT NULL,
  _api_key text DEFAULT NULL,
  _enabled boolean DEFAULT true,
  _clear_key boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _org uuid := public.current_org_id();
BEGIN
  IF _org IS NULL OR NOT public.neo_ai_provider_admin() THEN
    RETURN jsonb_build_object('authorised', false, 'reason', 'You do not have permission to configure the AI provider.');
  END IF;
  IF COALESCE(btrim(_provider), '') = '' OR COALESCE(btrim(_model), '') = '' THEN
    RETURN jsonb_build_object('authorised', true, 'saved', false, 'reason', 'Provider and model are required.');
  END IF;

  INSERT INTO public.ai_provider_settings AS t (organization_id, provider, model, base_url, api_key, enabled, updated_by, updated_at)
  VALUES (_org, btrim(_provider), btrim(_model), NULLIF(btrim(COALESCE(_base_url, '')), ''),
          NULLIF(btrim(COALESCE(_api_key, '')), ''), COALESCE(_enabled, true), auth.uid(), now())
  ON CONFLICT (organization_id) DO UPDATE
    SET provider = EXCLUDED.provider,
        model = EXCLUDED.model,
        base_url = EXCLUDED.base_url,
        enabled = EXCLUDED.enabled,
        api_key = CASE
          WHEN _clear_key THEN NULL
          WHEN EXCLUDED.api_key IS NOT NULL THEN EXCLUDED.api_key
          ELSE t.api_key END,
        last_check_at = CASE WHEN t.provider IS DISTINCT FROM EXCLUDED.provider THEN NULL ELSE t.last_check_at END,
        last_check_status = CASE WHEN t.provider IS DISTINCT FROM EXCLUDED.provider THEN NULL ELSE t.last_check_status END,
        last_check_detail = CASE WHEN t.provider IS DISTINCT FROM EXCLUDED.provider THEN NULL ELSE t.last_check_detail END,
        updated_by = auth.uid(),
        updated_at = now();

  RETURN jsonb_build_object('authorised', true, 'saved', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.neo_ai_provider_record_check(_status text, _detail text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _org uuid := public.current_org_id();
BEGIN
  IF _org IS NULL OR NOT public.neo_ai_provider_admin() THEN
    RETURN jsonb_build_object('authorised', false);
  END IF;
  UPDATE public.ai_provider_settings
     SET last_check_at = now(), last_check_status = _status, last_check_detail = _detail
   WHERE organization_id = _org;
  RETURN jsonb_build_object('authorised', true);
END;
$$;

REVOKE ALL ON FUNCTION public.neo_ai_provider_admin() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_ai_provider_get() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_ai_provider_save(text, text, text, text, boolean, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_ai_provider_record_check(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_ai_provider_get() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_ai_provider_save(text, text, text, text, boolean, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_ai_provider_record_check(text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_ai_provider_admin() TO authenticated, service_role;
