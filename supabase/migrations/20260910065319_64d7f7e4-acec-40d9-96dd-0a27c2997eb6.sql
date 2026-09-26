CREATE OR REPLACE FUNCTION public.neo_random_token(_bytes integer DEFAULT 24)
RETURNS text
LANGUAGE sql
VOLATILE
SET search_path = public
AS $fn$
  SELECT substr(
    replace(gen_random_uuid()::text, '-', '') ||
    replace(gen_random_uuid()::text, '-', '') ||
    replace(gen_random_uuid()::text, '-', ''),
    1,
    greatest(32, least(96, COALESCE(_bytes, 24) * 2))
  );
$fn$;

REVOKE ALL ON FUNCTION public.neo_random_token(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_random_token(integer) TO authenticated, service_role;

ALTER TABLE public.mpesa_settings
  ALTER COLUMN callback_token SET DEFAULT public.neo_random_token(24);

CREATE OR REPLACE FUNCTION public.neo_mpesa_settings_save(
  _environment text,
  _short_code text,
  _party_b text,
  _account_reference text,
  _transaction_type text,
  _consumer_key text DEFAULT NULL,
  _consumer_secret text DEFAULT NULL,
  _passkey text DEFAULT NULL,
  _callback_base_url text DEFAULT NULL,
  _enabled boolean DEFAULT false,
  _clear_secrets boolean DEFAULT false,
  _rotate_token boolean DEFAULT false
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE _org uuid := public.current_org_id(); _env text := lower(btrim(COALESCE(_environment, 'sandbox')));
BEGIN
  IF _org IS NULL OR NOT public.neo_mpesa_admin() THEN
    RETURN jsonb_build_object('authorised', false, 'reason', 'You do not have permission to configure M-Pesa.');
  END IF;
  IF _env NOT IN ('sandbox', 'production') THEN
    RETURN jsonb_build_object('authorised', true, 'saved', false, 'reason', 'Environment must be sandbox or production.');
  END IF;

  INSERT INTO public.mpesa_settings AS t (
    organization_id, environment, short_code, party_b, account_reference, transaction_type,
    consumer_key, consumer_secret, passkey, callback_base_url, callback_token, enabled, updated_by, updated_at)
  VALUES (
    _org, _env,
    NULLIF(btrim(COALESCE(_short_code, '')), ''),
    NULLIF(btrim(COALESCE(_party_b, '')), ''),
    NULLIF(btrim(COALESCE(_account_reference, '')), ''),
    COALESCE(NULLIF(btrim(COALESCE(_transaction_type, '')), ''), 'CustomerPayBillOnline'),
    NULLIF(btrim(COALESCE(_consumer_key, '')), ''),
    NULLIF(btrim(COALESCE(_consumer_secret, '')), ''),
    NULLIF(btrim(COALESCE(_passkey, '')), ''),
    NULLIF(btrim(COALESCE(_callback_base_url, '')), ''),
    public.neo_random_token(24),
    COALESCE(_enabled, false), auth.uid(), now())
  ON CONFLICT (organization_id) DO UPDATE
    SET environment = EXCLUDED.environment,
        short_code = EXCLUDED.short_code,
        party_b = EXCLUDED.party_b,
        account_reference = EXCLUDED.account_reference,
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
        callback_token = CASE WHEN _rotate_token THEN public.neo_random_token(24) ELSE t.callback_token END,
        last_check_at = CASE WHEN t.environment IS DISTINCT FROM EXCLUDED.environment THEN NULL ELSE t.last_check_at END,
        last_check_status = CASE WHEN t.environment IS DISTINCT FROM EXCLUDED.environment THEN NULL ELSE t.last_check_status END,
        last_check_detail = CASE WHEN t.environment IS DISTINCT FROM EXCLUDED.environment THEN NULL ELSE t.last_check_detail END,
        updated_by = auth.uid(),
        updated_at = now();

  INSERT INTO public.audit_logs (organization_id, user_id, action, module, record_id, new_value)
  VALUES (_org, auth.uid(), 'integration.mpesa.settings', 'administration', _org::text,
          jsonb_build_object('environment', _env, 'enabled', COALESCE(_enabled, false)));

  RETURN jsonb_build_object('authorised', true, 'saved', true);
END; $fn$;