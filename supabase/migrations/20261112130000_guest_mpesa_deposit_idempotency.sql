-- LOCAL CHANGE — do not apply to a live database without normal approval.
-- Serialize guest deposit prompts and prevent successful prompts from
-- crediting more than the reservation's remaining required deposit.

UPDATE public.mpesa_transactions
   SET raw_request = jsonb_set(raw_request, '{CallBackURL}', '"[redacted]"'::jsonb, false)
 WHERE raw_request ? 'CallBackURL';

CREATE TABLE IF NOT EXISTS public.mpesa_deposit_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid,
  reservation_id uuid NOT NULL REFERENCES public.reservations(id) ON DELETE CASCADE,
  transaction_id uuid NOT NULL UNIQUE REFERENCES public.mpesa_transactions(id) ON DELETE CASCADE,
  amount_received numeric(14,2) NOT NULL CHECK (amount_received > 0),
  amount_applied numeric(14,2) NOT NULL DEFAULT 0 CHECK (amount_applied >= 0),
  excess_amount numeric(14,2) NOT NULL CHECK (excess_amount > 0),
  status text NOT NULL DEFAULT 'refund_required'
    CHECK (status IN ('refund_required', 'refunded', 'resolved')),
  detail text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid
);

CREATE INDEX IF NOT EXISTS mpesa_deposit_exceptions_org_status
  ON public.mpesa_deposit_exceptions (organization_id, status, created_at DESC);

ALTER TABLE public.mpesa_deposit_exceptions ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.mpesa_deposit_exceptions TO service_role;

CREATE OR REPLACE FUNCTION public.neo_guest_deposit_pay(
  _org uuid,
  _reference text,
  _msisdn text,
  _amount numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _cust uuid := public.my_customer_id();
  _res public.reservations;
  _pos jsonb;
  _due numeric;
  _take numeric;
  _digits text;
  _env text;
  _code text;
  _txn uuid;
  _existing_amount numeric;
  _existing_status text;
BEGIN
  IF _cust IS NULL THEN RAISE EXCEPTION 'This account is not linked to a guest profile'; END IF;

  SELECT * INTO _res
    FROM public.reservations
   WHERE organization_id = _org
     AND confirmation_number = _reference
     AND customer_id = _cust
   FOR UPDATE;
  IF _res.id IS NULL THEN RAISE EXCEPTION 'Reservation not found'; END IF;

  SELECT id, amount, status
    INTO _txn, _existing_amount, _existing_status
    FROM public.mpesa_transactions
   WHERE organization_id = _org
     AND source_module = 'reservation_deposit'
     AND source_record_id = _res.id
     AND status IN ('initiated', 'pending')
     AND applied_at IS NULL
   ORDER BY created_at DESC
   LIMIT 1
   FOR UPDATE;

  IF _txn IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', true,
      'transaction_id', _txn,
      'amount', _existing_amount,
      'reservation_id', _res.id,
      'confirmation_number', _res.confirmation_number,
      'reused', true,
      'status', _existing_status
    );
  END IF;

  _pos := public.neo_guest_reservation_position(_org, _reference);
  _due := COALESCE((_pos->>'outstanding')::numeric, 0);
  IF _due <= 0 THEN RAISE EXCEPTION 'No deposit is outstanding on this booking'; END IF;

  _take := LEAST(COALESCE(NULLIF(_amount, 0), _due), _due);
  IF _take <= 0 THEN RAISE EXCEPTION 'Payment amount must be greater than zero'; END IF;

  _digits := regexp_replace(COALESCE(_msisdn, ''), '[^0-9]', '', 'g');
  IF length(_digits) < 9 THEN RAISE EXCEPTION 'A valid mobile number is required'; END IF;

  SELECT environment, short_code
    INTO _env, _code
    FROM public.mpesa_settings
   WHERE organization_id = _org
     AND COALESCE(enabled, true);
  IF _code IS NULL THEN
    RAISE EXCEPTION 'This property cannot take a mobile payment yet — please settle at the front desk';
  END IF;

  INSERT INTO public.mpesa_transactions (
    organization_id, branch_id, source_module, source_record_id, payment_table, payment_id,
    msisdn, amount, account_reference, description, environment, short_code, status, created_by
  )
  VALUES (
    _org, _res.branch_id, 'reservation_deposit', _res.id, NULL, NULL,
    _digits, round(_take, 2), _res.confirmation_number,
    'Booking deposit ' || _res.confirmation_number, COALESCE(_env, 'sandbox'), _code,
    'initiated', NULL
  )
  RETURNING id INTO _txn;

  RETURN jsonb_build_object(
    'ok', true,
    'transaction_id', _txn,
    'amount', round(_take, 2),
    'reservation_id', _res.id,
    'confirmation_number', _res.confirmation_number,
    'reused', false,
    'status', 'initiated'
  );
END
$function$;

REVOKE ALL ON FUNCTION public.neo_guest_deposit_pay(uuid, text, text, numeric)
  FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_guest_deposit_pay(uuid, text, text, numeric)
  TO authenticated, service_role;

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
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _env text := lower(btrim(COALESCE(_environment, 'sandbox')));
  _existing public.mpesa_settings;
BEGIN
  IF _org IS NULL OR NOT public.neo_mpesa_admin() THEN
    RETURN jsonb_build_object(
      'authorised', false,
      'reason', 'You do not have permission to configure M-Pesa.'
    );
  END IF;
  IF _env NOT IN ('sandbox', 'production') THEN
    RETURN jsonb_build_object(
      'authorised', true,
      'saved', false,
      'reason', 'Environment must be sandbox or production.'
    );
  END IF;

  SELECT * INTO _existing
    FROM public.mpesa_settings
   WHERE organization_id = _org
   FOR UPDATE;

  IF _existing.organization_id IS NOT NULL
     AND _existing.environment IS DISTINCT FROM _env THEN
    IF EXISTS (
      SELECT 1
        FROM public.mpesa_transactions
       WHERE organization_id = _org
         AND status IN ('initiated', 'pending')
         AND applied_at IS NULL
    ) THEN
      RETURN jsonb_build_object(
        'authorised', true,
        'saved', false,
        'reason', 'Resolve active M-Pesa prompts before changing the environment.'
      );
    END IF;

    IF _clear_secrets
       OR NULLIF(btrim(COALESCE(_consumer_key, '')), '') IS NULL
       OR NULLIF(btrim(COALESCE(_consumer_secret, '')), '') IS NULL
       OR NULLIF(btrim(COALESCE(_passkey, '')), '') IS NULL THEN
      RETURN jsonb_build_object(
        'authorised', true,
        'saved', false,
        'reason', 'Enter the selected environment credentials. Credentials from the other environment are not reused.'
      );
    END IF;
  END IF;

  INSERT INTO public.mpesa_settings AS t (
    organization_id, environment, short_code, party_b, account_reference, transaction_type,
    consumer_key, consumer_secret, passkey, callback_base_url, enabled, updated_by, updated_at
  )
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
    COALESCE(_enabled, false), auth.uid(), now()
  )
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
        callback_token = CASE
          WHEN _rotate_token THEN encode(gen_random_bytes(24), 'hex')
          ELSE t.callback_token
        END,
        last_check_at = CASE WHEN t.environment IS DISTINCT FROM EXCLUDED.environment THEN NULL ELSE t.last_check_at END,
        last_check_status = CASE WHEN t.environment IS DISTINCT FROM EXCLUDED.environment THEN NULL ELSE t.last_check_status END,
        last_check_detail = CASE WHEN t.environment IS DISTINCT FROM EXCLUDED.environment THEN NULL ELSE t.last_check_detail END,
        updated_by = auth.uid(),
        updated_at = now();

  INSERT INTO public.audit_logs (organization_id, user_id, action, module, record_id, new_value)
  VALUES (
    _org, auth.uid(), 'integration.mpesa.settings', 'administration', _org::text,
    jsonb_build_object('environment', _env, 'enabled', COALESCE(_enabled, false))
  );

  RETURN jsonb_build_object('authorised', true, 'saved', true);
END
$function$;

REVOKE ALL ON FUNCTION public.neo_mpesa_settings_save(
  text, text, text, text, text, text, text, text, text, boolean, boolean, boolean
) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_mpesa_settings_save(
  text, text, text, text, text, text, text, text, text, boolean, boolean, boolean
) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_mpesa_guard_guest_deposit_success()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _txn public.mpesa_transactions;
  _res public.reservations;
  _required numeric;
  _paid numeric;
  _available numeric;
  _applied numeric;
  _excess numeric;
BEGIN
  IF NEW.method <> 'mpesa'
     OR NEW.idempotency_key IS NULL
     OR NEW.idempotency_key NOT LIKE 'mpesa-deposit:%' THEN
    RETURN NEW;
  END IF;

  IF substr(NEW.idempotency_key, length('mpesa-deposit:') + 1)
       !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'Guest M-Pesa deposit identity is invalid';
  END IF;

  SELECT * INTO _txn
    FROM public.mpesa_transactions
   WHERE id = substr(NEW.idempotency_key, length('mpesa-deposit:') + 1)::uuid
     AND organization_id = NEW.organization_id
     AND source_module = 'reservation_deposit'
     AND source_record_id = NEW.reservation_id
     AND status = 'success'
     AND applied_at IS NOT NULL
   FOR UPDATE;
  IF _txn.id IS NULL THEN
    RAISE EXCEPTION 'Successful M-Pesa transaction for guest deposit could not be verified';
  END IF;

  SELECT * INTO _res
    FROM public.reservations
   WHERE id = NEW.reservation_id
     AND organization_id = NEW.organization_id
   FOR UPDATE;
  IF _res.id IS NULL THEN
    RAISE EXCEPTION 'Reservation for M-Pesa deposit could not be verified';
  END IF;

  _required := GREATEST(COALESCE(_res.deposit_required, 0), 0);
  SELECT COALESCE(sum(amount), 0)
    INTO _paid
    FROM public.reservation_deposits
   WHERE organization_id = NEW.organization_id
     AND reservation_id = _res.id
     AND status IN ('held', 'applied');

  _available := GREATEST(_required - _paid, 0);
  _applied := LEAST(round(NEW.amount, 2), _available);
  _excess := GREATEST(round(NEW.amount, 2) - _applied, 0);

  IF _excess > 0 THEN
    INSERT INTO public.mpesa_deposit_exceptions (
      organization_id, branch_id, reservation_id, transaction_id,
      amount_received, amount_applied, excess_amount, detail
    )
    VALUES (
      NEW.organization_id, COALESCE(NEW.branch_id, _res.branch_id), _res.id, _txn.id,
      round(NEW.amount, 2), _applied, _excess,
      'M-Pesa deposit exceeds the reservation amount remaining; excess requires refund review.'
    )
    ON CONFLICT (transaction_id) DO NOTHING;
  END IF;

  IF _applied <= 0 THEN
    RETURN NULL;
  END IF;

  NEW.amount := _applied;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS mpesa_guard_guest_deposit_success ON public.reservation_deposits;
CREATE TRIGGER mpesa_guard_guest_deposit_success
  BEFORE INSERT ON public.reservation_deposits
  FOR EACH ROW
  EXECUTE FUNCTION public.neo_mpesa_guard_guest_deposit_success();
