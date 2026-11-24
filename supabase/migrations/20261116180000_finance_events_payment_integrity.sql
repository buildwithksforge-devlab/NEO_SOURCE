-- NEØ Finance: Events payment state and payment identity integrity.
-- Staged only. Do not install without database acceptance testing.
BEGIN;

DO $preflight$
DECLARE
  ev_oid oid;
  ev_def text;
  conflicts bigint;
BEGIN
  ev_oid := to_regprocedure(
    'public.neo_event_billing_record_payment(uuid,numeric,text,text,text,text,uuid,text)'
  );

  IF ev_oid IS NULL THEN
    RAISE EXCEPTION 'Required Events payment function missing';
  END IF;

  ev_def := pg_get_functiondef(ev_oid);

  IF position(
    'An Events M-Pesa payment requires a verified provider collection'
    IN ev_def
  ) = 0 THEN
    RAISE EXCEPTION 'Existing Events M-Pesa guard must be preserved';
  END IF;

  IF length(ev_def) -
     length(replace(ev_def, '''partial'' END,', ''))
     <> length('''partial'' END,') THEN
    RAISE EXCEPTION 'Expected Events status correction point changed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.event_bookings'::regclass
      AND c.conname = 'event_bookings_pay_chk'
      AND pg_get_constraintdef(c.oid) LIKE '%partially-paid%'
  ) THEN
    RAISE EXCEPTION 'Events status constraint differs';
  END IF;

  -- Check existing linked receipts before enforcing strict matching.
  SELECT count(*) INTO conflicts
  FROM public.event_payments ep
  JOIN public.payments p ON p.id = ep.payment_id
  WHERE ep.payment_id IS NOT NULL
    AND (
      p.source_module IS DISTINCT FROM 'events'
      OR p.source_record_id IS DISTINCT FROM ep.booking_id
      OR (
        ep.entry_type IN ('deposit', 'payment')
        AND (
          p.amount IS DISTINCT FROM ep.amount
          OR p.currency IS DISTINCT FROM ep.currency
          OR lower(p.method) IS DISTINCT FROM lower(ep.method)
        )
      )
    );

  IF conflicts > 0 THEN
    RAISE EXCEPTION
      'Existing linked Event receipts require reconciliation: %',
      conflicts;
  END IF;

  -- Reject existing cross-organisation payment ownership before indexing.
  SELECT count(*) INTO conflicts
  FROM public.event_payments ep
  JOIN public.payments p ON p.id = ep.payment_id
  WHERE ep.payment_id IS NOT NULL
    AND p.organization_id IS DISTINCT FROM ep.organization_id;

  IF conflicts > 0 THEN
    RAISE EXCEPTION
      'Cross-organisation Events receipt ownership detected: %', conflicts;
  END IF;

  SELECT count(*) INTO conflicts
  FROM public.event_payments ep
  JOIN public.event_bookings b ON b.id = ep.booking_id
  WHERE b.organization_id IS DISTINCT FROM ep.organization_id;

  IF conflicts > 0 THEN
    RAISE EXCEPTION
      'Events booking and receipt organisations disagree: %', conflicts;
  END IF;
  SELECT count(*) INTO conflicts
  FROM (
    SELECT payment_id
    FROM public.event_payments
    WHERE payment_id IS NOT NULL
    GROUP BY payment_id
    HAVING count(*) > 1
  ) duplicates;

  IF conflicts > 0 THEN
    RAISE EXCEPTION
      'Duplicate Events payment ownership detected: %', conflicts;
  END IF;

  SELECT count(*) INTO conflicts
  FROM (
    SELECT organization_id, checkout_request_id
    FROM public.mpesa_transactions
    WHERE nullif(btrim(checkout_request_id), '') IS NOT NULL
    GROUP BY organization_id, checkout_request_id
    HAVING count(*) > 1
  ) duplicates;

  IF conflicts > 0 THEN
    RAISE EXCEPTION
      'Duplicate M-Pesa checkout identity detected: %', conflicts;
  END IF;

  SELECT count(*) INTO conflicts
  FROM (
    SELECT organization_id,
      upper(btrim(mpesa_receipt_number)) AS receipt
    FROM public.mpesa_transactions
    WHERE nullif(btrim(mpesa_receipt_number), '') IS NOT NULL
    GROUP BY organization_id, upper(btrim(mpesa_receipt_number))
    HAVING count(*) > 1
  ) duplicates;

  IF conflicts > 0 THEN
    RAISE EXCEPTION
      'Duplicate M-Pesa receipts detected: %', conflicts;
  END IF;
END
$preflight$;

DO $event_fix$
DECLARE
  oid_value oid;
  definition text;
BEGIN
  oid_value := to_regprocedure(
    'public.neo_event_billing_record_payment(uuid,numeric,text,text,text,text,uuid,text)'
  );

  definition := pg_get_functiondef(oid_value);

  definition := replace(
    definition,
    '''partial'' END,',
    '''partially-paid'' END,'
  );

  EXECUTE definition;
END
$event_fix$;

CREATE UNIQUE INDEX IF NOT EXISTS
  neo_fin_event_receipt_single_owner_uq
ON public.event_payments (payment_id)
WHERE payment_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS
  neo_fin_mpesa_checkout_org_uq
ON public.mpesa_transactions (
  organization_id,
  checkout_request_id
)
WHERE nullif(btrim(checkout_request_id), '') IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS
  neo_fin_mpesa_receipt_org_ci_uq
ON public.mpesa_transactions (
  organization_id,
  upper(btrim(mpesa_receipt_number))
)
WHERE nullif(btrim(mpesa_receipt_number), '') IS NOT NULL;

-- Enforce correct ownership on every future event payment link.
CREATE OR REPLACE FUNCTION public.neo_fin_event_payment_owner_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $owner_guard$
DECLARE
  booking_org uuid;
  booking_branch uuid;
  receipt_org uuid;
  receipt_branch uuid;
  receipt_source text;
  receipt_record uuid;
  receipt_amount numeric;
  receipt_currency text;
  receipt_method text;
BEGIN
  SELECT organization_id, branch_id
    INTO booking_org, booking_branch
    FROM public.event_bookings
   WHERE id = NEW.booking_id
   FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event booking does not exist'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.organization_id IS DISTINCT FROM booking_org
     OR NEW.branch_id IS DISTINCT FROM booking_branch THEN
    RAISE EXCEPTION
      'Event payment booking organisation or branch mismatch'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.payment_id IS NOT NULL THEN
    SELECT organization_id, branch_id,
           source_module, source_record_id,
           amount, currency, method
      INTO receipt_org, receipt_branch,
           receipt_source, receipt_record,
           receipt_amount, receipt_currency, receipt_method
      FROM public.payments
     WHERE id = NEW.payment_id
     FOR KEY SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Linked receipt does not exist'
        USING ERRCODE = '23503';
    END IF;

    IF receipt_org IS DISTINCT FROM booking_org
       OR receipt_branch IS DISTINCT FROM booking_branch THEN
      RAISE EXCEPTION
        'Event receipt organisation or branch mismatch'
        USING ERRCODE = '23514';
    END IF;

    IF receipt_source IS DISTINCT FROM 'events'
       OR receipt_record IS DISTINCT FROM NEW.booking_id THEN
      RAISE EXCEPTION
        'Event receipt belongs to a different booking'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.entry_type IN ('deposit', 'payment')
       AND (
         receipt_amount IS DISTINCT FROM NEW.amount
         OR receipt_currency IS DISTINCT FROM NEW.currency
         OR lower(receipt_method) IS DISTINCT FROM lower(NEW.method)
       ) THEN
      RAISE EXCEPTION
        'Event receipt amount, currency or method mismatch'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END
$owner_guard$;

REVOKE ALL ON FUNCTION
  public.neo_fin_event_payment_owner_guard()
FROM PUBLIC, anon, authenticated;

CREATE TRIGGER neo_fin_event_payment_owner_check
BEFORE INSERT OR UPDATE OF
  organization_id, branch_id, booking_id, payment_id,
  entry_type, method, amount, currency
ON public.event_payments
FOR EACH ROW
EXECUTE FUNCTION public.neo_fin_event_payment_owner_guard();

-- Once linked to an event, payment identity and financial details are immutable.
CREATE OR REPLACE FUNCTION public.neo_fin_guard_linked_event_receipt_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $receipt_lock$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.event_payments ep
    WHERE ep.payment_id = OLD.id
  ) AND (
    NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
    OR NEW.amount IS DISTINCT FROM OLD.amount
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.method IS DISTINCT FROM OLD.method
    OR NEW.source_module IS DISTINCT FROM OLD.source_module
    OR NEW.source_record_id IS DISTINCT FROM OLD.source_record_id
  ) THEN
    RAISE EXCEPTION
      'Linked Event receipt identity cannot be changed; use controlled reconciliation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$receipt_lock$;

REVOKE ALL ON FUNCTION
  public.neo_fin_guard_linked_event_receipt_update()
FROM PUBLIC, anon, authenticated;

CREATE TRIGGER neo_fin_event_receipt_immutable
BEFORE UPDATE OF
  organization_id, branch_id, amount, currency, method,
  source_module, source_record_id
ON public.payments
FOR EACH ROW
EXECUTE FUNCTION public.neo_fin_guard_linked_event_receipt_update();

-- A paid event must not silently move to another workspace or property.
CREATE OR REPLACE FUNCTION public.neo_fin_guard_paid_event_move()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $booking_lock$
BEGIN
  IF (
    NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
  ) AND EXISTS (
    SELECT 1 FROM public.event_payments ep
    WHERE ep.booking_id = OLD.id
  ) THEN
    RAISE EXCEPTION
      'An event with payment records cannot change organisation or branch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$booking_lock$;

REVOKE ALL ON FUNCTION
  public.neo_fin_guard_paid_event_move()
FROM PUBLIC, anon, authenticated;

CREATE TRIGGER neo_fin_paid_event_move_guard
BEFORE UPDATE OF organization_id, branch_id
ON public.event_bookings
FOR EACH ROW
EXECUTE FUNCTION public.neo_fin_guard_paid_event_move();

-- Events M-Pesa: authorised, read-only collection eligibility.
-- Does not create a pending receipt or allow STK dispatch.
CREATE OR REPLACE FUNCTION public.neo_fin_event_mpesa_quote(
  _booking uuid,
  _amount numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $event_quote$
DECLARE
  v_org uuid := public.current_org_id();
  v_event public.event_bookings;
  v_charged numeric := 0;
  v_paid numeric := 0;
  v_pending numeric := 0;
  v_available numeric := 0;
  v_currency text;
BEGIN
  IF auth.uid() IS NULL
    OR v_org IS NULL
    OR public.current_access_scope() IS NULL
    OR public.current_access_scope() = 'technical'
    OR NOT coalesce(public.has_permission('events','billing','create'),false)
  THEN
    RAISE EXCEPTION 'Events payment permission required'
      USING ERRCODE = '42501';
  END IF;

  IF _booking IS NULL
    OR _amount IS NULL
    OR _amount::text IN ('NaN','Infinity','-Infinity')
    OR _amount <= 0
    OR _amount > 9007199254740991
    OR _amount <> trunc(_amount)
  THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'invalid_amount'
    );
  END IF;

  SELECT * INTO v_event
  FROM public.event_bookings
  WHERE id = _booking
    AND organization_id = v_org
  FOR UPDATE;

  IF NOT FOUND
    OR v_event.branch_id IS NULL
    OR NOT coalesce(public.neo_branch_in_scope(v_event.branch_id),false)
  THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'event_not_accessible'
    );
  END IF;

  IF v_event.billing_status = 'not_billed'
    OR v_event.status IN ('cancelled','voided')
  THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'event_not_payable'
    );
  END IF;

  v_currency := public.neo_fact_currency(v_org,v_event.branch_id);

  IF v_currency IS DISTINCT FROM 'KES' THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'kes_only'
    );
  END IF;

  SELECT coalesce(sum(
    CASE WHEN is_complimentary THEN 0 ELSE line_total END
  ),0)
  INTO v_charged
  FROM public.event_billing_items
  WHERE booking_id = _booking
    AND organization_id = v_org;

  IF v_charged::text IN ('NaN','Infinity','-Infinity')
    OR v_charged <= 0
  THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'invalid_or_empty_bill'
    );
  END IF;

  SELECT coalesce(sum(amount),0)
  INTO v_paid
  FROM public.event_payments
  WHERE booking_id = _booking
    AND organization_id = v_org;

  SELECT coalesce(sum(amount),0)
  INTO v_pending
  FROM public.mpesa_transactions
  WHERE organization_id = v_org
    AND branch_id = v_event.branch_id
    AND source_module = 'events'
    AND source_record_id = _booking
    AND status IN ('initiated','pending','unknown')
    AND applied_at IS NULL;

  IF v_paid::text IN ('NaN','Infinity','-Infinity')
    OR v_pending::text IN ('NaN','Infinity','-Infinity')
    OR v_paid < 0
    OR v_pending < 0
  THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'collection_reconciliation_required'
    );
  END IF;

  v_available := greatest(
    v_charged - v_paid - v_pending,0
  );

  IF _amount > v_available THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'amount_exceeds_available',
      'available', v_available,
      'currency', v_currency
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'booking_id', _booking,
    'organization_id', v_org,
    'branch_id', v_event.branch_id,
    'amount', _amount,
    'currency', v_currency,
    'available', v_available
  );
END
$event_quote$;

REVOKE ALL ON FUNCTION
  public.neo_fin_event_mpesa_quote(uuid,numeric)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  public.neo_fin_event_mpesa_quote(uuid,numeric)
TO authenticated;

-- Atomic Events collection reservation.
-- Intentionally not executable by authenticated clients until
-- the verified Events provider settlement routine is installed.
CREATE OR REPLACE FUNCTION public.neo_fin_event_mpesa_start(
  _booking uuid,
  _amount numeric,
  _msisdn text,
  _entry_type text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $event_start$
DECLARE
  v_org uuid := public.current_org_id();
  v_event public.event_bookings;
  v_existing public.mpesa_transactions;
  v_quote jsonb;
  v_environment text;
  v_shortcode text;
  v_transaction uuid;
  v_description text;
BEGIN
  IF auth.uid() IS NULL
    OR v_org IS NULL
    OR public.current_access_scope() IS NULL
    OR public.current_access_scope() = 'technical'
    OR NOT coalesce(public.has_permission('events','billing','create'),false)
  THEN
    RAISE EXCEPTION 'Events billing access required'
      USING ERRCODE = '42501';
  END IF;

  IF _entry_type IS NULL
    OR _entry_type NOT IN ('deposit','payment')
  THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','invalid_entry_type'
    );
  END IF;

  _msisdn := regexp_replace(
    coalesce(_msisdn,''),'[^0-9]','','g'
  );

  IF _msisdn !~ '^254[17][0-9]{8}$' THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','invalid_mobile_number'
    );
  END IF;

  -- All collection attempts for this event serialize on this row.
  SELECT * INTO v_event
  FROM public.event_bookings
  WHERE id = _booking AND organization_id = v_org
  FOR UPDATE;

  IF NOT FOUND
    OR NOT coalesce(
      public.neo_branch_in_scope(v_event.branch_id),false
    )
  THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','event_not_accessible'
    );
  END IF;

  v_description := 'Event ' || _entry_type;

  -- An earlier unresolved attempt is authoritative.
  -- Never send a second prompt solely because the caller retries.
  SELECT * INTO v_existing
  FROM public.mpesa_transactions
  WHERE organization_id = v_org
    AND branch_id = v_event.branch_id
    AND source_module = 'events'
    AND source_record_id = _booking
    AND status IN ('initiated','pending','unknown')
    AND applied_at IS NULL
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.amount IS DISTINCT FROM _amount
      OR v_existing.msisdn IS DISTINCT FROM _msisdn
      OR v_existing.description IS DISTINCT FROM v_description
    THEN
      RETURN jsonb_build_object(
        'ok',false,
        'reason','existing_collection_conflict',
        'transaction_id',v_existing.id
      );
    END IF;

    RETURN jsonb_build_object(
      'ok',true,'reused',true,
      'transaction_id',v_existing.id,
      'organization_id',v_org,
      'amount',v_existing.amount,
      'status',v_existing.status,
      'account_reference',v_existing.account_reference
    );
  END IF;

  -- Recalculate availability while holding the booking lock.
  -- The quote includes already-recorded and active pending amounts.
  v_quote := public.neo_fin_event_mpesa_quote(
    _booking,_amount
  );

  IF coalesce(v_quote->>'ok','false') <> 'true' THEN
    RETURN v_quote;
  END IF;

  SELECT environment,short_code
  INTO v_environment,v_shortcode
  FROM public.mpesa_settings
  WHERE organization_id = v_org
    AND coalesce(enabled,false)
  LIMIT 1;

  IF v_shortcode IS NULL THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','mpesa_not_configured'
    );
  END IF;

  INSERT INTO public.mpesa_transactions(
    organization_id,branch_id,source_module,source_record_id,
    payment_table,payment_id,msisdn,amount,
    account_reference,description,environment,
    short_code,status,created_by
  )
  VALUES(
    v_org,v_event.branch_id,'events',_booking,
    NULL,NULL,_msisdn,_amount,
    v_event.event_reference,v_description,
    coalesce(v_environment,'sandbox'),
    v_shortcode,'initiated',auth.uid()
  )
  RETURNING id INTO v_transaction;

  RETURN jsonb_build_object(
    'ok',true,'reused',false,
    'transaction_id',v_transaction,
    'organization_id',v_org,
    'branch_id',v_event.branch_id,
    'amount',_amount,
    'account_reference',v_event.event_reference,
    'status','initiated'
  );
END
$event_start$;

-- Keep this routine disabled until callback settlement is complete.
REVOKE ALL ON FUNCTION
  public.neo_fin_event_mpesa_start(uuid,numeric,text,text)
FROM PUBLIC,anon,authenticated;

DO $postcheck$
DECLARE
  ev_oid oid;
  definition text;
BEGIN
  ev_oid := to_regprocedure(
    'public.neo_event_billing_record_payment(uuid,numeric,text,text,text,text,uuid,text)'
  );

  definition := pg_get_functiondef(ev_oid);

  IF position('''partially-paid'' END,' IN definition) = 0
    OR position('''partial'' END,' IN definition) > 0
    OR position(
      'An Events M-Pesa payment requires a verified provider collection'
      IN definition
    ) = 0 THEN
    RAISE EXCEPTION 'Events payment function postcheck failed';
  END IF;

  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = ev_oid) THEN
    RAISE EXCEPTION 'Security-definer property was lost';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'public.event_payments'::regclass
      AND tgname = 'neo_fin_event_payment_owner_check'
      AND NOT tgisinternal
      AND tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'Event ownership trigger missing or disabled';
  END IF;
  IF to_regclass('public.neo_fin_event_receipt_single_owner_uq') IS NULL
     OR to_regclass('public.neo_fin_mpesa_checkout_org_uq') IS NULL
     OR to_regclass('public.neo_fin_mpesa_receipt_org_ci_uq') IS NULL THEN
    RAISE EXCEPTION 'Required unique indexes missing';
  END IF;
END
$postcheck$;

COMMIT;