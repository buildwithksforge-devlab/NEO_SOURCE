CREATE OR REPLACE FUNCTION public.neo_mpesa_collection_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _row public.mpesa_settings%ROWTYPE;
  _complete boolean;
BEGIN
  IF _org IS NULL THEN
    RETURN jsonb_build_object('ready', false, 'configured', false, 'enabled', false,
      'reason', 'No workspace is linked to this account.');
  END IF;

  SELECT * INTO _row FROM public.mpesa_settings WHERE organization_id = _org;

  IF _row.organization_id IS NULL THEN
    RETURN jsonb_build_object('ready', false, 'configured', false, 'enabled', false,
      'reason', 'M-Pesa has not been set up for this workspace yet.');
  END IF;

  _complete :=
    NULLIF(btrim(COALESCE(_row.short_code, '')), '') IS NOT NULL
    AND NULLIF(btrim(COALESCE(_row.consumer_key, '')), '') IS NOT NULL
    AND NULLIF(btrim(COALESCE(_row.consumer_secret, '')), '') IS NOT NULL
    AND NULLIF(btrim(COALESCE(_row.passkey, '')), '') IS NOT NULL;

  RETURN jsonb_build_object(
    'ready', _complete AND COALESCE(_row.enabled, false),
    'configured', _complete,
    'enabled', COALESCE(_row.enabled, false),
    'environment', COALESCE(_row.environment, 'sandbox'),
    'reason', CASE
      WHEN NOT _complete THEN 'M-Pesa setup is incomplete: the paybill or till number and the Daraja credentials are still missing.'
      WHEN NOT COALESCE(_row.enabled, false) THEN 'M-Pesa is set up but is switched off for collections.'
      ELSE NULL END
  );
END; $function$;

REVOKE ALL ON FUNCTION public.neo_mpesa_collection_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_mpesa_collection_status() TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_mpesa_settings_save(_environment text, _short_code text, _party_b text, _account_reference text, _transaction_type text, _consumer_key text DEFAULT NULL::text, _consumer_secret text DEFAULT NULL::text, _passkey text DEFAULT NULL::text, _callback_base_url text DEFAULT NULL::text, _enabled boolean DEFAULT false, _clear_secrets boolean DEFAULT false, _rotate_token boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _env text := lower(btrim(COALESCE(_environment, 'sandbox')));
  _existing public.mpesa_settings%ROWTYPE;
  _short text := NULLIF(btrim(COALESCE(_short_code, '')), '');
  _key text := NULLIF(btrim(COALESCE(_consumer_key, '')), '');
  _secret text := NULLIF(btrim(COALESCE(_consumer_secret, '')), '');
  _pass text := NULLIF(btrim(COALESCE(_passkey, '')), '');
  _final_short text;
  _has_key boolean;
  _has_secret boolean;
  _has_pass boolean;
BEGIN
  IF _org IS NULL OR NOT public.neo_mpesa_admin() THEN
    RETURN jsonb_build_object('authorised', false, 'reason', 'You do not have permission to configure M-Pesa.');
  END IF;
  IF _env NOT IN ('sandbox', 'production') THEN
    RETURN jsonb_build_object('authorised', true, 'saved', false, 'reason', 'Environment must be sandbox or production.');
  END IF;

  SELECT * INTO _existing FROM public.mpesa_settings WHERE organization_id = _org;

  -- Blank boxes never erase a saved identifier or credential; clearing secrets is explicit.
  _final_short := COALESCE(_short, _existing.short_code);
  _has_key := NOT _clear_secrets AND COALESCE(_key, _existing.consumer_key) IS NOT NULL;
  _has_secret := NOT _clear_secrets AND COALESCE(_secret, _existing.consumer_secret) IS NOT NULL;
  _has_pass := NOT _clear_secrets AND COALESCE(_pass, _existing.passkey) IS NOT NULL;

  IF COALESCE(_enabled, false) AND NOT (_final_short IS NOT NULL AND _has_key AND _has_secret AND _has_pass) THEN
    RETURN jsonb_build_object('authorised', true, 'saved', false,
      'reason', 'Collections cannot be switched on until the paybill or till number, consumer key, consumer secret and passkey are all saved.');
  END IF;

  INSERT INTO public.mpesa_settings AS t (
    organization_id, environment, short_code, party_b, account_reference, transaction_type,
    consumer_key, consumer_secret, passkey, callback_base_url, callback_token, enabled, updated_by, updated_at)
  VALUES (
    _org, _env,
    _short,
    NULLIF(btrim(COALESCE(_party_b, '')), ''),
    NULLIF(btrim(COALESCE(_account_reference, '')), ''),
    COALESCE(NULLIF(btrim(COALESCE(_transaction_type, '')), ''), 'CustomerPayBillOnline'),
    _key, _secret, _pass,
    NULLIF(btrim(COALESCE(_callback_base_url, '')), ''),
    public.neo_random_token(24),
    COALESCE(_enabled, false), auth.uid(), now())
  ON CONFLICT (organization_id) DO UPDATE
    SET environment = EXCLUDED.environment,
        short_code = COALESCE(EXCLUDED.short_code, t.short_code),
        party_b = COALESCE(EXCLUDED.party_b, t.party_b),
        account_reference = COALESCE(EXCLUDED.account_reference, t.account_reference),
        transaction_type = EXCLUDED.transaction_type,
        callback_base_url = EXCLUDED.callback_base_url,
        enabled = EXCLUDED.enabled,
        consumer_key = CASE WHEN _clear_secrets THEN NULL
                            WHEN EXCLUDED.consumer_key IS NOT NULL THEN EXCLUDED.consumer_key
                            ELSE t.consumer_key END,
        consumer_secret = CASE WHEN _clear_secrets THEN NULL
                               WHEN EXCLUDED.consumer_secret IS NOT NULL THEN EXCLUDED.consumer_secret
                               ELSE t.consumer_secret END,
        passkey = CASE WHEN _clear_secrets THEN NULL
                       WHEN EXCLUDED.passkey IS NOT NULL THEN EXCLUDED.passkey
                       ELSE t.passkey END,
        callback_token = CASE WHEN _rotate_token OR t.callback_token IS NULL
                              THEN public.neo_random_token(24) ELSE t.callback_token END,
        updated_by = auth.uid(),
        updated_at = now();

  RETURN jsonb_build_object('authorised', true, 'saved', true);
END; $function$;