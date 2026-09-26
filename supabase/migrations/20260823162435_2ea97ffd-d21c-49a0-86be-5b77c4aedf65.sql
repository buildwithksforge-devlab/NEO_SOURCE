CREATE TABLE IF NOT EXISTS public.mpesa_settings (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  environment text NOT NULL DEFAULT 'sandbox',
  short_code text,
  party_b text,
  account_reference text,
  transaction_type text NOT NULL DEFAULT 'CustomerPayBillOnline',
  consumer_key text,
  consumer_secret text,
  passkey text,
  callback_token text NOT NULL DEFAULT encode(gen_random_bytes(24), 'hex'),
  callback_base_url text,
  enabled boolean NOT NULL DEFAULT false,
  last_check_at timestamptz,
  last_check_status text,
  last_check_detail text,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.mpesa_settings TO service_role;
ALTER TABLE public.mpesa_settings ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.mpesa_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid,
  source_module text NOT NULL,
  source_record_id uuid,
  payment_table text,
  payment_id uuid,
  msisdn text NOT NULL,
  amount numeric(14,2) NOT NULL,
  account_reference text,
  description text,
  environment text NOT NULL DEFAULT 'sandbox',
  short_code text,
  merchant_request_id text,
  checkout_request_id text,
  mpesa_receipt_number text,
  transaction_date text,
  result_code integer,
  result_desc text,
  status text NOT NULL DEFAULT 'initiated',
  failure_detail text,
  raw_request jsonb,
  raw_result jsonb,
  last_query_at timestamptz,
  reconciled_at timestamptz,
  applied_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS mpesa_transactions_checkout_key
  ON public.mpesa_transactions (checkout_request_id) WHERE checkout_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mpesa_transactions_org_created
  ON public.mpesa_transactions (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mpesa_transactions_source
  ON public.mpesa_transactions (source_module, source_record_id);

GRANT ALL ON public.mpesa_transactions TO service_role;
GRANT SELECT ON public.mpesa_transactions TO authenticated;
ALTER TABLE public.mpesa_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "mpesa transactions readable in scope" ON public.mpesa_transactions;
CREATE POLICY "mpesa transactions readable in scope"
  ON public.mpesa_transactions FOR SELECT TO authenticated
  USING (
    organization_id = public.current_org_id()
    AND (branch_id IS NULL OR public.neo_branch_in_scope(branch_id))
  );

CREATE TABLE IF NOT EXISTS public.mpesa_callback_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  transaction_id uuid REFERENCES public.mpesa_transactions(id) ON DELETE SET NULL,
  checkout_request_id text,
  source text NOT NULL DEFAULT 'callback',
  payload jsonb NOT NULL,
  accepted boolean NOT NULL DEFAULT true,
  detail text,
  received_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.mpesa_callback_events TO service_role;
GRANT SELECT ON public.mpesa_callback_events TO authenticated;
ALTER TABLE public.mpesa_callback_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "mpesa callback events readable in org" ON public.mpesa_callback_events;
CREATE POLICY "mpesa callback events readable in org"
  ON public.mpesa_callback_events FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());

CREATE OR REPLACE FUNCTION public.neo_mpesa_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT COALESCE(public.is_org_admin(), false)
      OR COALESCE(public.has_permission('administration', 'workspace', 'edit'), false);
$fn$;

CREATE OR REPLACE FUNCTION public.neo_mpesa_settings_get()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE _org uuid := public.current_org_id(); _row public.mpesa_settings%ROWTYPE;
BEGIN
  IF _org IS NULL THEN
    RETURN jsonb_build_object('authorised', false, 'reason', 'No organisation is linked to this account.');
  END IF;
  IF NOT public.neo_mpesa_admin() THEN
    RETURN jsonb_build_object('authorised', false, 'reason', 'You do not have permission to configure M-Pesa.');
  END IF;

  SELECT * INTO _row FROM public.mpesa_settings WHERE organization_id = _org;

  RETURN jsonb_build_object(
    'authorised', true,
    'configured', _row.organization_id IS NOT NULL,
    'environment', COALESCE(_row.environment, 'sandbox'),
    'short_code', _row.short_code,
    'party_b', _row.party_b,
    'account_reference', _row.account_reference,
    'transaction_type', COALESCE(_row.transaction_type, 'CustomerPayBillOnline'),
    'enabled', COALESCE(_row.enabled, false),
    'has_consumer_key', NULLIF(btrim(COALESCE(_row.consumer_key, '')), '') IS NOT NULL,
    'has_consumer_secret', NULLIF(btrim(COALESCE(_row.consumer_secret, '')), '') IS NOT NULL,
    'has_passkey', NULLIF(btrim(COALESCE(_row.passkey, '')), '') IS NOT NULL,
    'callback_token', _row.callback_token,
    'callback_base_url', _row.callback_base_url,
    'last_check_at', _row.last_check_at,
    'last_check_status', _row.last_check_status,
    'last_check_detail', _row.last_check_detail,
    'updated_at', _row.updated_at
  );
END; $fn$;

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
    consumer_key, consumer_secret, passkey, callback_base_url, enabled, updated_by, updated_at)
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
        callback_token = CASE WHEN _rotate_token THEN encode(gen_random_bytes(24), 'hex') ELSE t.callback_token END,
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

CREATE OR REPLACE FUNCTION public.neo_mpesa_record_check(_status text, _detail text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE _org uuid := public.current_org_id();
BEGIN
  IF _org IS NULL OR NOT public.neo_mpesa_admin() THEN
    RETURN jsonb_build_object('authorised', false);
  END IF;
  UPDATE public.mpesa_settings
     SET last_check_at = now(), last_check_status = _status, last_check_detail = _detail
   WHERE organization_id = _org;
  RETURN jsonb_build_object('authorised', true);
END; $fn$;

CREATE OR REPLACE FUNCTION public.neo_mpesa_can_collect(_source_module text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT CASE
    WHEN _source_module = 'pos_order' THEN COALESCE(public.has_permission('pos', 'payments', 'process'), false)
    WHEN _source_module = 'folio' THEN COALESCE(public.has_permission('pms', 'payments', 'record'), false)
    ELSE COALESCE(public.neo_mpesa_admin(), false)
  END;
$fn$;

CREATE OR REPLACE FUNCTION public.neo_mpesa_txn_start(
  _source_module text,
  _source_record uuid,
  _payment_table text,
  _payment_id uuid,
  _branch uuid,
  _msisdn text,
  _amount numeric,
  _account_reference text,
  _description text
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE _org uuid := public.current_org_id(); _id uuid; _env text; _code text; _digits text;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'No organisation is linked to this account'; END IF;
  IF NOT public.neo_mpesa_can_collect(_source_module) THEN
    RAISE EXCEPTION 'Not permitted to collect M-Pesa payments here';
  END IF;
  IF COALESCE(_amount, 0) <= 0 THEN RAISE EXCEPTION 'Payment amount must be greater than zero'; END IF;

  _digits := regexp_replace(COALESCE(_msisdn, ''), '[^0-9]', '', 'g');
  IF length(_digits) < 9 THEN RAISE EXCEPTION 'A valid customer phone number is required'; END IF;

  SELECT environment, short_code INTO _env, _code FROM public.mpesa_settings WHERE organization_id = _org;

  INSERT INTO public.mpesa_transactions (
    organization_id, branch_id, source_module, source_record_id, payment_table, payment_id,
    msisdn, amount, account_reference, description, environment, short_code, status, created_by)
  VALUES (_org, _branch, _source_module, _source_record, _payment_table, _payment_id,
          _digits, round(_amount, 2), NULLIF(btrim(COALESCE(_account_reference, '')), ''),
          NULLIF(btrim(COALESCE(_description, '')), ''), COALESCE(_env, 'sandbox'), _code,
          'initiated', auth.uid())
  RETURNING id INTO _id;

  RETURN _id;
END; $fn$;

CREATE OR REPLACE FUNCTION public.neo_mpesa_apply_result(
  _transaction uuid,
  _result_code integer,
  _result_desc text,
  _receipt text,
  _transaction_date text,
  _payload jsonb,
  _source text DEFAULT 'callback'
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE _t public.mpesa_transactions; _status text; _p public.pos_payments; _pay public.payments;
BEGIN
  SELECT * INTO _t FROM public.mpesa_transactions WHERE id = _transaction FOR UPDATE;
  IF _t.id IS NULL THEN RETURN jsonb_build_object('applied', false, 'reason', 'Transaction not found'); END IF;

  INSERT INTO public.mpesa_callback_events (organization_id, transaction_id, checkout_request_id, source, payload, detail)
  VALUES (_t.organization_id, _t.id, _t.checkout_request_id, _source, COALESCE(_payload, '{}'::jsonb), _result_desc);

  IF _t.applied_at IS NOT NULL THEN
    RETURN jsonb_build_object('applied', false, 'duplicate', true, 'status', _t.status);
  END IF;

  _status := CASE
    WHEN _result_code = 0 THEN 'success'
    WHEN _result_code = 1032 THEN 'cancelled'
    WHEN _result_code IN (1037, 1019) THEN 'timeout'
    ELSE 'failed' END;

  UPDATE public.mpesa_transactions
     SET status = _status,
         result_code = _result_code,
         result_desc = _result_desc,
         mpesa_receipt_number = COALESCE(NULLIF(btrim(COALESCE(_receipt, '')), ''), mpesa_receipt_number),
         transaction_date = COALESCE(_transaction_date, transaction_date),
         raw_result = COALESCE(_payload, raw_result),
         reconciled_at = now(),
         applied_at = now(),
         failure_detail = CASE WHEN _result_code = 0 THEN NULL ELSE _result_desc END,
         updated_at = now()
   WHERE id = _t.id;

  IF _status <> 'success' THEN
    IF _t.payment_table = 'pos_payments' AND _t.payment_id IS NOT NULL THEN
      UPDATE public.pos_payments SET status = 'failed', provider_status = COALESCE(_result_desc, 'provider-declined')
       WHERE id = _t.payment_id AND status IN ('initiated', 'pending');
    ELSIF _t.payment_table = 'payments' AND _t.payment_id IS NOT NULL THEN
      UPDATE public.payments SET status = 'failed' WHERE id = _t.payment_id AND status = 'pending';
    END IF;
    RETURN jsonb_build_object('applied', true, 'status', _status);
  END IF;

  IF _t.payment_table = 'pos_payments' AND _t.payment_id IS NOT NULL THEN
    SELECT * INTO _p FROM public.pos_payments WHERE id = _t.payment_id FOR UPDATE;
    IF _p.id IS NOT NULL AND _p.status IN ('initiated', 'pending') THEN
      UPDATE public.pos_payments
         SET status = 'confirmed', provider_status = 'provider-confirmed', paid_at = now(),
             external_reference = COALESCE(NULLIF(btrim(COALESCE(_receipt, '')), ''), external_reference)
       WHERE id = _p.id;
      PERFORM public.pos_reconcile_settlement_internal(_p.order_id);
    END IF;
  ELSIF _t.payment_table = 'payments' AND _t.payment_id IS NOT NULL THEN
    SELECT * INTO _pay FROM public.payments WHERE id = _t.payment_id FOR UPDATE;
    IF _pay.id IS NOT NULL AND _pay.status = 'pending' THEN
      UPDATE public.payments
         SET status = 'confirmed',
             external_reference = COALESCE(NULLIF(btrim(COALESCE(_receipt, '')), ''), external_reference)
       WHERE id = _pay.id;
      IF _pay.folio_id IS NOT NULL THEN
        INSERT INTO public.payment_allocations (organization_id, payment_id, folio_id, amount, created_by)
        VALUES (_pay.organization_id, _pay.id, _pay.folio_id, _pay.amount, _pay.received_by);
        UPDATE public.folios
           SET total_payments = total_payments + _pay.amount,
               balance = balance - _pay.amount,
               updated_at = now()
         WHERE id = _pay.folio_id;
      END IF;
    END IF;
  END IF;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, action, module, record_id, new_value)
  VALUES (_t.organization_id, _t.branch_id, _t.created_by, 'integration.mpesa.confirmed', 'finance', _t.id::text,
          jsonb_build_object('receipt', _receipt, 'amount', _t.amount, 'source', _source,
                             'sourceModule', _t.source_module, 'sourceRecord', _t.source_record_id));

  RETURN jsonb_build_object('applied', true, 'status', _status);
END; $fn$;

REVOKE ALL ON FUNCTION public.neo_mpesa_admin() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_mpesa_settings_get() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_mpesa_settings_save(text,text,text,text,text,text,text,text,text,boolean,boolean,boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_mpesa_record_check(text,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_mpesa_can_collect(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_mpesa_txn_start(text,uuid,text,uuid,uuid,text,numeric,text,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_mpesa_apply_result(uuid,integer,text,text,text,jsonb,text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.neo_mpesa_admin() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_mpesa_settings_get() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_mpesa_settings_save(text,text,text,text,text,text,text,text,text,boolean,boolean,boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_mpesa_record_check(text,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_mpesa_can_collect(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_mpesa_txn_start(text,uuid,text,uuid,uuid,text,numeric,text,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_mpesa_apply_result(uuid,integer,text,text,text,jsonb,text) TO service_role;