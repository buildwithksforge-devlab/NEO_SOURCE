-- PAYMENT_SETTLEMENT_EVIDENCE_V1
--
-- Evidence authority only.
-- Does not independently post money or alter existing balances.

CREATE TABLE public.neo_payment_settlement_evidence (

    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    organization_id uuid NOT NULL,

    branch_id uuid NOT NULL,

    provider text NOT NULL,

    provider_receipt text NOT NULL,

    transaction_id uuid NOT NULL,

    amount numeric(18,2) NOT NULL,

    currency text NOT NULL,

    evidence jsonb NOT NULL,

    received_at timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT neo_payment_evidence_provider_check

        CHECK (provider IN ('mpesa')),

    CONSTRAINT neo_payment_evidence_receipt_check

        CHECK (
            provider_receipt ~ '^[A-Z0-9]{6,64}$'
        ),

    CONSTRAINT neo_payment_evidence_amount_check

        CHECK (
            amount > 0
            AND amount <= 100000000
        ),

    CONSTRAINT neo_payment_evidence_currency_check

        CHECK (currency = 'KES'),

    CONSTRAINT neo_payment_evidence_payload_check

        CHECK (
            jsonb_typeof(evidence) = 'object'
            AND octet_length(evidence::text) <= 65536
        ),

    CONSTRAINT neo_payment_evidence_receipt_unique

        UNIQUE (
            organization_id,
            provider,
            provider_receipt
        ),

    CONSTRAINT neo_payment_evidence_transaction_unique

        UNIQUE (
            organization_id,
            provider,
            transaction_id
        )

);

ALTER TABLE public.neo_payment_settlement_evidence

    ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.neo_payment_settlement_evidence

    FROM PUBLIC, anon, authenticated, service_role;


CREATE OR REPLACE FUNCTION public.neo_payment_evidence_immutable()

RETURNS trigger

LANGUAGE plpgsql

SET search_path = public, pg_temp

AS $function$

BEGIN

    RAISE EXCEPTION

        'Payment settlement evidence is immutable';

END;

$function$;


CREATE TRIGGER neo_payment_settlement_evidence_immutable

BEFORE UPDATE OR DELETE

ON public.neo_payment_settlement_evidence

FOR EACH ROW

EXECUTE FUNCTION public.neo_payment_evidence_immutable();


REVOKE ALL ON FUNCTION public.neo_payment_evidence_immutable()

    FROM PUBLIC, anon, authenticated, service_role;


CREATE OR REPLACE FUNCTION public.neo_payment_register_verified_evidence(

    _organization uuid,

    _branch uuid,

    _provider text,

    _receipt text,

    _transaction uuid,

    _amount numeric,

    _currency text,

    _evidence jsonb

)

RETURNS jsonb

LANGUAGE plpgsql

SECURITY DEFINER

SET search_path = public, pg_temp

AS $function$

DECLARE

    v_receipt text;

    v_existing public.neo_payment_settlement_evidence%ROWTYPE;

    v_id uuid;

BEGIN

    IF _organization IS NULL
        OR _branch IS NULL
        OR _transaction IS NULL

    THEN

        RAISE EXCEPTION 'Payment scope is required';

    END IF;


    IF _provider IS DISTINCT FROM 'mpesa'

        OR _currency IS DISTINCT FROM 'KES'

    THEN

        RAISE EXCEPTION 'Unsupported payment provider or currency';

    END IF;


    v_receipt := upper(btrim(_receipt));


    IF v_receipt IS NULL

        OR v_receipt !~ '^[A-Z0-9]{6,64}$'

    THEN

        RAISE EXCEPTION 'Invalid provider receipt';

    END IF;


    IF _amount IS NULL

        OR _amount::text IN (
            'NaN',
            'Infinity',
            '-Infinity'
        )

        OR _amount <= 0

        OR _amount > 100000000

        OR round(_amount,2) <> _amount

    THEN

        RAISE EXCEPTION 'Invalid verified payment amount';

    END IF;


    IF _evidence IS NULL

        OR jsonb_typeof(_evidence) <> 'object'

        OR octet_length(_evidence::text) > 65536

    THEN

        RAISE EXCEPTION 'Invalid payment evidence';

    END IF;


    -- Serialize receipt claims within each organization.

    PERFORM pg_advisory_xact_lock(

        hashtextextended(

            _organization::text

            || ':mpesa:receipt:'

            || v_receipt,

            0

        )

    );


    -- Serialize competing receipts for the same transaction.

    PERFORM pg_advisory_xact_lock(

        hashtextextended(

            _organization::text

            || ':mpesa:transaction:'

            || _transaction::text,

            1

        )

    );


    SELECT *

    INTO v_existing

    FROM public.neo_payment_settlement_evidence

    WHERE organization_id = _organization

        AND provider = _provider

        AND provider_receipt = v_receipt;


    IF FOUND THEN

        IF v_existing.transaction_id <> _transaction

            OR v_existing.branch_id <> _branch

            OR v_existing.amount <> _amount

            OR v_existing.currency <> _currency

        THEN

            RAISE EXCEPTION

                'Provider receipt conflicts with existing payment evidence';

        END IF;


        RETURN jsonb_build_object(

            'ok', true,

            'replayed', true,

            'evidence_id', v_existing.id,

            'financially_posted', false

        );

    END IF;


    IF EXISTS (

        SELECT 1

        FROM public.neo_payment_settlement_evidence

        WHERE organization_id = _organization

            AND provider = _provider

            AND transaction_id = _transaction

    ) THEN

        RAISE EXCEPTION

            'Transaction already has different verified receipt evidence';

    END IF;


    INSERT INTO public.neo_payment_settlement_evidence (

        organization_id,

        branch_id,

        provider,

        provider_receipt,

        transaction_id,

        amount,

        currency,

        evidence

    )

    VALUES (

        _organization,

        _branch,

        _provider,

        v_receipt,

        _transaction,

        _amount,

        _currency,

        _evidence

    )

    RETURNING id INTO v_id;


    RETURN jsonb_build_object(

        'ok', true,

        'replayed', false,

        'evidence_id', v_id,

        'financially_posted', false

    );

END;

$function$;


REVOKE ALL ON FUNCTION public.neo_payment_register_verified_evidence(

    uuid, uuid, text, text, uuid, numeric, text, jsonb

) FROM PUBLIC, anon, authenticated, service_role;


-- Remain revoked until the canonical financial settlement
-- function is connected and independently verified.



-- PAYMENT_CANONICAL_EVIDENCE_V1
--
-- Install against the final existing canonical function.
-- Preserve previously installed financial behaviour.
-- Execute only through the existing trusted settlement RPC.

DO $install$
DECLARE
    v_signature regprocedure :=
        to_regprocedure(
            'public.neo_mpesa_apply_result(uuid,integer,text,text,text,jsonb,text)'
        );

    v_definition text;
    v_anchor text;
    v_replacement text;

BEGIN

    IF v_signature IS NULL THEN
        RAISE EXCEPTION
            'Canonical M-Pesa settlement function unavailable';
    END IF;

    v_definition := pg_get_functiondef(v_signature);

    v_anchor :=
        '  -- A late verified successful callback may supersede an earlier non-success.';

    IF (
        length(v_definition)
        - length(replace(v_definition,v_anchor,''))
    ) / length(v_anchor) <> 1 THEN

        RAISE EXCEPTION
            'Canonical payment replay boundary differs; installation stopped';

    END IF;

    v_replacement := $guard$

  -- PAYMENT_CANONICAL_EVIDENCE_GUARD_V1
  --
  -- Register evidence within the same database
  -- transaction as canonical financial application.

  IF _result_code = 0
     AND nullif(btrim(_receipt),'') IS NOT NULL
  THEN

    IF _source IS NULL
       OR _source NOT IN ('callback','status-query')
    THEN
      RAISE EXCEPTION
        'Verified payment result source required';
    END IF;

    IF _t.organization_id IS NULL
       OR _t.branch_id IS NULL
    THEN
      RAISE EXCEPTION
        'Verified payment property scope required';
    END IF;

    IF _t.status = 'success'
       AND _t.applied_at IS NOT NULL
       AND upper(btrim(_t.mpesa_receipt_number))
           IS DISTINCT FROM upper(btrim(_receipt))
    THEN
      RAISE EXCEPTION
        'Verified receipt conflicts with applied transaction';
    END IF;

    PERFORM public.neo_payment_register_verified_evidence(
      _t.organization_id,
      _t.branch_id,
      'mpesa',
      _receipt,
      _t.id,
      _t.amount,
      'KES',
      jsonb_build_object(
        'source', _source,
        'checkout_request_id', _t.checkout_request_id,
        'merchant_request_id', _t.merchant_request_id,
        'transaction_date', _transaction_date,
        'provider_evidence', COALESCE(_payload,'{}'::jsonb)
      )
    );

  END IF;

$guard$ || v_anchor;

    v_definition := replace(
        v_definition,
        v_anchor,
        v_replacement
    );

    EXECUTE v_definition;

END;
$install$;


-- The evidence helper remains inaccessible directly.

REVOKE ALL ON FUNCTION
public.neo_payment_register_verified_evidence(
    uuid,uuid,text,text,uuid,numeric,text,jsonb
)
FROM PUBLIC,anon,authenticated,service_role;


-- Do not grant new canonical execution privileges.
-- Existing trusted financial authority is preserved.


-- PAYMENT_RECEIPT_RECOVERY_V1
--
-- Read-only receipt matching.
-- Never treat cashier-entered text as proof of payment.

CREATE OR REPLACE FUNCTION public.neo_mpesa_match_receipt_evidence(

    _organization uuid,

    _branch uuid,

    _transaction uuid,

    _receipt text

)

RETURNS jsonb

LANGUAGE plpgsql

SECURITY DEFINER

SET search_path = public,pg_temp

AS $function$

DECLARE

    v_receipt text;

    v_transaction public.mpesa_transactions%ROWTYPE;

    v_evidence public.neo_payment_settlement_evidence%ROWTYPE;

    v_conflicts integer;

BEGIN

    IF _organization IS NULL
       OR _branch IS NULL
       OR _transaction IS NULL
    THEN

        RAISE EXCEPTION 'Payment recovery scope is required';

    END IF;

    v_receipt := upper(btrim(_receipt));

    IF v_receipt IS NULL
       OR v_receipt !~ '^[A-Z0-9]{6,64}$'
    THEN

        RAISE EXCEPTION 'Invalid provider receipt';

    END IF;

    SELECT *

    INTO v_transaction

    FROM public.mpesa_transactions

    WHERE id = _transaction

      AND organization_id = _organization

      AND branch_id = _branch

    FOR UPDATE;

    IF NOT FOUND THEN

        RAISE EXCEPTION 'Payment attempt unavailable in property scope'
            USING ERRCODE = '42501';

    END IF;

    IF v_transaction.amount IS NULL

       OR v_transaction.amount::text IN (
          'NaN','Infinity','-Infinity'
       )

       OR v_transaction.amount <= 0

       OR v_transaction.amount > 100000000

       OR round(v_transaction.amount,2) <> v_transaction.amount

    THEN

        RAISE EXCEPTION 'Invalid saved payment amount';

    END IF;

    -- Use the same receipt lock as the existing
    -- canonical M-Pesa application function.

    PERFORM pg_advisory_xact_lock(

        hashtextextended(

            'mpesa-receipt:'
            || _organization::text
            || ':'
            || v_receipt,

            0

        )

    );

    SELECT count(*)

    INTO v_conflicts

    FROM public.mpesa_transactions other

    WHERE other.organization_id = _organization

      AND other.id <> _transaction

      AND upper(btrim(other.mpesa_receipt_number)) = v_receipt

      AND other.status = 'success'

      AND other.applied_at IS NOT NULL;

    IF v_conflicts > 0 THEN

        RETURN jsonb_build_object(

            'ok', false,

            'state', 'receipt-already-assigned',

            'can_auto_apply', false

        );

    END IF;

    SELECT *

    INTO v_evidence

    FROM public.neo_payment_settlement_evidence

    WHERE organization_id = _organization

      AND provider = 'mpesa'

      AND provider_receipt = v_receipt;

    IF FOUND THEN

        IF v_evidence.transaction_id <> _transaction

           OR v_evidence.branch_id <> _branch

           OR v_evidence.amount <> v_transaction.amount

           OR v_evidence.currency <> 'KES'

        THEN

            RETURN jsonb_build_object(

                'ok', false,

                'state', 'receipt-evidence-conflict',

                'can_auto_apply', false

            );

        END IF;

    END IF;

    IF v_transaction.status = 'success'

       AND v_transaction.applied_at IS NOT NULL

    THEN

        IF upper(btrim(v_transaction.mpesa_receipt_number))

           IS DISTINCT FROM v_receipt

        THEN

            RETURN jsonb_build_object(

                'ok', false,

                'state', 'applied-receipt-conflict',

                'can_auto_apply', false

            );

        END IF;

        RETURN jsonb_build_object(

            'ok', true,

            'state', 'already-applied',

            'transaction_id', v_transaction.id,

            'amount', v_transaction.amount,

            'currency', 'KES',

            'can_auto_apply', false,

            'financial_reconciliation_required', true

        );

    END IF;

    IF EXISTS (

        SELECT 1

        FROM public.neo_payment_settlement_evidence

        WHERE organization_id = _organization

          AND provider = 'mpesa'

          AND transaction_id = _transaction

          AND provider_receipt <> v_receipt

    ) THEN

        RETURN jsonb_build_object(

            'ok', false,

            'state', 'different-receipt-registered',

            'can_auto_apply', false

        );

    END IF;

    IF v_evidence.id IS NOT NULL THEN

        RETURN jsonb_build_object(

            'ok', true,

            'state', 'verified-evidence-review-required',

            'transaction_id', v_transaction.id,

            'evidence_id', v_evidence.id,

            'amount', v_transaction.amount,

            'currency', 'KES',

            'can_auto_apply', false

        );

    END IF;

    -- A receipt entered by a cashier is a claim,
    -- not independent provider confirmation.

    RETURN jsonb_build_object(

        'ok', false,

        'state', 'provider-verification-required',

        'transaction_id', v_transaction.id,

        'can_auto_apply', false

    );

END;

$function$;


REVOKE ALL ON FUNCTION

public.neo_mpesa_match_receipt_evidence(

    uuid,uuid,uuid,text

)

FROM PUBLIC,anon,authenticated,service_role;


-- Restricted internal helper.
-- No direct cashier execution or payment mutation.


-- PAYMENT_TARGET_INTEGRITY_V1
--
-- One underlying payment record must not be
-- independently settled by multiple provider attempts.
--
-- Additional money received requires a separate
-- controlled financial allocation workflow.

CREATE OR REPLACE FUNCTION public.neo_mpesa_payment_target_guard(

    _transaction uuid

)

RETURNS void

LANGUAGE plpgsql

SECURITY DEFINER

SET search_path = public,pg_temp

AS $function$

DECLARE

    v_attempt public.mpesa_transactions%ROWTYPE;

    v_payment_table text;

    v_payment_id uuid;

BEGIN

    SELECT *

    INTO v_attempt

    FROM public.mpesa_transactions

    WHERE id = _transaction

    FOR UPDATE;

    IF NOT FOUND THEN

        RAISE EXCEPTION 'Saved payment attempt unavailable';

    END IF;

    v_payment_table := v_attempt.payment_table;

    v_payment_id := v_attempt.payment_id;

    IF v_payment_table IS NULL
       AND v_payment_id IS NULL
    THEN

        -- Reservation deposits have their own
        -- financial identity and must not be
        -- treated as ordinary payment records.

        IF v_attempt.source_module = 'reservation_deposit'

           AND v_attempt.source_record_id IS NOT NULL

        THEN

            RETURN;

        END IF;

        RAISE EXCEPTION 'Payment settlement target missing';

    END IF;


    IF v_payment_table IS NULL

       OR v_payment_table NOT IN (
          'pos_payments',
          'payments'
       )

       OR v_payment_id IS NULL

    THEN

        RAISE EXCEPTION 'Unsupported payment settlement target';

    END IF;


    IF v_attempt.organization_id IS NULL

       OR v_attempt.branch_id IS NULL

    THEN

        RAISE EXCEPTION 'Payment settlement property scope missing';

    END IF;


    -- Serialize all successful provider attempts
    -- competing for the same payment record.

    PERFORM pg_advisory_xact_lock(

        hashtextextended(

            'neo-payment-target:'

            || v_payment_table

            || ':'

            || v_payment_id::text,

            0

        )

    );


    IF EXISTS (

        SELECT 1

        FROM public.mpesa_transactions other

        WHERE other.id <> _transaction

          AND other.payment_table = v_payment_table

          AND other.payment_id = v_payment_id

          AND other.status = 'success'

          AND other.applied_at IS NOT NULL

    ) THEN

        RAISE EXCEPTION

            'Payment target already settled by another provider attempt';

    END IF;

END;

$function$;


REVOKE ALL ON FUNCTION

public.neo_mpesa_payment_target_guard(uuid)

FROM PUBLIC,anon,authenticated,service_role;


-- Controlled receipt review entry point.
--
-- Uses existing finance receipt approval permissions.
-- The caller cannot provide an arbitrary organization
-- or property scope.

CREATE OR REPLACE FUNCTION public.neo_mpesa_review_receipt_match(

    _transaction uuid,

    _receipt text

)

RETURNS jsonb

LANGUAGE plpgsql

SECURITY DEFINER

SET search_path = public,pg_temp

AS $function$

DECLARE

    v_attempt public.mpesa_transactions%ROWTYPE;

BEGIN

    IF auth.uid() IS NULL THEN

        RAISE EXCEPTION 'Authentication required'

            USING ERRCODE = '42501';

    END IF;


    IF public.current_access_scope()::text

       IS NOT DISTINCT FROM 'technical'

    THEN

        RAISE EXCEPTION

            'Technical access cannot verify financial receipts'

            USING ERRCODE = '42501';

    END IF;


    SELECT *

    INTO v_attempt

    FROM public.mpesa_transactions

    WHERE id = _transaction

      AND organization_id = public.current_org_id();


    IF NOT FOUND

       OR v_attempt.branch_id IS NULL

    THEN

        RAISE EXCEPTION

            'Payment unavailable in authorized property scope'

            USING ERRCODE = '42501';

    END IF;


    IF public.current_access_scope() IS NULL

       OR public.neo_mpesa_receipt_can_approve(

           v_attempt.organization_id,

           v_attempt.branch_id

       ) IS DISTINCT FROM true

    THEN

        RAISE EXCEPTION 'Receipt verification permission required'

            USING ERRCODE = '42501';

    END IF;


    RETURN public.neo_mpesa_match_receipt_evidence(

        v_attempt.organization_id,

        v_attempt.branch_id,

        v_attempt.id,

        _receipt

    );

END;

$function$;


REVOKE ALL ON FUNCTION

public.neo_mpesa_review_receipt_match(uuid,text)

FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION

public.neo_mpesa_review_receipt_match(uuid,text)

TO authenticated;


-- Connect target protection to the existing canonical
-- provider settlement function, before its first
-- financial mutation.

DO $install$

DECLARE

    v_signature regprocedure :=

        to_regprocedure(

            'public.neo_mpesa_apply_result(uuid,integer,text,text,text,jsonb,text)'

        );

    v_definition text;

    v_anchor text :=

        '  -- PAYMENT_CANONICAL_EVIDENCE_GUARD_V1';

BEGIN

    IF v_signature IS NULL THEN

        RAISE EXCEPTION 'Canonical settlement function missing';

    END IF;


    v_definition := pg_get_functiondef(v_signature);


    IF (

        length(v_definition)

        - length(replace(v_definition,v_anchor,''))

    ) / length(v_anchor) <> 1

    THEN

        RAISE EXCEPTION

            'Canonical evidence boundary not uniquely identified';

    END IF;


    v_definition := replace(

        v_definition,

        v_anchor,

        $guard$

  -- PAYMENT_TARGET_INTEGRITY_GUARD_V1

  IF _result_code = 0

     AND nullif(btrim(_receipt),'') IS NOT NULL

  THEN

    PERFORM public.neo_mpesa_payment_target_guard(_t.id);

  END IF;

$guard$ || v_anchor

    );


    EXECUTE v_definition;

END;

$install$;


-- PAYMENT_LATE_RECEIPT_EXCEPTION_V1
--
-- Preserve independently received funds that
-- cannot safely be allocated to their original
-- payment target.
--
-- This register is not a general ledger posting.

CREATE TABLE public.neo_payment_late_receipt_exceptions (

    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    organization_id uuid NOT NULL,

    branch_id uuid NOT NULL,

    transaction_id uuid NOT NULL,

    evidence_id uuid NOT NULL
        REFERENCES public.neo_payment_settlement_evidence(id),

    payment_table text NOT NULL,

    payment_id uuid NOT NULL,

    amount numeric(18,2) NOT NULL,

    currency text NOT NULL DEFAULT 'KES',

    reason text NOT NULL,

    status text NOT NULL DEFAULT 'awaiting-accounting',

    created_at timestamptz NOT NULL
        DEFAULT clock_timestamp(),

    CONSTRAINT neo_late_receipt_transaction_unique

        UNIQUE (organization_id,transaction_id),

    CONSTRAINT neo_late_receipt_evidence_unique

        UNIQUE (evidence_id),

    CONSTRAINT neo_late_receipt_amount_valid

        CHECK (

            amount > 0

            AND amount <= 100000000

        ),

    CONSTRAINT neo_late_receipt_currency_valid

        CHECK (currency='KES'),

    CONSTRAINT neo_late_receipt_target_valid

        CHECK (

            payment_table IN (
                'pos_payments',
                'payments'
            )

        ),

    CONSTRAINT neo_late_receipt_reason_valid

        CHECK (

            reason IN (

                'duplicate-payment-target',

                'bill-already-settled',

                'payment-already-confirmed',

                'payment-target-unavailable',

                'allocation-exceeds-balance'

            )

        ),

    CONSTRAINT neo_late_receipt_initial_status

        CHECK (status='awaiting-accounting')

);


ALTER TABLE public.neo_payment_late_receipt_exceptions

    ENABLE ROW LEVEL SECURITY;


REVOKE ALL ON public.neo_payment_late_receipt_exceptions

FROM PUBLIC,anon,authenticated,service_role;


CREATE INDEX neo_late_receipt_scope_idx

ON public.neo_payment_late_receipt_exceptions (

    organization_id,

    branch_id,

    status,

    created_at

);


CREATE TRIGGER neo_late_receipt_evidence_immutable

BEFORE UPDATE OR DELETE

ON public.neo_payment_late_receipt_exceptions

FOR EACH ROW

EXECUTE FUNCTION public.neo_payment_evidence_immutable();


-- Record verified additional money without posting it
-- against the original sales transaction.

CREATE OR REPLACE FUNCTION public.neo_mpesa_preserve_late_receipt(

    _transaction uuid,

    _evidence uuid,

    _reason text

)

RETURNS jsonb

LANGUAGE plpgsql

SECURITY DEFINER

SET search_path = public,pg_temp

AS $function$

DECLARE

    v_attempt public.mpesa_transactions%ROWTYPE;

    v_evidence public.neo_payment_settlement_evidence%ROWTYPE;

    v_exception public.neo_payment_late_receipt_exceptions%ROWTYPE;

    v_id uuid;

BEGIN

    IF _reason IS NULL

       OR _reason NOT IN (

           'duplicate-payment-target',

           'bill-already-settled',

           'payment-already-confirmed',

           'payment-target-unavailable',

           'allocation-exceeds-balance'

       )

    THEN

        RAISE EXCEPTION 'Invalid late-payment exception reason';

    END IF;


    SELECT *

    INTO v_attempt

    FROM public.mpesa_transactions

    WHERE id=_transaction

    FOR UPDATE;


    IF NOT FOUND

       OR v_attempt.organization_id IS NULL

       OR v_attempt.branch_id IS NULL

    THEN

        RAISE EXCEPTION 'Late-payment attempt scope unavailable';

    END IF;


    IF v_attempt.payment_table IS NULL

       OR v_attempt.payment_table NOT IN (

           'pos_payments',

           'payments'

       )

       OR v_attempt.payment_id IS NULL

    THEN

        RAISE EXCEPTION 'Unsupported late-payment target';

    END IF;


    SELECT *

    INTO v_evidence

    FROM public.neo_payment_settlement_evidence

    WHERE id=_evidence;


    IF NOT FOUND

       OR v_evidence.transaction_id <> v_attempt.id

       OR v_evidence.organization_id

          IS DISTINCT FROM v_attempt.organization_id

       OR v_evidence.branch_id

          IS DISTINCT FROM v_attempt.branch_id

       OR v_evidence.amount

          IS DISTINCT FROM v_attempt.amount

       OR v_evidence.provider <> 'mpesa'

       OR v_evidence.currency <> 'KES'

    THEN

        RAISE EXCEPTION

            'Late-payment evidence does not match saved transaction';

    END IF;


    PERFORM pg_advisory_xact_lock(

        hashtextextended(

            'neo-payment-target:'

            || v_attempt.payment_table

            || ':'

            || v_attempt.payment_id::text,

            0

        )

    );


    SELECT *

    INTO v_exception

    FROM public.neo_payment_late_receipt_exceptions

    WHERE organization_id=v_attempt.organization_id

      AND transaction_id=v_attempt.id;


    IF FOUND THEN

        IF v_exception.evidence_id <> v_evidence.id

           OR v_exception.branch_id <> v_attempt.branch_id

           OR v_exception.amount <> v_attempt.amount

           OR v_exception.payment_table

              IS DISTINCT FROM v_attempt.payment_table

           OR v_exception.payment_id

              IS DISTINCT FROM v_attempt.payment_id

           OR v_exception.reason <> _reason

        THEN

            RAISE EXCEPTION

                'Late-payment replay conflicts with preserved evidence';

        END IF;


        RETURN jsonb_build_object(

            'ok',true,

            'replayed',true,

            'exception_id',v_exception.id,

            'state',v_exception.status,

            'amount',v_exception.amount,

            'currency',v_exception.currency,

            'financially_posted',false

        );

    END IF;


    -- An already applied successful attempt must not
    -- subsequently be reclassified as additional money
    -- without controlled financial reconciliation.

    IF v_attempt.status='success'

       AND v_attempt.applied_at IS NOT NULL

    THEN

        RAISE EXCEPTION

            'Already applied payment requires financial reconciliation';

    END IF;


    INSERT INTO public.neo_payment_late_receipt_exceptions (

        organization_id,

        branch_id,

        transaction_id,

        evidence_id,

        payment_table,

        payment_id,

        amount,

        currency,

        reason

    )

    VALUES (

        v_attempt.organization_id,

        v_attempt.branch_id,

        v_attempt.id,

        v_evidence.id,

        v_attempt.payment_table,

        v_attempt.payment_id,

        v_attempt.amount,

        'KES',

        _reason

    )

    RETURNING id INTO v_id;


    RETURN jsonb_build_object(

        'ok',true,

        'replayed',false,

        'exception_id',v_id,

        'state','awaiting-accounting',

        'amount',v_attempt.amount,

        'currency','KES',

        'financially_posted',false

    );

END;

$function$;


REVOKE ALL ON FUNCTION

public.neo_mpesa_preserve_late_receipt(uuid,uuid,text)

FROM PUBLIC,anon,authenticated,service_role;


-- Deliberately no direct execution grants.
-- Connect through the verified canonical settlement
-- authority only after the accounting path is ready.


-- PAYMENT_OVERPAYMENT_ACCOUNTING_V1
-- PAYMENT_OVERPAYMENT_GL_CONTRACT_V1
--
-- Additional receipts are financial liabilities.
-- Never post them as additional sales revenue.
-- Account mappings require controlled configuration.

CREATE TABLE public.neo_payment_overpayment_accounts (

    organization_id uuid NOT NULL,

    branch_id uuid NOT NULL,

    provider text NOT NULL CHECK (provider='mpesa'),

    settlement_account_id uuid NOT NULL
        REFERENCES public.chart_of_accounts(id),

    liability_account_id uuid NOT NULL
        REFERENCES public.chart_of_accounts(id),

    PRIMARY KEY (
        organization_id,
        branch_id,
        provider
    ),

    CHECK (
        settlement_account_id <> liability_account_id
    )

);

ALTER TABLE public.neo_payment_overpayment_accounts
    ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.neo_payment_overpayment_accounts
    FROM PUBLIC,anon,authenticated,service_role;


CREATE TABLE public.neo_payment_overpayment_postings (

    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    exception_id uuid NOT NULL UNIQUE
        REFERENCES public.neo_payment_late_receipt_exceptions(id),

    organization_id uuid NOT NULL,

    branch_id uuid NOT NULL,

    journal_id uuid NOT NULL UNIQUE
        REFERENCES public.journal_entries(id),

    settlement_account_id uuid NOT NULL
        REFERENCES public.chart_of_accounts(id),

    liability_account_id uuid NOT NULL
        REFERENCES public.chart_of_accounts(id),

    amount numeric(18,2) NOT NULL
        CHECK (amount>0 AND amount<=100000000),

    currency text NOT NULL
        CHECK (currency='KES'),

    posted_at timestamptz NOT NULL
        DEFAULT clock_timestamp(),

    CHECK (
        settlement_account_id <> liability_account_id
    )

);

ALTER TABLE public.neo_payment_overpayment_postings
    ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.neo_payment_overpayment_postings
    FROM PUBLIC,anon,authenticated,service_role;

CREATE TRIGGER neo_overpayment_posting_immutable

BEFORE UPDATE OR DELETE

ON public.neo_payment_overpayment_postings

FOR EACH ROW

EXECUTE FUNCTION public.neo_payment_evidence_immutable();


-- Validate account identity before posting.

CREATE OR REPLACE FUNCTION public.neo_mpesa_overpayment_account_pair(

    _organization uuid,

    _branch uuid

)

RETURNS jsonb

LANGUAGE plpgsql

SECURITY DEFINER

SET search_path = public,pg_temp

AS $function$

DECLARE

    v_mapping public.neo_payment_overpayment_accounts%ROWTYPE;

    v_asset public.chart_of_accounts%ROWTYPE;

    v_liability public.chart_of_accounts%ROWTYPE;

BEGIN

    SELECT *

    INTO v_mapping

    FROM public.neo_payment_overpayment_accounts

    WHERE organization_id=_organization

      AND branch_id=_branch

      AND provider='mpesa'

    FOR SHARE;

    IF NOT FOUND THEN

        RAISE EXCEPTION

            'M-Pesa overpayment account mapping is not configured';

    END IF;


    SELECT *

    INTO v_asset

    FROM public.chart_of_accounts

    WHERE id=v_mapping.settlement_account_id

      AND organization_id=_organization

    FOR SHARE;


    IF NOT FOUND

       OR v_asset.is_header IS DISTINCT FROM false
       OR v_asset.category::text IS DISTINCT FROM 'asset'

       OR v_asset.active IS DISTINCT FROM true

       OR v_asset.postable IS DISTINCT FROM true

    THEN

        RAISE EXCEPTION

            'Invalid M-Pesa overpayment settlement asset account';

    END IF;


    SELECT *

    INTO v_liability

    FROM public.chart_of_accounts

    WHERE id=v_mapping.liability_account_id

      AND organization_id=_organization

    FOR SHARE;


    IF NOT FOUND

       OR v_liability.is_header IS DISTINCT FROM false
       OR v_liability.category::text IS DISTINCT FROM 'liability'

       OR v_liability.active IS DISTINCT FROM true

       OR v_liability.postable IS DISTINCT FROM true

    THEN

        RAISE EXCEPTION

            'Invalid customer overpayment liability account';

    END IF;


    IF v_asset.id=v_liability.id

       OR v_asset.code=v_liability.code

    THEN

        RAISE EXCEPTION

            'Overpayment settlement and liability accounts must differ';

    END IF;


    RETURN jsonb_build_object(

        'asset_id',v_asset.id,

        'asset_code',v_asset.code,

        'liability_id',v_liability.id,

        'liability_code',v_liability.code

    );

END;

$function$;


REVOKE ALL ON FUNCTION

public.neo_mpesa_overpayment_account_pair(uuid,uuid)

FROM PUBLIC,anon,authenticated,service_role;


-- Validate actual posted journal evidence.
-- Checking a journal ID alone is insufficient.

CREATE OR REPLACE FUNCTION public.neo_mpesa_overpayment_journal_valid(

    _exception uuid,

    _journal uuid,

    _asset uuid,

    _liability uuid

)

RETURNS boolean

LANGUAGE plpgsql

SECURITY DEFINER

SET search_path = public,pg_temp

AS $function$

DECLARE

    v_exception public.neo_payment_late_receipt_exceptions%ROWTYPE;

    v_journal public.journal_entries%ROWTYPE;

    v_count integer;

    v_asset_debit numeric;

    v_liability_credit numeric;

    v_invalid integer;

BEGIN

    SELECT *

    INTO v_exception

    FROM public.neo_payment_late_receipt_exceptions

    WHERE id=_exception;

    IF NOT FOUND THEN
        RETURN false;
    END IF;


    SELECT *

    INTO v_journal

    FROM public.journal_entries

    WHERE id=_journal

    FOR SHARE;


    IF NOT FOUND

       OR v_journal.organization_id

          IS DISTINCT FROM v_exception.organization_id

       OR v_journal.branch_id

          IS DISTINCT FROM v_exception.branch_id

       OR v_journal.status::text IS DISTINCT FROM 'posted'

       OR v_journal.currency IS DISTINCT FROM 'KES'

       OR v_journal.source_document_id

          IS DISTINCT FROM v_exception.id

       OR v_journal.source_document_type

          IS DISTINCT FROM 'mpesa_overpayment:liability'

       OR v_journal.total_debit

          IS DISTINCT FROM v_exception.amount

       OR v_journal.total_credit

          IS DISTINCT FROM v_exception.amount

       OR v_journal.reversed_by_journal_id IS NOT NULL

       OR v_journal.reverses_journal_id IS NOT NULL

       OR EXISTS (

           SELECT 1

           FROM public.journal_entries reversal

           WHERE reversal.reverses_journal_id=v_journal.id

             AND reversal.status::text='posted'

       )

    THEN

        RETURN false;

    END IF;


    SELECT

        count(*),

        COALESCE(sum(debit) FILTER (

            WHERE account_id=_asset

        ),0),

        COALESCE(sum(credit) FILTER (

            WHERE account_id=_liability

        ),0),

        count(*) FILTER (

            WHERE organization_id

                  IS DISTINCT FROM v_exception.organization_id

               OR branch_id

                  IS DISTINCT FROM v_exception.branch_id

               OR account_id IS NULL

               OR debit IS NULL

               OR credit IS NULL

               OR debit::text IN (

                   'NaN','Infinity','-Infinity'

               )

               OR credit::text IN (

                   'NaN','Infinity','-Infinity'

               )

               OR NOT (

                   (

                       account_id=_asset

                       AND debit=v_exception.amount

                       AND credit=0

                   )

                   OR

                   (

                       account_id=_liability

                       AND credit=v_exception.amount

                       AND debit=0

                   )

               )

        )

    INTO

        v_count,

        v_asset_debit,

        v_liability_credit,

        v_invalid

    FROM public.journal_entry_lines

    WHERE journal_id=_journal;


    RETURN

        v_count=2

        AND v_invalid=0

        AND v_asset_debit=v_exception.amount

        AND v_liability_credit=v_exception.amount;

END;

$function$;


REVOKE ALL ON FUNCTION

public.neo_mpesa_overpayment_journal_valid(uuid,uuid,uuid,uuid)

FROM PUBLIC,anon,authenticated,service_role;


-- Post additional received money exactly once.

CREATE OR REPLACE FUNCTION public.neo_mpesa_post_overpayment_liability(

    _exception uuid

)

RETURNS jsonb

LANGUAGE plpgsql

SECURITY DEFINER

SET search_path = public,pg_temp

AS $function$

DECLARE

    v_exception public.neo_payment_late_receipt_exceptions%ROWTYPE;

    v_existing public.neo_payment_overpayment_postings%ROWTYPE;

    v_mapping jsonb;

    v_posting jsonb;

    v_journal uuid;

    v_asset uuid;

    v_liability uuid;

BEGIN

    SELECT *

    INTO v_exception

    FROM public.neo_payment_late_receipt_exceptions

    WHERE id=_exception

    FOR UPDATE;


    IF NOT FOUND THEN

        RAISE EXCEPTION

            'Verified additional payment exception unavailable';

    END IF;


    SELECT *

    INTO v_existing

    FROM public.neo_payment_overpayment_postings

    WHERE exception_id=_exception;


    IF FOUND THEN

        IF public.neo_mpesa_overpayment_journal_valid(

            _exception,

            v_existing.journal_id,

            v_existing.settlement_account_id,

            v_existing.liability_account_id

        ) IS DISTINCT FROM true

        THEN

            RAISE EXCEPTION

                'Historical overpayment journal requires reconciliation';

        END IF;


        RETURN jsonb_build_object(

            'ok',true,

            'replayed',true,

            'journal_id',v_existing.journal_id,

            'amount',v_existing.amount,

            'financially_posted',true

        );

    END IF;


    v_mapping:=public.neo_mpesa_overpayment_account_pair(

        v_exception.organization_id,

        v_exception.branch_id

    );


    v_asset:=(v_mapping->>'asset_id')::uuid;

    v_liability:=(v_mapping->>'liability_id')::uuid;


    v_posting:=public.neo_gl_post(

        v_exception.organization_id,

        v_exception.branch_id,

        'finance',

        'mpesa_overpayment',

        v_exception.id,

        'liability',

        public.neo_local_today(v_exception.branch_id),

        'KES',

        'Verified additional M-Pesa receipt held as customer liability',

        jsonb_build_array(

            jsonb_build_object(

                'code',v_mapping->>'asset_code',

                'debit',v_exception.amount,

                'credit',0

            ),

            jsonb_build_object(

                'code',v_mapping->>'liability_code',

                'debit',0,

                'credit',v_exception.amount

            )

        )

    );


    IF v_posting->>'ok' IS DISTINCT FROM 'true' THEN

        RAISE EXCEPTION

            'Overpayment liability journal posting failed';

    END IF;


    v_journal:=NULLIF(

        v_posting->>'journal_id',

        ''

    )::uuid;


    IF v_journal IS NULL

       OR public.neo_mpesa_overpayment_journal_valid(

           _exception,

           v_journal,

           v_asset,

           v_liability

       ) IS DISTINCT FROM true

    THEN

        RAISE EXCEPTION

            'Overpayment liability journal evidence is incomplete';

    END IF;


    INSERT INTO public.neo_payment_overpayment_postings (

        exception_id,

        organization_id,

        branch_id,

        journal_id,

        settlement_account_id,

        liability_account_id,

        amount,

        currency

    )

    VALUES (

        v_exception.id,

        v_exception.organization_id,

        v_exception.branch_id,

        v_journal,

        v_asset,

        v_liability,

        v_exception.amount,

        'KES'

    );


    RETURN jsonb_build_object(

        'ok',true,

        'replayed',false,

        'journal_id',v_journal,

        'amount',v_exception.amount,

        'financially_posted',true

    );

END;

$function$;


REVOKE ALL ON FUNCTION

public.neo_mpesa_post_overpayment_liability(uuid)

FROM PUBLIC,anon,authenticated,service_role;

-- No automatic account creation.
-- No arbitrary account codes.
-- No direct cashier posting.
-- No automatic refund or customer credit allocation.


-- PAYMENT_LATE_ACCOUNTING_ROUTING_V1
--
-- Additional receipts are preserved before accounting.
-- An accounting failure must not destroy receipt evidence.
-- Ordinary payment settlement remains unchanged.

CREATE OR REPLACE FUNCTION public.neo_mpesa_route_late_receipt(

    _transaction uuid,

    _receipt text,

    _payload jsonb,

    _source text

)

RETURNS jsonb

LANGUAGE plpgsql

SECURITY DEFINER

SET search_path = public,pg_temp

AS $function$

DECLARE

    v_attempt public.mpesa_transactions%ROWTYPE;

    v_existing public.neo_payment_late_receipt_exceptions%ROWTYPE;

    v_registered jsonb;

    v_preserved jsonb;

    v_posting jsonb;

    v_evidence uuid;

    v_exception uuid;

    v_reason text;

    v_error text;

BEGIN

    IF _source IS NULL
       OR _source NOT IN ('callback','status-query')
    THEN

        RAISE EXCEPTION 'Verified provider result required';

    END IF;


    SELECT *

    INTO v_attempt

    FROM public.mpesa_transactions

    WHERE id=_transaction

    FOR UPDATE;


    IF NOT FOUND

       OR v_attempt.organization_id IS NULL

       OR v_attempt.branch_id IS NULL

    THEN

        RAISE EXCEPTION 'Late-payment scope unavailable';

    END IF;


    IF v_attempt.payment_table IS NULL

       OR v_attempt.payment_table NOT IN (
           'pos_payments','payments'
       )

       OR v_attempt.payment_id IS NULL

    THEN

        RETURN jsonb_build_object(

            'handled',false

        );

    END IF;


    PERFORM pg_advisory_xact_lock(

        hashtextextended(

            'mpesa-receipt:'

            || v_attempt.organization_id::text

            || ':'

            || upper(btrim(_receipt)),

            0

        )

    );


    PERFORM pg_advisory_xact_lock(

        hashtextextended(

            'neo-payment-target:'

            || v_attempt.payment_table

            || ':'

            || v_attempt.payment_id::text,

            0

        )

    );


    SELECT *

    INTO v_existing

    FROM public.neo_payment_late_receipt_exceptions

    WHERE organization_id=v_attempt.organization_id

      AND transaction_id=v_attempt.id;


    IF FOUND THEN

        v_reason:=v_existing.reason;

    ELSE

        -- A successful original transaction is not
        -- itself an overpayment.

        IF v_attempt.status='success'

           AND v_attempt.applied_at IS NOT NULL

        THEN

            RETURN jsonb_build_object(

                'handled',false

            );

        END IF;


        IF EXISTS (

            SELECT 1

            FROM public.mpesa_transactions other

            WHERE other.id<>v_attempt.id

              AND other.organization_id=v_attempt.organization_id

              AND other.branch_id=v_attempt.branch_id

              AND other.payment_table=v_attempt.payment_table

              AND other.payment_id=v_attempt.payment_id

              AND other.status='success'

              AND other.applied_at IS NOT NULL

        ) THEN

            v_reason:='duplicate-payment-target';

        ELSE

            RETURN jsonb_build_object(

                'handled',false

            );

        END IF;

    END IF;


    v_registered:=public.neo_payment_register_verified_evidence(

        v_attempt.organization_id,

        v_attempt.branch_id,

        'mpesa',

        _receipt,

        v_attempt.id,

        v_attempt.amount,

        'KES',

        jsonb_build_object(

            'source',_source,

            'provider_evidence',

            coalesce(_payload,'{}'::jsonb)

        )

    );


    v_evidence:=(v_registered->>'evidence_id')::uuid;


    v_preserved:=public.neo_mpesa_preserve_late_receipt(

        v_attempt.id,

        v_evidence,

        v_reason

    );


    v_exception:=(v_preserved->>'exception_id')::uuid;


    -- Accounting runs in a nested transaction boundary.
    -- If it fails, its partial changes are rolled back,
    -- but the verified receipt and exception remain.

    BEGIN

        v_posting:=public.neo_mpesa_post_overpayment_liability(

            v_exception

        );

        IF v_posting->>'financially_posted'

           IS DISTINCT FROM 'true'

        THEN

            RAISE EXCEPTION

                'Overpayment accounting confirmation unavailable';

        END IF;

    EXCEPTION WHEN OTHERS THEN

        v_error:=SQLSTATE;

        RETURN jsonb_build_object(

            'handled',true,

            'applied',false,

            'exception_id',v_exception,

            'status','awaiting-accounting',

            'financially_posted',false,

            'retry_required',true,

            'accounting_error_code',v_error

        );

    END;


    RETURN jsonb_build_object(

        'handled',true,

        'applied',false,

        'exception_id',v_exception,

        'status','overpayment-accounted',

        'financially_posted',true,

        'journal_id',v_posting->>'journal_id',

        'retry_required',false

    );

END;

$function$;


REVOKE ALL ON FUNCTION

public.neo_mpesa_route_late_receipt(uuid,text,jsonb,text)

FROM PUBLIC,anon,authenticated,service_role;


-- Connect the new route before the existing
-- duplicate-target rejection boundary.

DO $install$

DECLARE

    v_signature regprocedure:=to_regprocedure(

        'public.neo_mpesa_apply_result(uuid,integer,text,text,text,jsonb,text)'

    );

    v_definition text;

    v_anchor text:=

        '    PERFORM public.neo_mpesa_payment_target_guard(_t.id);';

    v_replacement text;

BEGIN

    IF v_signature IS NULL THEN

        RAISE EXCEPTION 'Canonical payment function unavailable';

    END IF;


    v_definition:=pg_get_functiondef(v_signature);


    IF (

        length(v_definition)

        -length(replace(v_definition,v_anchor,''))

    )/length(v_anchor)<>1

    THEN

        RAISE EXCEPTION

            'Canonical target guard boundary differs';

    END IF;


    v_replacement:=$route$

    DECLARE

        v_late_result jsonb;

    BEGIN

        v_late_result:=public.neo_mpesa_route_late_receipt(

            _t.id,

            _receipt,

            _payload,

            _source

        );

        IF v_late_result->>'handled'='true' THEN

            RETURN v_late_result;

        END IF;

    END;

$route$ || v_anchor;


    EXECUTE replace(

        v_definition,

        v_anchor,

        v_replacement

    );

END;

$install$;


-- PAYMENT_RECEIPT_APPROVAL_AUTHORITY_V1

CREATE OR REPLACE FUNCTION public.neo_mpesa_receipt_decision_guard(
    _request uuid,
    _action text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public,pg_temp
AS $function$

DECLARE

    v_request public.approval_requests%ROWTYPE;

    v_actor uuid:=auth.uid();

    v_action text:=lower(btrim(coalesce(_action,'')));

BEGIN

    IF v_actor IS NULL THEN

        RAISE EXCEPTION 'Authentication required'
            USING ERRCODE='42501';

    END IF;

    IF public.current_access_scope() IS NULL

       OR public.current_access_scope()::text='technical'

    THEN

        RAISE EXCEPTION

            'Operational financial access required'

            USING ERRCODE='42501';

    END IF;

    SELECT *

    INTO v_request

    FROM public.approval_requests

    WHERE id=_request

    FOR UPDATE;

    IF NOT FOUND

       OR v_request.organization_id

          IS DISTINCT FROM public.current_org_id()

       OR v_request.branch_id IS NULL

       OR v_request.approval_type

          IS DISTINCT FROM 'mpesa-receipt-review'

       OR v_request.source_module IS DISTINCT FROM 'pos'

       OR public.neo_mpesa_receipt_can_approve(

           v_request.organization_id,

           v_request.branch_id

       ) IS DISTINCT FROM true

    THEN

        RAISE EXCEPTION

            'Receipt review unavailable in authorized property scope'

            USING ERRCODE='42501';

    END IF;

    IF v_action NOT IN (
        'approved','rejected','returned'
    ) THEN

        RAISE EXCEPTION 'Invalid receipt decision';

    END IF;

    -- Do not retrospectively change completed approvals.
    -- Existing completed records may be inspected through
    -- the existing authorized replay workflow.

    IF v_request.status='completed'

       AND v_request.execution_status='succeeded'

    THEN

        RETURN;

    END IF;

    IF v_action='approved' THEN

        IF v_request.requester_id IS NULL THEN

            RAISE EXCEPTION

                'Receipt submission actor is unavailable';

        END IF;

        IF v_request.requester_id=v_actor THEN

            RAISE EXCEPTION

                'Receipt submission requires independent approval'

                USING ERRCODE='42501';

        END IF;

        IF v_request.amount IS NULL

           OR v_request.amount<=0

           OR v_request.amount>100000000

           OR v_request.amount::text IN (
               'NaN','Infinity','-Infinity'
           )

           OR round(v_request.amount,2)<>v_request.amount

        THEN

            RAISE EXCEPTION

                'Receipt review amount is invalid';

        END IF;

    END IF;

END;

$function$;

REVOKE ALL ON FUNCTION

public.neo_mpesa_receipt_decision_guard(uuid,text)

FROM PUBLIC,anon,authenticated,service_role;


-- Preserve the existing approval decision implementation.
-- Install the independent approval boundary before any
-- approval action or financial mutation.

DO $install$

DECLARE

    v_signature regprocedure:=to_regprocedure(

        'public.neo_mpesa_receipt_review_decide(uuid,text,text)'

    );

    v_definition text;

    v_anchor text:=$anchor$

  IF a.status='completed' AND a.execution_status='succeeded' THEN

$anchor$;

    v_replacement text;

BEGIN

    IF v_signature IS NULL THEN

        RAISE EXCEPTION 'Existing receipt decision function missing';

    END IF;

    v_definition:=pg_get_functiondef(v_signature);

    v_anchor:=btrim(v_anchor,E'\n\r');

    IF (

        length(v_definition)

        -length(replace(v_definition,v_anchor,''))

    )/length(v_anchor)<>1

    THEN

        RAISE EXCEPTION

            'Existing receipt decision boundary differs';

    END IF;

    v_replacement:=$guard$

  -- Independent financial receipt approval authority.

  PERFORM public.neo_mpesa_receipt_decision_guard(a.id,action);

$guard$ || v_anchor;

    EXECUTE replace(

        v_definition,

        v_anchor,

        v_replacement

    );

END;

$install$;


-- PAYMENT_RECEIPT_EXECUTION_AUTHORITY_V1

CREATE OR REPLACE FUNCTION public.neo_mpesa_receipt_execution_guard(
    _request uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public,pg_temp
AS $function$

DECLARE

    v_request public.approval_requests%ROWTYPE;

    v_actor uuid:=auth.uid();

BEGIN

    PERFORM public.neo_mpesa_receipt_decision_guard(
        _request,
        'approved'
    );

    SELECT *

    INTO v_request

    FROM public.approval_requests

    WHERE id=_request

    FOR UPDATE;

    IF NOT FOUND

       OR v_request.status IS NULL

       OR v_request.status NOT IN (

           'approved_pending_execution',

           'executing',

           'execution_failed'

       )

    THEN

        RAISE EXCEPTION

            'Receipt request is not awaiting financial execution';

    END IF;


    IF v_request.approver_id IS NULL

       OR v_request.approver_id IS DISTINCT FROM v_actor

       OR v_request.requester_id IS NULL

       OR v_request.requester_id=v_actor

       OR v_request.self_approved IS TRUE

       OR v_request.emergency_override IS TRUE

    THEN

        RAISE EXCEPTION

            'Independent recorded approval required for receipt execution'

            USING ERRCODE='42501';

    END IF;


    IF length(btrim(coalesce(v_request.notes,'')))<10

       OR length(btrim(coalesce(v_request.notes,'')))>1500

    THEN

        RAISE EXCEPTION

            'A valid written receipt approval decision is required';

    END IF;


    IF NOT EXISTS (

        SELECT 1

        FROM public.approval_steps s

        WHERE s.request_id=v_request.id

          AND s.organization_id=v_request.organization_id

          AND s.status='approved'

          AND s.decided_by=v_actor

    ) THEN

        RAISE EXCEPTION

            'Matching recorded receipt approval step required';

    END IF;


    IF NOT EXISTS (

        SELECT 1

        FROM public.approval_actions a

        WHERE a.request_id=v_request.id

          AND a.organization_id=v_request.organization_id

          AND a.actor_id=v_actor

          AND a.action='approved'

          AND btrim(a.comment)=btrim(v_request.notes)

    ) THEN

        RAISE EXCEPTION

            'Matching receipt approval action evidence required';

    END IF;

END;

$function$;


REVOKE ALL ON FUNCTION

public.neo_mpesa_receipt_execution_guard(uuid)

FROM PUBLIC,anon,authenticated,service_role;


-- Install the guard within the existing payment executor.
-- Generic approval execution must pass the same boundary.

DO $install$

DECLARE

    v_signature regprocedure:=to_regprocedure(

        'public.neo_mpesa_receipt_review_execute(uuid)'

    );

    v_definition text;

    v_anchor text:=

        '-- Match the callback lock order before locking its linked payment.';

BEGIN

    IF v_signature IS NULL THEN

        RAISE EXCEPTION

            'Existing receipt financial executor unavailable';

    END IF;

    v_definition:=pg_get_functiondef(v_signature);

    IF (

        length(v_definition)

        -length(replace(v_definition,v_anchor,''))

    )/length(v_anchor)<>1

    THEN

        RAISE EXCEPTION

            'Existing receipt executor anchor differs';

    END IF;

    EXECUTE replace(

        v_definition,

        v_anchor,

        'PERFORM public.neo_mpesa_receipt_execution_guard(a.id);'

        || E'\n\n  '

        || v_anchor

    );

END;

$install$;


-- NEO_PAYMENT_FINANCIAL_CLOSURE_V1

CREATE OR REPLACE FUNCTION public.neo_mpesa_require_verified_pos_receipt(
    _organization uuid,
    _branch uuid,
    _payment uuid,
    _amount numeric,
    _receipt text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $function$
DECLARE
    v_evidence public.neo_payment_settlement_evidence%ROWTYPE;
    v_transaction public.mpesa_transactions%ROWTYPE;
    v_receipt text:=upper(btrim(coalesce(_receipt,'')));
BEGIN

    IF _organization IS NULL
       OR _branch IS NULL
       OR _payment IS NULL
       OR _amount IS NULL
       OR _amount<=0
       OR _amount>100000000
       OR _amount::text IN ('NaN','Infinity','-Infinity')
       OR round(_amount,2)<>_amount
       OR v_receipt !~ '^[A-Z0-9]{6,64}$'
    THEN
        RAISE EXCEPTION 'Invalid receipt verification identity';
    END IF;

    SELECT *
    INTO v_evidence
    FROM public.neo_payment_settlement_evidence
    WHERE organization_id=_organization
      AND provider='mpesa'
      AND provider_receipt=v_receipt;

    IF NOT FOUND
       OR v_evidence.branch_id IS DISTINCT FROM _branch
       OR v_evidence.amount IS DISTINCT FROM _amount
       OR v_evidence.currency IS DISTINCT FROM 'KES'
    THEN
        RAISE EXCEPTION 'Matching verified provider receipt evidence required';
    END IF;

    SELECT *
    INTO v_transaction
    FROM public.mpesa_transactions
    WHERE id=v_evidence.transaction_id;

    IF NOT FOUND
       OR v_transaction.organization_id IS DISTINCT FROM _organization
       OR v_transaction.branch_id IS DISTINCT FROM _branch
       OR v_transaction.payment_table IS DISTINCT FROM 'pos_payments'
       OR v_transaction.payment_id IS DISTINCT FROM _payment
       OR v_transaction.amount IS DISTINCT FROM _amount
    THEN
        RAISE EXCEPTION 'Verified receipt belongs to a different payment';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.neo_payment_late_receipt_exceptions x
        WHERE x.evidence_id=v_evidence.id
    ) THEN
        RAISE EXCEPTION 'Additional receipt requires financial reconciliation';
    END IF;

    RETURN v_evidence.id;

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_mpesa_require_verified_pos_receipt(uuid,uuid,uuid,numeric,text)
FROM PUBLIC,anon,authenticated,service_role;


-- ==========================================
-- B. DETECT ALTERNATIVE POS COLLECTIONS
-- ==========================================

CREATE OR REPLACE FUNCTION public.neo_mpesa_pos_late_payment_reason(
    _transaction uuid,
    _receipt text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $function$
DECLARE
    t public.mpesa_transactions%ROWTYPE;
    p public.pos_payments%ROWTYPE;
    o public.pos_orders%ROWTYPE;
    v_collected numeric;
BEGIN

    SELECT *
    INTO t
    FROM public.mpesa_transactions
    WHERE id=_transaction
    FOR UPDATE;

    IF NOT FOUND
       OR t.payment_table IS DISTINCT FROM 'pos_payments'
       OR t.payment_id IS NULL
    THEN
        RETURN NULL;
    END IF;

    IF t.status='success'
       AND t.applied_at IS NOT NULL
    THEN
        RETURN NULL;
    END IF;

    SELECT *
    INTO p
    FROM public.pos_payments
    WHERE id=t.payment_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN 'payment-target-unavailable';
    END IF;

    IF p.organization_id IS DISTINCT FROM t.organization_id
       OR p.branch_id IS DISTINCT FROM t.branch_id
       OR p.amount IS DISTINCT FROM t.amount
       OR p.currency IS DISTINCT FROM 'KES'
       OR p.method IS DISTINCT FROM 'mpesa'
    THEN
        RAISE EXCEPTION 'M-Pesa payment target identity mismatch';
    END IF;

    IF p.status='confirmed' THEN

        IF upper(btrim(coalesce(p.external_reference,'')))
           =upper(btrim(coalesce(_receipt,'')))
        THEN
            RETURN NULL;
        END IF;

        RETURN 'payment-already-confirmed';

    END IF;

    IF p.status IS NULL
       OR p.status NOT IN ('pending','initiated','failed')
    THEN
        RETURN 'payment-target-unavailable';
    END IF;

    SELECT *
    INTO o
    FROM public.pos_orders
    WHERE id=p.order_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN 'payment-target-unavailable';
    END IF;

    IF o.organization_id IS DISTINCT FROM p.organization_id
       OR o.branch_id IS DISTINCT FROM p.branch_id
       OR o.currency IS DISTINCT FROM p.currency
    THEN
        RAISE EXCEPTION 'M-Pesa order identity mismatch';
    END IF;

    IF o.grand_total IS NULL
       OR o.grand_total<0
       OR o.grand_total::text IN ('NaN','Infinity','-Infinity')
    THEN
        RAISE EXCEPTION 'Invalid source bill total';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.pos_payments x
        WHERE x.order_id=o.id
          AND x.status='confirmed'
          AND (
              x.organization_id IS DISTINCT FROM p.organization_id
              OR x.branch_id IS DISTINCT FROM p.branch_id
              OR x.currency IS DISTINCT FROM p.currency
              OR x.amount IS NULL
              OR x.amount<=0
              OR x.amount::text IN ('NaN','Infinity','-Infinity')
          )
    ) THEN
        RAISE EXCEPTION 'Invalid historical payment evidence';
    END IF;

    SELECT coalesce(sum(x.amount),0)
    INTO v_collected
    FROM public.pos_payments x
    WHERE x.order_id=o.id
      AND x.organization_id=p.organization_id
      AND x.id<>p.id
      AND x.status='confirmed';

    IF o.status IN ('closed','cancelled','voided','charged-to-room')
       OR v_collected>=o.grand_total
    THEN
        RETURN 'bill-already-settled';
    END IF;

    IF t.amount>round(o.grand_total-v_collected,2) THEN
        RETURN 'allocation-exceeds-balance';
    END IF;

    RETURN NULL;

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_mpesa_pos_late_payment_reason(uuid,text)
FROM PUBLIC,anon,authenticated,service_role;


-- ==========================================
-- C. CONNECT EXISTING FINANCIAL EXECUTOR
-- ==========================================

DO $closure$

DECLARE
    v_definition text;
    v_anchor text;
BEGIN

    v_definition:=pg_get_functiondef(
        'public.neo_mpesa_receipt_review_execute(uuid)'::regprocedure
    );

    v_anchor:='  UPDATE public.pos_payments';

    IF (
        length(v_definition)
        -length(replace(v_definition,v_anchor,''))
    )/length(v_anchor)<>1 THEN
        RAISE EXCEPTION 'Receipt financial mutation boundary differs';
    END IF;

    EXECUTE replace(
        v_definition,
        v_anchor,
        $guard$

  PERFORM public.neo_mpesa_require_verified_pos_receipt(
      p.organization_id,
      p.branch_id,
      p.id,
      p.amount,
      code
  );

$guard$ || v_anchor
    );

END;

$closure$;


-- ==========================================
-- D. CONNECT EXISTING LATE RECEIPT ROUTER
-- ==========================================

DO $closure$

DECLARE
    v_definition text;
    v_anchor text;
BEGIN

    v_definition:=pg_get_functiondef(
        'public.neo_mpesa_route_late_receipt(uuid,text,jsonb,text)'::regprocedure
    );

    v_anchor:='v_reason:=''duplicate-payment-target'';';

    IF (
        length(v_definition)
        -length(replace(v_definition,v_anchor,''))
    )/length(v_anchor)<>1 THEN
        RAISE EXCEPTION 'Existing late receipt routing boundary differs';
    END IF;

    -- Extend the existing reason detection instead of
    -- creating another settlement or accounting path.

    v_definition:=regexp_replace(
        v_definition,
        'v_reason:=''duplicate-payment-target'';[[:space:]]*ELSE[[:space:]]*RETURN jsonb_build_object\([[:space:]]*''handled'',false[[:space:]]*\);[[:space:]]*END IF;',
        $route$
v_reason:='duplicate-payment-target';
        ELSE

            v_reason:=public.neo_mpesa_pos_late_payment_reason(
                v_attempt.id,
                _receipt
            );

            IF v_reason IS NULL THEN
                RETURN jsonb_build_object('handled',false);
            END IF;

        END IF;
$route$
    );

    IF position(
        'neo_mpesa_pos_late_payment_reason'
        IN v_definition
    )=0 THEN
        RAISE EXCEPTION 'Alternative collection routing was not installed';
    END IF;

    EXECUTE v_definition;

END;

$closure$;
