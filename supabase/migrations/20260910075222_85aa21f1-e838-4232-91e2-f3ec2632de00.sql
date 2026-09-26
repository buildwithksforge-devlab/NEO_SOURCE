-- 1. M-Pesa save: never discard a partial setup; report what is missing instead.
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
  _missing text[] := ARRAY[]::text[];
  _can_enable boolean;
BEGIN
  IF _org IS NULL OR NOT public.neo_mpesa_admin() THEN
    RETURN jsonb_build_object('authorised', false, 'reason', 'You do not have permission to configure M-Pesa.');
  END IF;
  IF _env NOT IN ('sandbox', 'production') THEN
    RETURN jsonb_build_object('authorised', true, 'saved', false, 'reason', 'Environment must be sandbox or production.');
  END IF;

  SELECT * INTO _existing FROM public.mpesa_settings WHERE organization_id = _org;

  -- Blank boxes never erase a saved identifier or credential; clearing secrets is explicit.
  _final_short := COALESCE(_short, NULLIF(btrim(COALESCE(_existing.short_code, '')), ''));
  _has_key := NOT _clear_secrets AND COALESCE(_key, NULLIF(btrim(COALESCE(_existing.consumer_key, '')), '')) IS NOT NULL;
  _has_secret := NOT _clear_secrets AND COALESCE(_secret, NULLIF(btrim(COALESCE(_existing.consumer_secret, '')), '')) IS NOT NULL;
  _has_pass := NOT _clear_secrets AND COALESCE(_pass, NULLIF(btrim(COALESCE(_existing.passkey, '')), '')) IS NOT NULL;

  IF _final_short IS NULL THEN _missing := _missing || 'business short code'; END IF;
  IF NOT _has_key THEN _missing := _missing || 'consumer key'; END IF;
  IF NOT _has_secret THEN _missing := _missing || 'consumer secret'; END IF;
  IF NOT _has_pass THEN _missing := _missing || 'passkey'; END IF;
  _can_enable := array_length(_missing, 1) IS NULL;

  -- Everything the administrator typed is kept. Only the switch waits.
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
    COALESCE(_enabled, false) AND _can_enable, auth.uid(), now())
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

  RETURN jsonb_build_object(
    'authorised', true,
    'saved', true,
    'complete', _can_enable,
    'enabled', COALESCE(_enabled, false) AND _can_enable,
    'enable_blocked', COALESCE(_enabled, false) AND NOT _can_enable,
    'missing', to_jsonb(_missing),
    'reason', CASE WHEN COALESCE(_enabled, false) AND NOT _can_enable
      THEN 'Saved, but collections stay switched off until these are provided: ' || array_to_string(_missing, ', ')
      ELSE NULL END
  );
END; $function$;

-- 2. Collection status names the missing fields.
CREATE OR REPLACE FUNCTION public.neo_mpesa_collection_status()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _row public.mpesa_settings%ROWTYPE;
  _missing text[] := ARRAY[]::text[];
  _complete boolean;
BEGIN
  IF _org IS NULL THEN
    RETURN jsonb_build_object('ready', false, 'configured', false, 'enabled', false, 'missing', '[]'::jsonb,
      'config_path', '/admin/payments-mpesa', 'reason', 'No workspace is linked to this account.');
  END IF;

  SELECT * INTO _row FROM public.mpesa_settings WHERE organization_id = _org;

  IF _row.organization_id IS NULL THEN
    RETURN jsonb_build_object('ready', false, 'configured', false, 'enabled', false,
      'missing', to_jsonb(ARRAY['business short code','consumer key','consumer secret','passkey']),
      'config_path', '/admin/payments-mpesa',
      'reason', 'M-Pesa has not been set up for this workspace yet.');
  END IF;

  IF NULLIF(btrim(COALESCE(_row.short_code, '')), '') IS NULL THEN _missing := _missing || 'business short code'; END IF;
  IF NULLIF(btrim(COALESCE(_row.consumer_key, '')), '') IS NULL THEN _missing := _missing || 'consumer key'; END IF;
  IF NULLIF(btrim(COALESCE(_row.consumer_secret, '')), '') IS NULL THEN _missing := _missing || 'consumer secret'; END IF;
  IF NULLIF(btrim(COALESCE(_row.passkey, '')), '') IS NULL THEN _missing := _missing || 'passkey'; END IF;
  IF NULLIF(btrim(COALESCE(_row.callback_token, '')), '') IS NULL THEN _missing := _missing || 'callback token'; END IF;
  _complete := array_length(_missing, 1) IS NULL;

  RETURN jsonb_build_object(
    'ready', _complete AND COALESCE(_row.enabled, false),
    'configured', _complete,
    'enabled', COALESCE(_row.enabled, false),
    'environment', COALESCE(_row.environment, 'sandbox'),
    'missing', to_jsonb(_missing),
    'config_path', '/admin/payments-mpesa',
    'last_check_at', _row.last_check_at,
    'last_check_status', _row.last_check_status,
    'reason', CASE
      WHEN NOT _complete THEN 'M-Pesa setup is incomplete. Still needed: ' || array_to_string(_missing, ', ') || '.'
      WHEN NOT COALESCE(_row.enabled, false) THEN 'M-Pesa is set up but is switched off for collections.'
      ELSE NULL END
  );
END; $function$;

-- 3. One workspace-wide payment readiness report.
CREATE OR REPLACE FUNCTION public.neo_payment_readiness()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _out jsonb := '[]'::jsonb;
  _mpesa jsonb;
  _row record;
BEGIN
  IF _org IS NULL THEN RETURN _out; END IF;

  -- Recorded tenders: the money moves outside NEO and the entry is its record.
  _out := jsonb_build_array(
    jsonb_build_object('method','cash','label','Cash','kind','recorded','ready',true,
      'hint','Received into a till and receipted.'),
    jsonb_build_object('method','card','label','Card (recorded)','kind','recorded','ready',true,
      'hint','Taken on the bank terminal and recorded here with its reference.'),
    jsonb_build_object('method','bank-transfer','label','Bank transfer','kind','recorded','ready',true,
      'hint','Recorded against the bank account and matched at reconciliation.'),
    jsonb_build_object('method','corporate-credit','label','Corporate credit','kind','recorded','ready',true,
      'hint','Billed to the company account under its credit terms.'),
    jsonb_build_object('method','voucher','label','Voucher','kind','recorded','ready',true,
      'hint','Redeemed against a voucher reference.'),
    jsonb_build_object('method','ota-prepaid','label','OTA prepaid / VCC','kind','recorded','ready',true,
      'hint','Already collected by the travel agent; recorded for settlement.'),
    jsonb_build_object('method','room-charge','label','Room / folio charge','kind','recorded','ready',true,
      'hint','Posted to the guest folio and settled at departure.')
  );

  _mpesa := public.neo_mpesa_collection_status();
  _out := _out || jsonb_build_array(jsonb_build_object(
    'method','mpesa','label','M-Pesa','kind','provider','provider_code','daraja',
    'ready', COALESCE((_mpesa->>'ready')::boolean, false),
    'configured', COALESCE((_mpesa->>'configured')::boolean, false),
    'enabled', COALESCE((_mpesa->>'enabled')::boolean, false),
    'environment', _mpesa->>'environment',
    'missing', COALESCE(_mpesa->'missing', '[]'::jsonb),
    'reason', _mpesa->>'reason',
    'last_test_at', _mpesa->>'last_check_at',
    'last_test_status', _mpesa->>'last_check_status',
    'config_path','/admin/payments-mpesa',
    'hint','NEO sends the prompt and waits for Safaricom to confirm it.'
  ));

  -- Provider-backed tenders that depend on an external acquirer.
  FOR _row IN
    SELECT p.code, p.name,
           c.environment, c.enabled, c.secret_names, c.sandbox_test_passed_at,
           c.security_review_passed_at, c.production_approved_at, c.last_error, c.last_success_at,
           (SELECT jsonb_build_object('at', t.created_at, 'status', t.status, 'detail', COALESCE(t.error_message, t.response_summary))
              FROM public.integration_test_runs t
             WHERE t.organization_id = _org AND t.provider_code = p.code
             ORDER BY t.created_at DESC LIMIT 1) AS last_test
      FROM public.integration_providers p
      LEFT JOIN public.integration_connections c
        ON c.provider_code = p.code AND c.organization_id = _org
     WHERE p.code IN ('card_terminal','qr_payments')
  LOOP
    _out := _out || jsonb_build_array(jsonb_build_object(
      'method', CASE _row.code WHEN 'card_terminal' THEN 'card-terminal' ELSE 'qr' END,
      'label', CASE _row.code WHEN 'card_terminal' THEN 'Card terminal (integrated)' ELSE 'QR payment' END,
      'kind','provider','provider_code', _row.code,
      'ready', COALESCE(_row.enabled, false)
               AND _row.sandbox_test_passed_at IS NOT NULL
               AND jsonb_array_length(COALESCE(_row.secret_names, '[]'::jsonb)) > 0,
      'configured', jsonb_array_length(COALESCE(_row.secret_names, '[]'::jsonb)) > 0,
      'enabled', COALESCE(_row.enabled, false),
      'environment', COALESCE(_row.environment, 'sandbox'),
      'sandbox_test_passed_at', _row.sandbox_test_passed_at,
      'production_approved_at', _row.production_approved_at,
      'security_review_passed_at', _row.security_review_passed_at,
      'last_test', _row.last_test,
      'last_error', _row.last_error,
      'config_path','/platform/integrations',
      'reason', CASE
        WHEN jsonb_array_length(COALESCE(_row.secret_names, '[]'::jsonb)) = 0
          THEN 'No processor is connected yet, so this can only be recorded manually.'
        WHEN _row.sandbox_test_passed_at IS NULL THEN 'Connected but never tested successfully.'
        WHEN NOT COALESCE(_row.enabled, false) THEN 'Connected but switched off for this workspace.'
        ELSE NULL END,
      'hint', CASE _row.code
        WHEN 'card_terminal' THEN 'A supported terminal or acquirer returns the authorisation and settlement reference.'
        ELSE 'A QR provider confirms the payment before it is treated as received.' END
    ));
  END LOOP;

  RETURN _out;
END; $function$;

REVOKE ALL ON FUNCTION public.neo_payment_readiness() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_payment_readiness() TO authenticated;

-- 4. Recorded provider test: the only way sandbox evidence is written.
CREATE OR REPLACE FUNCTION public.neo_integration_record_test(_provider text, _environment text, _test_type text, _status text, _detail text DEFAULT NULL::text, _duration_ms integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _conn public.integration_connections%ROWTYPE;
  _env text := lower(btrim(COALESCE(_environment, 'sandbox')));
  _st text := lower(btrim(COALESCE(_status, 'failed')));
BEGIN
  IF _org IS NULL
     OR NOT (COALESCE(public.is_org_admin(), false)
             OR COALESCE(public.has_permission('integrations', 'providers', 'edit'), false)
             OR COALESCE(public.has_permission('administration', 'workspace', 'edit'), false)) THEN
    RETURN jsonb_build_object('recorded', false, 'reason', 'You do not have permission to test integrations.');
  END IF;
  IF _st NOT IN ('passed','failed','not_configured','unsupported') THEN
    RETURN jsonb_build_object('recorded', false, 'reason', 'Unknown test outcome.');
  END IF;

  SELECT * INTO _conn FROM public.integration_connections
   WHERE organization_id = _org AND provider_code = _provider LIMIT 1;

  INSERT INTO public.integration_test_runs (
    organization_id, connection_id, provider_code, environment, test_type, status,
    duration_ms, response_summary, error_message, run_by)
  VALUES (_org, _conn.id, _provider, _env, COALESCE(NULLIF(btrim(_test_type), ''), 'connection'), _st,
    _duration_ms,
    CASE WHEN _st = 'passed' THEN _detail END,
    CASE WHEN _st <> 'passed' THEN _detail END,
    auth.uid());

  IF _conn.id IS NOT NULL THEN
    UPDATE public.integration_connections
       SET sandbox_test_passed_at = CASE WHEN _st = 'passed' AND _env <> 'production'
                                         THEN now() ELSE sandbox_test_passed_at END,
           last_success_at = CASE WHEN _st = 'passed' THEN now() ELSE last_success_at END,
           last_error = CASE WHEN _st = 'passed' THEN NULL ELSE COALESCE(_detail, 'Test did not pass') END,
           last_error_at = CASE WHEN _st = 'passed' THEN NULL ELSE now() END,
           error_count = CASE WHEN _st = 'passed' THEN 0 ELSE error_count + 1 END,
           health = CASE WHEN _st = 'passed' THEN 'healthy' ELSE 'unhealthy' END,
           updated_at = now()
     WHERE id = _conn.id;
  END IF;

  RETURN jsonb_build_object('recorded', true, 'status', _st, 'connection_id', _conn.id);
END; $function$;

REVOKE ALL ON FUNCTION public.neo_integration_record_test(text, text, text, text, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_integration_record_test(text, text, text, text, text, integer) TO authenticated;