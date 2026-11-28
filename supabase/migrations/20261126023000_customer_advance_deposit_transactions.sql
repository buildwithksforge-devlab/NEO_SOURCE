BEGIN;

-- =============================================
-- CUSTOMER ADVANCE DEPOSIT TRANSACTION AUTHORITY
-- =============================================

CREATE OR REPLACE FUNCTION
public.neo_customer_deposit_assert_authority(
    _branch uuid,
    _customer uuid
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog,public
AS $function$
DECLARE
    org uuid := public.current_org_id();
BEGIN

    IF auth.uid() IS NULL
       OR org IS NULL
       OR _branch IS NULL
       OR _customer IS NULL
       OR public.current_access_scope() IS NULL
       OR public.current_access_scope() = 'technical'
       OR public.neo_branch_in_scope(_branch) IS NOT TRUE
       OR NOT coalesce(
           public.has_permission(
               'finance','ar.allocate_receipt'
           )
           OR public.is_org_admin(),
           false
       )
    THEN
        RAISE EXCEPTION 'Customer financial transaction access denied'
          USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.customers c
        WHERE c.id = _customer
          AND c.organization_id = org
          AND public.neo_record_operationally_enabled(
              to_jsonb(c)
          ) IS TRUE
    ) THEN
        RAISE EXCEPTION 'Customer unavailable';
    END IF;

    RETURN org;

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_customer_deposit_assert_authority(uuid,uuid)
FROM PUBLIC,anon,authenticated;


-- =============================================
-- RECORD CUSTOMER ADVANCE DEPOSIT
-- =============================================

CREATE OR REPLACE FUNCTION
public.neo_customer_advance_deposit_record(
    _branch uuid,
    _customer uuid,
    _amount numeric,
    _currency text,
    _account uuid,
    _intent_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog,public
AS $function$
DECLARE

    org uuid;

    v_deposit uuid := gen_random_uuid();

    v_payment uuid;

    v_journal uuid;
    v_posting jsonb;

    v_shift uuid;

    v_receipt text;

    v_currency text;

    v_account_code text;

    v_key text;

    prior public.neo_customer_advance_deposits%ROWTYPE;

    v_expected_cash_before numeric;

    v_expected_cash_after numeric;

BEGIN

    org := public.neo_customer_deposit_assert_authority(
        _branch,_customer
    );

    v_key := btrim(coalesce(_intent_key,''));

    v_currency := upper(
        btrim(coalesce(_currency,''))
    );

    IF _amount IS NULL
       OR _amount <= 0
       OR _amount::text IN (
           'NaN','Infinity','-Infinity'
       )
       OR _amount <> round(_amount,2)
       OR _amount >= 10000000000000000
       OR v_currency !~ '^[A-Z]{3}$'
       OR _account IS NULL
       OR length(v_key) NOT BETWEEN 1 AND 200
    THEN
        RAISE EXCEPTION 'Invalid advance deposit transaction'
          USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended(
            org::text || ':customer-deposit:' || v_key,
            0
        )
    );

    SELECT *
    INTO prior
    FROM public.neo_customer_advance_deposits d
    WHERE d.organization_id = org
      AND d.intent_key = v_key;

    IF prior.id IS NOT NULL THEN

        IF prior.branch_id IS DISTINCT FROM _branch
           OR prior.customer_id IS DISTINCT FROM _customer
           OR prior.original_amount IS DISTINCT FROM _amount
           OR prior.currency IS DISTINCT FROM v_currency
           OR prior.received_by IS DISTINCT FROM auth.uid()
           OR NOT EXISTS (
               SELECT 1
               FROM public.payments p
               WHERE p.id = prior.payment_id
                 AND p.organization_id = org
                 AND p.destination_account_id = _account
                 AND p.posted_journal_id = prior.journal_id
                 AND p.status = 'confirmed'
           )
        THEN
            RAISE EXCEPTION 'Deposit retry evidence mismatch';
        END IF;

        RETURN jsonb_build_object(
            'ok',true,
            'deposit_id',prior.id,
            'payment_id',prior.payment_id,
            'journal_id',prior.journal_id,
            'duplicate_prevented',true
        );

    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.branches b
        WHERE b.id = _branch
          AND b.organization_id = org
          AND b.active IS TRUE
          AND public.neo_fact_currency(
              org,_branch
          ) = v_currency
    ) THEN
        RAISE EXCEPTION 'Property currency or branch unavailable';
    END IF;

    PERFORM public.neo_assert_financial_account(
        org,_branch,_account
    );

    -- CUSTOMER_DEPOSIT_CASHIER_INTEGRATION_V2

    v_shift := public.pos_resolve_open_shift(
        _branch
    );

    IF v_shift IS NULL THEN
        RAISE EXCEPTION 'An open cashier shift is required';
    END IF;

    PERFORM 1
    FROM public.pos_shifts s
    WHERE s.id = v_shift
      AND s.organization_id = org
      AND s.branch_id = _branch
      AND s.cashier_id = auth.uid()
      AND s.status = 'open'
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
          'The original cashier shift is no longer available';
    END IF;

    v_expected_cash_before :=
        public.cash_shift_expected(v_shift);

    IF v_expected_cash_before IS NULL
       OR v_expected_cash_before::text IN (
           'NaN','Infinity','-Infinity'
       )
    THEN
        RAISE EXCEPTION
          'Original cashier balance cannot be verified';
    END IF;

    SELECT a.code
    INTO v_account_code
    FROM public.bank_accounts b
    JOIN public.chart_of_accounts a
      ON a.id = b.gl_account_id
     AND a.organization_id = b.organization_id
    WHERE b.id = _account
      AND b.organization_id = org
      AND (
          b.branch_id IS NULL
          OR b.branch_id = _branch
      )
      AND b.active IS TRUE
      AND a.active IS TRUE
      AND a.postable IS TRUE
      AND coalesce(a.is_header,false) IS FALSE
      AND a.category = 'asset'
    FOR SHARE OF b,a;

    IF v_account_code IS NULL THEN
        RAISE EXCEPTION
          'Deposit requires an active linked cash ledger account';
    END IF;

    IF v_account_code IS DISTINCT FROM
       public.neo_gl_settlement_code_for(org,'cash')
    THEN
        RAISE EXCEPTION
          'Cash deposits must use the configured cash settlement account';
    END IF;

    PERFORM public.neo_finance_ensure_account(
        org,'2030','Customer Deposits',
        'liability','current_liabilities'
    );

    IF NOT EXISTS (
        SELECT 1
        FROM public.chart_of_accounts a
        WHERE a.organization_id = org
          AND a.code = '2030'
          AND a.category = 'liability'
          AND a.active IS TRUE
          AND a.postable IS TRUE
          AND coalesce(a.is_header,false) IS FALSE
    ) THEN
        RAISE EXCEPTION
          'Customer deposit liability account is unavailable or incorrectly classified';
    END IF;

    IF v_account_code IS NULL
       OR v_account_code = '2030'
    THEN
        RAISE EXCEPTION 'Cash settlement account unavailable';
    END IF;

    v_receipt := public.next_document_number(
        'receipt','REC',_branch
    );

    INSERT INTO public.payments (
        organization_id,
        branch_id,
        customer_id,
        receipt_number,
        amount,
        currency,
        method,
        paid_at,
        status,
        received_by,
        source_module,
        source_record_id,
        idempotency_key,
        shift_id,
        destination_account_id
    )
    VALUES (
        org,
        _branch,
        _customer,
        v_receipt,
        _amount,
        v_currency,
        'cash',
        now(),
        'confirmed',
        auth.uid(),
        'customer_deposit',
        v_deposit,
        'customer-deposit:' || v_key,
        v_shift,
        _account
    )
    RETURNING id INTO v_payment;

    v_expected_cash_after :=
        public.cash_shift_expected(v_shift);

    IF v_expected_cash_after IS DISTINCT FROM
       v_expected_cash_before + _amount
    THEN
        RAISE EXCEPTION
          'Customer deposit must increase cashier cash exactly once';
    END IF;

    v_posting := public.neo_gl_post(
        org,
        _branch,
        'finance',
        'customer_advance_deposit',
        v_deposit,
        'deposit',
        public.neo_local_today(_branch),
        v_currency,
        'Customer advance deposit ' || v_receipt,
        jsonb_build_array(
            jsonb_build_object(
                'code',v_account_code,
                'debit',_amount,
                'credit',0
            ),
            jsonb_build_object(
                'code','2030',
                'debit',0,
                'credit',_amount
            )
        ),
        _customer
    );

    v_journal := nullif(
        v_posting->>'journal_id',''
    )::uuid;

    IF (v_posting->>'ok')::boolean IS NOT TRUE
       OR v_journal IS NULL
    THEN
        RAISE EXCEPTION 'Customer deposit journal was not posted';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.journal_entries j
        WHERE j.id = v_journal
          AND j.organization_id = org
          AND j.branch_id = _branch
          AND j.source_document_id = v_deposit
          AND j.source_document_type =
              'customer_advance_deposit:deposit'
          AND j.currency = v_currency
          AND j.status = 'posted'
          AND j.reversed_by_journal_id IS NULL
          AND j.total_debit = _amount
          AND j.total_credit = _amount
    ) THEN
        RAISE EXCEPTION
          'Customer deposit journal evidence is invalid';
    END IF;

    UPDATE public.payments p
    SET posted_journal_id = v_journal
    WHERE p.id = v_payment
      AND p.organization_id = org
      AND (
          p.posted_journal_id IS NULL
          OR p.posted_journal_id = v_journal
      );

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Conflicting payment accounting evidence';
    END IF;

    INSERT INTO public.neo_customer_advance_deposits (
        id,
        organization_id,
        branch_id,
        customer_id,
        payment_id,
        journal_id,
        currency,
        original_amount,
        received_by,
        intent_key
    )
    VALUES (
        v_deposit,
        org,
        _branch,
        _customer,
        v_payment,
        v_journal,
        v_currency,
        _amount,
        auth.uid(),
        v_key
    );

    IF public.cash_shift_expected(v_shift)
       IS DISTINCT FROM v_expected_cash_before + _amount
    THEN
        RAISE EXCEPTION
          'Final deposit till reconciliation failed';
    END IF;

    RETURN jsonb_build_object(
        'ok',true,
        'deposit_id',v_deposit,
        'payment_id',v_payment,
        'journal_id',v_journal,
        'receipt_number',v_receipt
    );

END;
$function$;


-- =============================================
-- ALLOCATE ADVANCE DEPOSIT AGAINST CUSTOMER DEBT
-- =============================================

CREATE OR REPLACE FUNCTION
public.neo_customer_advance_deposit_allocate(
    _branch uuid,
    _customer uuid,
    _deposit uuid,
    _invoice uuid,
    _amount numeric,
    _intent_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog,public
AS $function$
DECLARE

    org uuid;

    d public.neo_customer_advance_deposits%ROWTYPE;

    inv public.invoices%ROWTYPE;

    prior public.neo_customer_deposit_movements%ROWTYPE;

    v_available numeric;

    v_reserved numeric;

    v_outstanding numeric;

    v_paid numeric;

    v_balance numeric;

    v_journal uuid;
    v_posting jsonb;

    v_movement uuid := gen_random_uuid();

    v_key text;

BEGIN

    org := public.neo_customer_deposit_assert_authority(
        _branch,_customer
    );

    v_key := btrim(coalesce(_intent_key,''));

    IF _amount IS NULL
       OR _amount <= 0
       OR _amount::text IN (
           'NaN','Infinity','-Infinity'
       )
       OR _amount <> round(_amount,2)
       OR length(v_key) NOT BETWEEN 1 AND 200
       OR _deposit IS NULL
       OR _invoice IS NULL
    THEN
        RAISE EXCEPTION 'Invalid deposit allocation';
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended(
            org::text || ':deposit-movement:' || v_key,
            0
        )
    );

    SELECT *
    INTO d
    FROM public.neo_customer_advance_deposits a
    WHERE a.id = _deposit
      AND a.organization_id = org
      AND a.branch_id = _branch
      AND a.customer_id = _customer
    FOR UPDATE;

    IF d.id IS NULL THEN
        RAISE EXCEPTION 'Customer deposit unavailable';
    END IF;

    SELECT *
    INTO prior
    FROM public.neo_customer_deposit_movements m
    WHERE m.organization_id = org
      AND m.intent_key = v_key;

    IF prior.id IS NOT NULL THEN

        IF prior.deposit_id IS DISTINCT FROM _deposit
           OR prior.branch_id IS DISTINCT FROM _branch
           OR prior.source_record_id IS DISTINCT FROM _invoice
           OR prior.movement_type <> 'allocation'
           OR prior.amount IS DISTINCT FROM _amount
           OR prior.performed_by IS DISTINCT FROM auth.uid()
        THEN
            RAISE EXCEPTION 'Allocation retry payload mismatch';
        END IF;

        RETURN jsonb_build_object(
            'ok',true,
            'movement_id',prior.id,
            'journal_id',prior.journal_id,
            'duplicate_prevented',true
        );

    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.payments p
        WHERE p.id = d.payment_id
          AND p.organization_id = org
          AND p.branch_id = _branch
          AND p.customer_id = _customer
          AND p.status = 'confirmed'
          AND p.posted_journal_id = d.journal_id
          AND p.amount = d.original_amount
          AND p.currency = d.currency
    ) THEN
        RAISE EXCEPTION 'Original customer deposit is not financially confirmed';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.journal_entries j
        WHERE j.id = d.journal_id
          AND j.organization_id = org
          AND j.branch_id = _branch
          AND j.currency = d.currency
          AND j.status = 'posted'
          AND j.reversed_by_journal_id IS NULL
          AND j.total_debit = d.original_amount
          AND j.total_credit = d.original_amount
    ) THEN
        RAISE EXCEPTION
          'Original deposit journal requires reconciliation';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.neo_customer_deposit_movements m
        LEFT JOIN public.journal_entries j
          ON j.id = m.journal_id
        WHERE m.deposit_id = d.id
          AND (
              j.id IS NULL
              OR j.organization_id IS DISTINCT FROM org
              OR j.branch_id IS DISTINCT FROM _branch
              OR j.status IS DISTINCT FROM 'posted'
              OR j.reversed_by_journal_id IS NOT NULL
              OR j.currency IS DISTINCT FROM d.currency
              OR j.total_debit IS DISTINCT FROM m.amount
              OR j.total_credit IS DISTINCT FROM m.amount
          )
    ) THEN
        RAISE EXCEPTION
          'Existing deposit movements require reconciliation';
    END IF;

    SELECT d.original_amount - coalesce(sum(m.amount),0)
    INTO v_available
    FROM public.neo_customer_deposit_movements m
    WHERE m.deposit_id = d.id
      AND m.organization_id = org
      AND m.branch_id = _branch;

    SELECT coalesce(sum(r.amount),0)
    INTO v_reserved
    FROM public.neo_customer_deposit_refund_requests r
    WHERE r.deposit_id = d.id
      AND r.organization_id = org
      AND r.branch_id = _branch
      AND r.status IN (
          'pending-approval','approved'
      );

    IF v_available IS NULL
       OR v_reserved IS NULL
       OR v_available::text IN (
           'NaN','Infinity','-Infinity'
       )
       OR v_reserved::text IN (
           'NaN','Infinity','-Infinity'
       )
       OR v_reserved < 0
       OR v_available-v_reserved < _amount
    THEN
        RAISE EXCEPTION
          'Insufficient available customer deposit after refund reservations';
    END IF;

    SELECT *
    INTO inv
    FROM public.invoices i
    WHERE i.id = _invoice
      AND i.organization_id = org
      AND i.branch_id = _branch
      AND i.customer_id = _customer
    FOR UPDATE;

    IF inv.id IS NULL
       OR inv.currency IS DISTINCT FROM d.currency
       OR inv.status NOT IN (
           'issued','partially_paid','overdue'
       )
       OR inv.journal_id IS NULL
    THEN
        RAISE EXCEPTION 'Invoice is unavailable for deposit allocation';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.journal_entries j
        WHERE j.id = inv.journal_id
          AND j.organization_id = org
          AND j.branch_id = _branch
          AND j.currency = d.currency
          AND j.status = 'posted'
          AND j.reversed_by_journal_id IS NULL
    ) THEN
        RAISE EXCEPTION
          'Customer invoice accounting requires reconciliation';
    END IF;

    IF inv.amount_paid IS NOT NULL
       AND (
           inv.amount_paid < 0
           OR inv.amount_paid::text IN (
               'NaN','Infinity','-Infinity'
           )
       )
    THEN
        RAISE EXCEPTION
          'Invalid existing invoice settlement evidence';
    END IF;

    v_outstanding := coalesce(
        inv.balance,
        inv.total - coalesce(inv.amount_paid,0)
    );

    IF v_outstanding IS NULL
       OR v_outstanding::text IN (
           'NaN','Infinity','-Infinity'
       )
       OR v_outstanding < _amount
    THEN
        RAISE EXCEPTION 'Allocation exceeds outstanding invoice balance';
    END IF;

    IF inv.total IS NULL
       OR inv.total <= 0
       OR inv.total::text IN (
           'NaN','Infinity','-Infinity'
       )
       OR coalesce(inv.amount_paid,0) > inv.total
       OR v_outstanding IS DISTINCT FROM
          round(inv.total-coalesce(inv.amount_paid,0),2)
    THEN
        RAISE EXCEPTION
          'Invoice totals and outstanding balance require reconciliation';
    END IF;

    v_paid := coalesce(inv.amount_paid,0) + _amount;

    v_balance := v_outstanding - _amount;

    v_posting := public.neo_gl_post(
        org,
        _branch,
        'finance',
        'customer_deposit_allocation',
        v_movement,
        'allocation',
        public.neo_local_today(_branch),
        d.currency,
        'Customer deposit allocated to invoice',
        jsonb_build_array(
            jsonb_build_object(
                'code','2030',
                'debit',_amount,
                'credit',0
            ),
            jsonb_build_object(
                'code','1060',
                'debit',0,
                'credit',_amount
            )
        ),
        _customer
    );

    v_journal := nullif(
        v_posting->>'journal_id',''
    )::uuid;

    IF (v_posting->>'ok')::boolean IS NOT TRUE
       OR v_journal IS NULL
    THEN
        RAISE EXCEPTION 'Deposit allocation journal was not posted';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.journal_entries j
        WHERE j.id = v_journal
          AND j.organization_id = org
          AND j.branch_id = _branch
          AND j.source_document_id = v_movement
          AND j.source_document_type =
              'customer_deposit_allocation:allocation'
          AND j.currency = d.currency
          AND j.status = 'posted'
          AND j.reversed_by_journal_id IS NULL
          AND j.total_debit = _amount
          AND j.total_credit = _amount
    ) THEN
        RAISE EXCEPTION
          'Deposit allocation journal evidence is invalid';
    END IF;

    INSERT INTO public.neo_customer_deposit_movements (
        id,
        organization_id,
        branch_id,
        deposit_id,
        movement_type,
        source_record_id,
        journal_id,
        amount,
        performed_by,
        intent_key
    )
    VALUES (
        v_movement,
        org,
        _branch,
        d.id,
        'allocation',
        inv.id,
        v_journal,
        _amount,
        auth.uid(),
        v_key
    );

    UPDATE public.invoices i
    SET amount_paid = v_paid,
        balance = v_balance,
        status = CASE
            WHEN v_balance = 0 THEN 'paid'
            ELSE 'partially_paid'
        END
    WHERE i.id = inv.id
      AND i.organization_id = org;

    RETURN jsonb_build_object(
        'ok',true,
        'movement_id',v_movement,
        'journal_id',v_journal,
        'invoice_id',inv.id,
        'invoice_balance',v_balance,
        'deposit_balance',v_available - _amount,
        'reserved_balance',v_reserved,
        'available_balance',
            v_available - _amount - v_reserved
    );

END;
$function$;


-- Financial write commands remain disabled until
-- their canonical accounting dependencies have
-- passed isolated database execution tests.

REVOKE ALL ON FUNCTION
public.neo_customer_advance_deposit_record(
    uuid,uuid,numeric,text,uuid,text
)
FROM PUBLIC,anon,authenticated;

REVOKE ALL ON FUNCTION
public.neo_customer_advance_deposit_allocate(
    uuid,uuid,uuid,uuid,numeric,text
)
FROM PUBLIC,anon,authenticated;

-- Generic cash refunds cannot be allowed to bypass
-- the customer's remaining advance deposit balance.

CREATE OR REPLACE FUNCTION
public.neo_customer_deposit_refund_boundary()
RETURNS trigger

LANGUAGE plpgsql

SECURITY DEFINER

SET search_path TO pg_catalog,public

AS $function$

BEGIN

    IF NEW.payment_id IS NOT NULL
       AND EXISTS (
           SELECT 1
           FROM public.neo_customer_advance_deposits d
           WHERE d.payment_id = NEW.payment_id

       )
    THEN
        RAISE EXCEPTION
          'Customer advance deposits require the dedicated deposit refund workflow';
    END IF;

    RETURN NEW;

END;
$function$;

CREATE TRIGGER neo_customer_deposit_refund_boundary

BEFORE INSERT OR UPDATE OF payment_id

ON public.cash_refund_requests

FOR EACH ROW

EXECUTE FUNCTION
public.neo_customer_deposit_refund_boundary();

REVOKE ALL ON FUNCTION
public.neo_customer_deposit_refund_boundary()
FROM PUBLIC,anon,authenticated;


CREATE OR REPLACE FUNCTION
public.neo_customer_deposit_transaction_context(
    _branch uuid,
    _customer uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog,public
AS $function$

DECLARE

    org uuid;

    currency_code text;

BEGIN

    org := public.neo_customer_deposit_assert_authority(
        _branch,_customer
    );

    currency_code := public.neo_fact_currency(
        org,_branch
    );

    RETURN jsonb_build_object(

        'customer_id',_customer,

        'branch_id',_branch,

        'currency',currency_code,

        'accounts',coalesce((

            SELECT jsonb_agg(
                jsonb_build_object(
                    'id',b.id,
                    'name',b.name,
                    'account_code',a.code
                )
                ORDER BY b.name,b.id
            )

            FROM public.bank_accounts b

            JOIN public.chart_of_accounts a
              ON a.id = b.gl_account_id
              AND a.organization_id = org

            WHERE b.organization_id = org

              AND (
                  b.branch_id IS NULL
                  OR b.branch_id = _branch
              )

              AND coalesce(b.active,true)

              AND a.active IS TRUE

              AND coalesce(a.postable,true)

              AND NOT coalesce(a.is_header,false)

              AND a.code =
                  public.neo_gl_settlement_code_for(
                      org,'cash'
                  )

        ),'[]'::jsonb),

        'invoices',coalesce((

            SELECT jsonb_agg(
                to_jsonb(x)
                ORDER BY x.id
            )

            FROM (

                SELECT

                    i.id,

                    coalesce(
                        to_jsonb(i)->>'invoice_number',
                        i.id::text
                    ) AS invoice_number,

                    i.currency,

                    i.status,

                    coalesce(
                        i.balance,
                        i.total-coalesce(i.amount_paid,0)
                    ) AS balance

                FROM public.invoices i

                JOIN public.journal_entries j

                  ON j.id = i.journal_id

                  AND j.organization_id = org

                  AND j.branch_id = _branch

                  AND j.currency = i.currency

                  AND j.status = 'posted'

                  AND j.reversed_by_journal_id IS NULL

                WHERE i.organization_id = org

                  AND i.branch_id = _branch

                  AND i.customer_id = _customer

                  AND i.currency = currency_code

                  AND i.status IN (
                      'issued',
                      'partially_paid',
                      'overdue'
                  )

                  AND coalesce(
                      i.balance,
                      i.total-coalesce(i.amount_paid,0)
                  ) > 0

                  AND coalesce(
                      i.balance,
                      i.total-coalesce(i.amount_paid,0)
                  )::text NOT IN (
                      'NaN','Infinity','-Infinity'
                  )

            ) x

        ),'[]'::jsonb),

        'deposits',
            public.neo_customer_advance_deposit_position(
                _branch,_customer
            ),

        'collection_enabled',
            has_function_privilege(
                'authenticated',
                'public.neo_customer_advance_deposit_record(uuid,uuid,numeric,text,uuid,text)',
                'EXECUTE'
            ),

        'allocation_enabled',
            has_function_privilege(
                'authenticated',
                'public.neo_customer_advance_deposit_allocate(uuid,uuid,uuid,uuid,numeric,text)',
                'EXECUTE'
            )

    );

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_customer_deposit_transaction_context(uuid,uuid)
FROM PUBLIC,anon;

GRANT EXECUTE ON FUNCTION
public.neo_customer_deposit_transaction_context(uuid,uuid)
TO authenticated;


CREATE OR REPLACE FUNCTION
public.neo_customer_deposit_attempt_status(
    _branch uuid,
    _customer uuid,
    _command text,
    _intent_key text
)
RETURNS jsonb

LANGUAGE plpgsql
SECURITY DEFINER

SET search_path TO pg_catalog,public

AS $function$

DECLARE

    org uuid;

    d public.neo_customer_advance_deposits%ROWTYPE;

    m public.neo_customer_deposit_movements%ROWTYPE;

    v_key text := btrim(coalesce(_intent_key,''));

BEGIN

    org := public.neo_customer_deposit_assert_authority(
        _branch,_customer
    );

    IF length(v_key) NOT BETWEEN 1 AND 200
       OR _command IS NULL
       OR _command NOT IN (
           'neo_customer_advance_deposit_record',
           'neo_customer_advance_deposit_allocate'
       )
    THEN
        RAISE EXCEPTION 'Invalid recovery transaction';
    END IF;

    IF _command = 'neo_customer_advance_deposit_record' THEN

        PERFORM pg_advisory_xact_lock(
            hashtextextended(
                org::text || ':customer-deposit:' || v_key,
                0
            )
        );

        SELECT *
        INTO d

        FROM public.neo_customer_advance_deposits

        WHERE organization_id = org
          AND intent_key = v_key;

        IF d.id IS NULL THEN

            RETURN jsonb_build_object(
                'state','not-recorded'
            );

        END IF;

        IF d.branch_id IS DISTINCT FROM _branch
           OR d.customer_id IS DISTINCT FROM _customer
           OR d.received_by IS DISTINCT FROM auth.uid()
        THEN
            RAISE EXCEPTION 'Recovery identity mismatch'
              USING ERRCODE='42501';
        END IF;

        IF NOT EXISTS (
            SELECT 1
            FROM public.payments p
            JOIN public.journal_entries j
              ON j.id = d.journal_id
            WHERE p.id = d.payment_id
              AND p.organization_id = org
              AND p.branch_id = _branch
              AND p.customer_id = _customer
              AND p.amount = d.original_amount
              AND p.currency = d.currency
              AND p.posted_journal_id = j.id
              AND p.status = 'confirmed'
              AND j.organization_id = org
              AND j.branch_id = _branch
              AND j.currency = d.currency
              AND j.status = 'posted'
              AND j.reversed_by_journal_id IS NULL
              AND j.total_debit = d.original_amount
              AND j.total_credit = d.original_amount
        ) THEN
            RAISE EXCEPTION 'Deposit requires financial reconciliation';
        END IF;

        RETURN jsonb_build_object(
            'state','recorded',
            'deposit_id',d.id,
            'payment_id',d.payment_id,
            'journal_id',d.journal_id
        );

    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended(
            org::text || ':deposit-movement:' || v_key,
            0
        )
    );

    SELECT *
    INTO m

    FROM public.neo_customer_deposit_movements

    WHERE organization_id = org
      AND intent_key = v_key;

    IF m.id IS NULL THEN

        RETURN jsonb_build_object(
            'state','not-recorded'
        );

    END IF;

    IF m.branch_id IS DISTINCT FROM _branch
       OR m.performed_by IS DISTINCT FROM auth.uid()
       OR m.movement_type <> 'allocation'
       OR NOT EXISTS (
           SELECT 1
           FROM public.neo_customer_advance_deposits a
           WHERE a.id = m.deposit_id
             AND a.organization_id = org
             AND a.branch_id = _branch
             AND a.customer_id = _customer
       )
    THEN

        RAISE EXCEPTION 'Recovery identity mismatch'
          USING ERRCODE='42501';

    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.journal_entries j
        JOIN public.neo_customer_advance_deposits a
          ON a.id = m.deposit_id
        WHERE j.id = m.journal_id
          AND j.organization_id = org
          AND j.branch_id = _branch
          AND j.currency = a.currency
          AND j.status = 'posted'
          AND j.reversed_by_journal_id IS NULL
          AND j.total_debit = m.amount
          AND j.total_credit = m.amount
    ) THEN
        RAISE EXCEPTION 'Allocation requires financial reconciliation';
    END IF;

    RETURN jsonb_build_object(
        'state','recorded',
        'movement_id',m.id,
        'journal_id',m.journal_id
    );

END;

$function$;

REVOKE ALL ON FUNCTION
public.neo_customer_deposit_attempt_status(
    uuid,uuid,text,text
)
FROM PUBLIC,anon;

GRANT EXECUTE ON FUNCTION
public.neo_customer_deposit_attempt_status(
    uuid,uuid,text,text
)
TO authenticated;


-- Dedicated customer advance deposit refund workflow.

CREATE TABLE IF NOT EXISTS
public.neo_customer_deposit_refund_requests (

    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    organization_id uuid NOT NULL,

    branch_id uuid NOT NULL,

    customer_id uuid NOT NULL,

    deposit_id uuid NOT NULL
      REFERENCES public.neo_customer_advance_deposits(id)
      ON DELETE RESTRICT,

    amount numeric(18,2) NOT NULL
      CHECK (
          amount > 0
          AND amount::text NOT IN (
              'NaN','Infinity','-Infinity'
          )
      ),

    currency text NOT NULL,

    reason text NOT NULL
      CHECK (length(btrim(reason)) BETWEEN 10 AND 4000),

    status text NOT NULL DEFAULT 'pending-approval'
      CHECK (
          status IN (
              'pending-approval',
              'approved',
              'rejected',
              'settled'
          )
      ),

    requested_by uuid NOT NULL,

    requested_at timestamptz NOT NULL DEFAULT now(),

    decided_by uuid,

    decided_at timestamptz,

    decision_note text,

    settled_by uuid,

    settled_at timestamptz,

    refund_payment_id uuid UNIQUE,

    refund_journal_id uuid UNIQUE,

    intent_key text NOT NULL,

    UNIQUE (organization_id,intent_key),

    CHECK (
        decided_by IS NULL
        OR decided_by <> requested_by
    ),

    CHECK (
        status = 'pending-approval'
        OR (
            decided_by IS NOT NULL
            AND decided_at IS NOT NULL
            AND decision_note IS NOT NULL
        )
    ),

    CHECK (
        status <> 'settled'
        OR (
            settled_by IS NOT NULL
            AND settled_at IS NOT NULL
            AND refund_payment_id IS NOT NULL
            AND refund_journal_id IS NOT NULL
        )
    )

);

ALTER TABLE public.neo_customer_deposit_refund_requests
ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON
public.neo_customer_deposit_refund_requests
FROM PUBLIC,anon,authenticated;

CREATE INDEX IF NOT EXISTS
neo_customer_deposit_refund_requests_scope_idx
ON public.neo_customer_deposit_refund_requests (
    organization_id,
    branch_id,
    deposit_id,
    status
);


-- Request an unused deposit refund.

CREATE OR REPLACE FUNCTION
public.neo_customer_deposit_refund_request(
    _branch uuid,
    _customer uuid,
    _deposit uuid,
    _amount numeric,
    _reason text,
    _intent_key text
)
RETURNS jsonb

LANGUAGE plpgsql
SECURITY DEFINER

SET search_path TO pg_catalog,public

AS $function$

DECLARE

    org uuid;

    d public.neo_customer_advance_deposits%ROWTYPE;

    r public.neo_customer_deposit_refund_requests%ROWTYPE;

    v_key text := btrim(coalesce(_intent_key,''));

    v_reason text := btrim(coalesce(_reason,''));

    v_used numeric;

    v_reserved numeric;

    v_available numeric;

BEGIN

    org := public.neo_customer_deposit_assert_authority(
        _branch,_customer
    );

    IF _amount IS NULL
       OR _amount::text IN (
           'NaN','Infinity','-Infinity'
       )
       OR _amount <= 0
       OR _amount <> round(_amount,2)
       OR _amount > 9999999999999999.99
    THEN
        RAISE EXCEPTION 'Invalid deposit refund amount';
    END IF;

    IF length(v_reason) NOT BETWEEN 10 AND 4000
       OR length(v_key) NOT BETWEEN 1 AND 200
    THEN
        RAISE EXCEPTION 'Valid refund reason and identity required';
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended(
            org::text || ':deposit-refund:' || v_key,
            0
        )
    );

    SELECT *
    INTO d

    FROM public.neo_customer_advance_deposits

    WHERE id = _deposit
      AND organization_id = org
      AND branch_id = _branch
      AND customer_id = _customer

    FOR UPDATE;

    IF d.id IS NULL THEN
        RAISE EXCEPTION 'Deposit unavailable'
          USING ERRCODE='42501';
    END IF;

    SELECT *
    INTO r

    FROM public.neo_customer_deposit_refund_requests

    WHERE organization_id = org
      AND intent_key = v_key;

    IF r.id IS NOT NULL THEN

        IF r.branch_id IS DISTINCT FROM _branch
           OR r.customer_id IS DISTINCT FROM _customer
           OR r.deposit_id IS DISTINCT FROM _deposit
           OR r.amount IS DISTINCT FROM _amount
           OR r.reason IS DISTINCT FROM v_reason
           OR r.requested_by IS DISTINCT FROM auth.uid()
        THEN
            RAISE EXCEPTION 'Refund retry payload mismatch';
        END IF;

        RETURN jsonb_build_object(
            'ok',true,
            'refund_id',r.id,
            'status',r.status,
            'amount',r.amount,
            'already_requested',true
        );

    END IF;

    -- Reuse the existing deposit accounting validation.
    PERFORM public.neo_customer_advance_deposit_position(
        _branch,_customer
    );

    SELECT coalesce(sum(m.amount),0)
    INTO v_used

    FROM public.neo_customer_deposit_movements m

    WHERE m.organization_id = org
      AND m.deposit_id = d.id;

    SELECT coalesce(sum(f.amount),0)
    INTO v_reserved

    FROM public.neo_customer_deposit_refund_requests f

    WHERE f.organization_id = org
      AND f.deposit_id = d.id
      AND f.status IN (
          'pending-approval','approved'
      );

    v_available :=
        d.original_amount-v_used-v_reserved;

    IF v_available < 0 THEN
        RAISE EXCEPTION 'Deposit requires reconciliation';
    END IF;

    IF _amount > v_available THEN
        RAISE EXCEPTION
          'Refund exceeds unallocated and unreserved deposit balance';
    END IF;

    INSERT INTO public.neo_customer_deposit_refund_requests (
        organization_id,
        branch_id,
        customer_id,
        deposit_id,
        amount,
        currency,
        reason,
        requested_by,
        intent_key
    )
    VALUES (
        org,
        _branch,
        _customer,
        d.id,
        _amount,
        d.currency,
        v_reason,
        auth.uid(),
        v_key
    )
    RETURNING * INTO r;

    RETURN jsonb_build_object(
        'ok',true,
        'refund_id',r.id,
        'status',r.status,
        'amount',r.amount,
        'remaining_available',v_available-_amount,
        'cash_disbursed',false
    );

END;

$function$;


-- Independent Finance approval or rejection.

CREATE OR REPLACE FUNCTION
public.neo_customer_deposit_refund_decide(
    _refund uuid,
    _approve boolean,
    _note text
)
RETURNS jsonb

LANGUAGE plpgsql
SECURITY DEFINER

SET search_path TO pg_catalog,public

AS $function$

DECLARE

    org uuid := public.current_org_id();

    r public.neo_customer_deposit_refund_requests%ROWTYPE;

    v_note text := btrim(coalesce(_note,''));

    v_status text;

BEGIN

    IF auth.uid() IS NULL
       OR org IS NULL
       OR public.current_access_scope() IS NULL
       OR public.current_access_scope() = 'technical'
       OR NOT coalesce(
           public.has_permission(
               'finance','payment.approve'
           )
           OR public.has_permission(
               'finance','approve'
           )
           OR public.is_org_admin(),
           false
       )
    THEN
        RAISE EXCEPTION 'Refund approval access denied'
          USING ERRCODE='42501';
    END IF;

    IF _approve IS NULL
       OR length(v_note) NOT BETWEEN 10 AND 4000
    THEN
        RAISE EXCEPTION 'Valid refund decision reason required';
    END IF;

    SELECT *
    INTO r

    FROM public.neo_customer_deposit_refund_requests

    WHERE id = _refund
      AND organization_id = org;

    IF r.id IS NULL
       OR public.neo_branch_in_scope(r.branch_id)
          IS NOT TRUE
    THEN
        RAISE EXCEPTION 'Refund unavailable'
          USING ERRCODE='42501';
    END IF;

    -- Match the deposit-first locking order used
    -- by request and allocation commands.

    PERFORM 1

    FROM public.neo_customer_advance_deposits

    WHERE id = r.deposit_id
      AND organization_id = org
      AND branch_id = r.branch_id
      AND customer_id = r.customer_id

    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Refund deposit unavailable';
    END IF;

    SELECT *
    INTO r

    FROM public.neo_customer_deposit_refund_requests

    WHERE id = _refund
      AND organization_id = org

    FOR UPDATE;

    IF r.requested_by = auth.uid() THEN
        RAISE EXCEPTION 'Independent refund approval required';
    END IF;

    v_status := CASE
        WHEN _approve THEN 'approved'
        ELSE 'rejected'
    END;

    IF r.status = v_status
       AND r.decided_by = auth.uid()
       AND r.decision_note = v_note
    THEN

        RETURN jsonb_build_object(
            'ok',true,
            'refund_id',r.id,
            'status',r.status,
            'already_decided',true
        );

    END IF;

    IF r.status <> 'pending-approval' THEN
        RAISE EXCEPTION 'Refund decision already closed';
    END IF;

    UPDATE public.neo_customer_deposit_refund_requests

    SET status = v_status,
        decided_by = auth.uid(),
        decided_at = now(),
        decision_note = v_note

    WHERE id = r.id;

    RETURN jsonb_build_object(
        'ok',true,
        'refund_id',r.id,
        'status',v_status,
        'cash_disbursed',false
    );

END;

$function$;


-- Read-only refund history for authorised Finance users.

CREATE OR REPLACE FUNCTION
public.neo_customer_deposit_refund_history(
    _branch uuid,
    _customer uuid
)
RETURNS jsonb

LANGUAGE plpgsql
STABLE
SECURITY DEFINER

SET search_path TO pg_catalog,public

AS $function$

DECLARE

    org uuid := public.current_org_id();

BEGIN

    IF auth.uid() IS NULL
       OR org IS NULL
       OR public.current_access_scope() IS NULL
       OR public.current_access_scope() = 'technical'
       OR public.neo_branch_in_scope(_branch) IS NOT TRUE
       OR NOT coalesce(
           public.has_permission('finance','view')
           OR public.has_permission(
               'finance','ar.allocate_receipt'
           )
           OR public.has_permission(
               'finance','payment.approve'
           )
           OR public.has_permission('finance','approve')
           OR public.is_org_admin(),
           false
       )
    THEN
        RAISE EXCEPTION 'Refund history access denied'
          USING ERRCODE='42501';
    END IF;

    RETURN coalesce((

        SELECT jsonb_agg(
            to_jsonb(x)
            ORDER BY x.requested_at DESC,x.id
        )

        FROM (

            SELECT

                r.id,
                r.deposit_id,
                r.amount,
                r.currency,
                r.reason,
                r.status,
                r.requested_at,
                r.decided_at,
                r.decision_note,
                r.settled_at,
                r.refund_payment_id,

                (
                    r.requested_by <> auth.uid()
                    AND r.status = 'pending-approval'
                    AND coalesce(
                        public.has_permission(
                            'finance','payment.approve'
                        )
                        OR public.has_permission(
                            'finance','approve'
                        )
                        OR public.is_org_admin(),
                        false
                    )
                ) AS may_decide

            FROM public.neo_customer_deposit_refund_requests r

            WHERE r.organization_id = org
              AND r.branch_id = _branch
              AND r.customer_id = _customer

            ORDER BY r.requested_at DESC,r.id

            LIMIT 200

        ) x

    ),'[]'::jsonb);

END;

$function$;


-- Financial commands remain disabled pending
-- isolated transaction verification.

REVOKE ALL ON FUNCTION
public.neo_customer_deposit_refund_request(
    uuid,uuid,uuid,numeric,text,text
)
FROM PUBLIC,anon,authenticated;

REVOKE ALL ON FUNCTION
public.neo_customer_deposit_refund_decide(
    uuid,boolean,text
)
FROM PUBLIC,anon,authenticated;

REVOKE ALL ON FUNCTION
public.neo_customer_deposit_refund_history(uuid,uuid)
FROM PUBLIC,anon;

GRANT EXECUTE ON FUNCTION
public.neo_customer_deposit_refund_history(uuid,uuid)
TO authenticated;


-- Protect reserved refunds against subsequent allocation.

CREATE OR REPLACE FUNCTION
public.neo_customer_deposit_movement_reservation_guard()
RETURNS trigger

LANGUAGE plpgsql
SECURITY DEFINER

SET search_path TO pg_catalog,public

AS $function$

DECLARE

    d public.neo_customer_advance_deposits%ROWTYPE;

    v_used numeric;

    v_reserved numeric;

BEGIN

    SELECT *
    INTO d

    FROM public.neo_customer_advance_deposits

    WHERE id = NEW.deposit_id

    FOR UPDATE;

    IF d.id IS NULL
       OR d.organization_id
          IS DISTINCT FROM NEW.organization_id
       OR d.branch_id
          IS DISTINCT FROM NEW.branch_id
    THEN
        RAISE EXCEPTION 'Invalid deposit movement scope';
    END IF;

    IF NEW.amount IS NULL
       OR NEW.amount <= 0
       OR NEW.amount::text IN (
           'NaN','Infinity','-Infinity'
       )
       OR NEW.amount <> round(NEW.amount,2)
    THEN
        RAISE EXCEPTION 'Invalid deposit movement amount';
    END IF;

    IF NEW.movement_type = 'allocation' THEN

        SELECT coalesce(sum(m.amount),0)
        INTO v_used

        FROM public.neo_customer_deposit_movements m

        WHERE m.deposit_id = d.id
          AND m.organization_id = d.organization_id;

        SELECT coalesce(sum(r.amount),0)
        INTO v_reserved

        FROM public.neo_customer_deposit_refund_requests r

        WHERE r.deposit_id = d.id
          AND r.organization_id = d.organization_id
          AND r.status IN (
              'pending-approval','approved'
          );

        IF NEW.amount >
           d.original_amount-v_used-v_reserved
        THEN
            RAISE EXCEPTION
              'Allocation exceeds available balance after reserved refunds';
        END IF;

    ELSIF NEW.movement_type = 'refund' THEN

        IF NOT EXISTS (

            SELECT 1

            FROM public.neo_customer_deposit_refund_requests r

            JOIN public.journal_entries j
              ON j.id = r.refund_journal_id

            JOIN public.payments p
              ON p.id = r.refund_payment_id

            WHERE r.id = NEW.source_record_id

              AND r.organization_id = d.organization_id

              AND r.branch_id = d.branch_id

              AND r.customer_id = d.customer_id

              AND r.deposit_id = d.id

              AND r.status = 'settled'

              AND r.amount = NEW.amount

              AND r.currency = d.currency

              AND r.refund_journal_id = NEW.journal_id

              AND r.settled_by = NEW.performed_by

              AND p.organization_id = d.organization_id

              AND p.branch_id = d.branch_id

              AND p.customer_id = d.customer_id

              AND p.amount = -NEW.amount

              AND p.currency = d.currency

              AND p.status = 'confirmed'

              AND p.posted_journal_id = j.id

              AND j.organization_id = d.organization_id

              AND j.branch_id = d.branch_id

              AND j.currency = d.currency

              AND j.status = 'posted'

              AND j.reversed_by_journal_id IS NULL

              AND j.total_debit = NEW.amount

              AND j.total_credit = NEW.amount

        ) THEN

            RAISE EXCEPTION
              'Refund movement requires approved settlement evidence';

        END IF;

        SELECT coalesce(sum(m.amount),0)
        INTO v_used

        FROM public.neo_customer_deposit_movements m

        WHERE m.deposit_id = d.id
          AND m.organization_id = d.organization_id;

        SELECT coalesce(sum(r.amount),0)
        INTO v_reserved

        FROM public.neo_customer_deposit_refund_requests r

        WHERE r.deposit_id = d.id
          AND r.organization_id = d.organization_id
          AND r.status IN (
              'pending-approval','approved'
          );

        IF NEW.amount >
           d.original_amount-v_used-v_reserved
        THEN
            RAISE EXCEPTION
              'Refund exceeds remaining deposit liability';
        END IF;

    ELSE

        RAISE EXCEPTION 'Unsupported deposit movement';

    END IF;

    RETURN NEW;

END;

$function$;

REVOKE ALL ON FUNCTION
public.neo_customer_deposit_movement_reservation_guard()
FROM PUBLIC,anon,authenticated;

DROP TRIGGER IF EXISTS
neo_customer_deposit_movement_reservation_guard
ON public.neo_customer_deposit_movements;

CREATE TRIGGER
neo_customer_deposit_movement_reservation_guard

BEFORE INSERT

ON public.neo_customer_deposit_movements

FOR EACH ROW

EXECUTE FUNCTION
public.neo_customer_deposit_movement_reservation_guard();

NOTIFY pgrst,'reload schema';


-- Dedicated customer advance deposit refund workflow.

CREATE TABLE IF NOT EXISTS
public.neo_customer_deposit_refund_requests (

    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    organization_id uuid NOT NULL,

    branch_id uuid NOT NULL,

    customer_id uuid NOT NULL,

    deposit_id uuid NOT NULL
      REFERENCES public.neo_customer_advance_deposits(id)
      ON DELETE RESTRICT,

    amount numeric(18,2) NOT NULL
      CHECK (
          amount > 0
          AND amount::text NOT IN (
              'NaN','Infinity','-Infinity'
          )
      ),

    currency text NOT NULL,

    reason text NOT NULL
      CHECK (length(btrim(reason)) BETWEEN 10 AND 4000),

    status text NOT NULL DEFAULT 'pending-approval'
      CHECK (
          status IN (
              'pending-approval',
              'approved',
              'rejected',
              'settled'
          )
      ),

    requested_by uuid NOT NULL,

    requested_at timestamptz NOT NULL DEFAULT now(),

    decided_by uuid,

    decided_at timestamptz,

    decision_note text,

    settled_by uuid,

    settled_at timestamptz,

    refund_payment_id uuid UNIQUE,

    refund_journal_id uuid UNIQUE,

    intent_key text NOT NULL,

    UNIQUE (organization_id,intent_key),

    CHECK (
        decided_by IS NULL
        OR decided_by <> requested_by
    ),

    CHECK (
        status = 'pending-approval'
        OR (
            decided_by IS NOT NULL
            AND decided_at IS NOT NULL
            AND decision_note IS NOT NULL
        )
    ),

    CHECK (
        status <> 'settled'
        OR (
            settled_by IS NOT NULL
            AND settled_at IS NOT NULL
            AND refund_payment_id IS NOT NULL
            AND refund_journal_id IS NOT NULL
        )
    )

);

ALTER TABLE public.neo_customer_deposit_refund_requests
ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON
public.neo_customer_deposit_refund_requests
FROM PUBLIC,anon,authenticated;

CREATE INDEX IF NOT EXISTS
neo_customer_deposit_refund_requests_scope_idx
ON public.neo_customer_deposit_refund_requests (
    organization_id,
    branch_id,
    deposit_id,
    status
);


-- Request an unused deposit refund.

CREATE OR REPLACE FUNCTION
public.neo_customer_deposit_refund_request(
    _branch uuid,
    _customer uuid,
    _deposit uuid,
    _amount numeric,
    _reason text,
    _intent_key text
)
RETURNS jsonb

LANGUAGE plpgsql
SECURITY DEFINER

SET search_path TO pg_catalog,public

AS $function$

DECLARE

    org uuid;

    d public.neo_customer_advance_deposits%ROWTYPE;

    r public.neo_customer_deposit_refund_requests%ROWTYPE;

    v_key text := btrim(coalesce(_intent_key,''));

    v_reason text := btrim(coalesce(_reason,''));

    v_used numeric;

    v_reserved numeric;

    v_available numeric;

BEGIN

    org := public.neo_customer_deposit_assert_authority(
        _branch,_customer
    );

    IF _amount IS NULL
       OR _amount::text IN (
           'NaN','Infinity','-Infinity'
       )
       OR _amount <= 0
       OR _amount <> round(_amount,2)
       OR _amount > 9999999999999999.99
    THEN
        RAISE EXCEPTION 'Invalid deposit refund amount';
    END IF;

    IF length(v_reason) NOT BETWEEN 10 AND 4000
       OR length(v_key) NOT BETWEEN 1 AND 200
    THEN
        RAISE EXCEPTION 'Valid refund reason and identity required';
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended(
            org::text || ':deposit-refund:' || v_key,
            0
        )
    );

    SELECT *
    INTO d

    FROM public.neo_customer_advance_deposits

    WHERE id = _deposit
      AND organization_id = org
      AND branch_id = _branch
      AND customer_id = _customer

    FOR UPDATE;

    IF d.id IS NULL THEN
        RAISE EXCEPTION 'Deposit unavailable'
          USING ERRCODE='42501';
    END IF;

    SELECT *
    INTO r

    FROM public.neo_customer_deposit_refund_requests

    WHERE organization_id = org
      AND intent_key = v_key;

    IF r.id IS NOT NULL THEN

        IF r.branch_id IS DISTINCT FROM _branch
           OR r.customer_id IS DISTINCT FROM _customer
           OR r.deposit_id IS DISTINCT FROM _deposit
           OR r.amount IS DISTINCT FROM _amount
           OR r.reason IS DISTINCT FROM v_reason
           OR r.requested_by IS DISTINCT FROM auth.uid()
        THEN
            RAISE EXCEPTION 'Refund retry payload mismatch';
        END IF;

        RETURN jsonb_build_object(
            'ok',true,
            'refund_id',r.id,
            'status',r.status,
            'amount',r.amount,
            'already_requested',true
        );

    END IF;

    -- Reuse the existing deposit accounting validation.
    PERFORM public.neo_customer_advance_deposit_position(
        _branch,_customer
    );

    SELECT coalesce(sum(m.amount),0)
    INTO v_used

    FROM public.neo_customer_deposit_movements m

    WHERE m.organization_id = org
      AND m.deposit_id = d.id;

    SELECT coalesce(sum(f.amount),0)
    INTO v_reserved

    FROM public.neo_customer_deposit_refund_requests f

    WHERE f.organization_id = org
      AND f.deposit_id = d.id
      AND f.status IN (
          'pending-approval','approved'
      );

    v_available :=
        d.original_amount-v_used-v_reserved;

    IF v_available < 0 THEN
        RAISE EXCEPTION 'Deposit requires reconciliation';
    END IF;

    IF _amount > v_available THEN
        RAISE EXCEPTION
          'Refund exceeds unallocated and unreserved deposit balance';
    END IF;

    INSERT INTO public.neo_customer_deposit_refund_requests (
        organization_id,
        branch_id,
        customer_id,
        deposit_id,
        amount,
        currency,
        reason,
        requested_by,
        intent_key
    )
    VALUES (
        org,
        _branch,
        _customer,
        d.id,
        _amount,
        d.currency,
        v_reason,
        auth.uid(),
        v_key
    )
    RETURNING * INTO r;

    RETURN jsonb_build_object(
        'ok',true,
        'refund_id',r.id,
        'status',r.status,
        'amount',r.amount,
        'remaining_available',v_available-_amount,
        'cash_disbursed',false
    );

END;

$function$;


-- Independent Finance approval or rejection.

CREATE OR REPLACE FUNCTION
public.neo_customer_deposit_refund_decide(
    _refund uuid,
    _approve boolean,
    _note text
)
RETURNS jsonb

LANGUAGE plpgsql
SECURITY DEFINER

SET search_path TO pg_catalog,public

AS $function$

DECLARE

    org uuid := public.current_org_id();

    r public.neo_customer_deposit_refund_requests%ROWTYPE;

    v_note text := btrim(coalesce(_note,''));

    v_status text;

BEGIN

    IF auth.uid() IS NULL
       OR org IS NULL
       OR public.current_access_scope() IS NULL
       OR public.current_access_scope() = 'technical'
       OR NOT coalesce(
           public.has_permission(
               'finance','payment.approve'
           )
           OR public.has_permission(
               'finance','approve'
           )
           OR public.is_org_admin(),
           false
       )
    THEN
        RAISE EXCEPTION 'Refund approval access denied'
          USING ERRCODE='42501';
    END IF;

    IF _approve IS NULL
       OR length(v_note) NOT BETWEEN 10 AND 4000
    THEN
        RAISE EXCEPTION 'Valid refund decision reason required';
    END IF;

    SELECT *
    INTO r

    FROM public.neo_customer_deposit_refund_requests

    WHERE id = _refund
      AND organization_id = org;

    IF r.id IS NULL
       OR public.neo_branch_in_scope(r.branch_id)
          IS NOT TRUE
    THEN
        RAISE EXCEPTION 'Refund unavailable'
          USING ERRCODE='42501';
    END IF;

    -- Match the deposit-first locking order used
    -- by request and allocation commands.

    PERFORM 1

    FROM public.neo_customer_advance_deposits

    WHERE id = r.deposit_id
      AND organization_id = org
      AND branch_id = r.branch_id
      AND customer_id = r.customer_id

    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Refund deposit unavailable';
    END IF;

    SELECT *
    INTO r

    FROM public.neo_customer_deposit_refund_requests

    WHERE id = _refund
      AND organization_id = org

    FOR UPDATE;

    IF r.requested_by = auth.uid() THEN
        RAISE EXCEPTION 'Independent refund approval required';
    END IF;

    v_status := CASE
        WHEN _approve THEN 'approved'
        ELSE 'rejected'
    END;

    IF r.status = v_status
       AND r.decided_by = auth.uid()
       AND r.decision_note = v_note
    THEN

        RETURN jsonb_build_object(
            'ok',true,
            'refund_id',r.id,
            'status',r.status,
            'already_decided',true
        );

    END IF;

    IF r.status <> 'pending-approval' THEN
        RAISE EXCEPTION 'Refund decision already closed';
    END IF;

    UPDATE public.neo_customer_deposit_refund_requests

    SET status = v_status,
        decided_by = auth.uid(),
        decided_at = now(),
        decision_note = v_note

    WHERE id = r.id;

    RETURN jsonb_build_object(
        'ok',true,
        'refund_id',r.id,
        'status',v_status,
        'cash_disbursed',false
    );

END;

$function$;


-- Read-only refund history for authorised Finance users.

CREATE OR REPLACE FUNCTION
public.neo_customer_deposit_refund_history(
    _branch uuid,
    _customer uuid
)
RETURNS jsonb

LANGUAGE plpgsql
STABLE
SECURITY DEFINER

SET search_path TO pg_catalog,public

AS $function$

DECLARE

    org uuid := public.current_org_id();

BEGIN

    IF auth.uid() IS NULL
       OR org IS NULL
       OR public.current_access_scope() IS NULL
       OR public.current_access_scope() = 'technical'
       OR public.neo_branch_in_scope(_branch) IS NOT TRUE
       OR NOT coalesce(
           public.has_permission('finance','view')
           OR public.has_permission(
               'finance','ar.allocate_receipt'
           )
           OR public.has_permission(
               'finance','payment.approve'
           )
           OR public.has_permission('finance','approve')
           OR public.is_org_admin(),
           false
       )
    THEN
        RAISE EXCEPTION 'Refund history access denied'
          USING ERRCODE='42501';
    END IF;

    RETURN coalesce((

        SELECT jsonb_agg(
            to_jsonb(x)
            ORDER BY x.requested_at DESC,x.id
        )

        FROM (

            SELECT

                r.id,
                r.deposit_id,
                r.amount,
                r.currency,
                r.reason,
                r.status,
                r.requested_at,
                r.decided_at,
                r.decision_note,
                r.settled_at,
                r.refund_payment_id,

                (
                    r.requested_by <> auth.uid()
                    AND r.status = 'pending-approval'
                    AND coalesce(
                        public.has_permission(
                            'finance','payment.approve'
                        )
                        OR public.has_permission(
                            'finance','approve'
                        )
                        OR public.is_org_admin(),
                        false
                    )
                ) AS may_decide

            FROM public.neo_customer_deposit_refund_requests r

            WHERE r.organization_id = org
              AND r.branch_id = _branch
              AND r.customer_id = _customer

            ORDER BY r.requested_at DESC,r.id

            LIMIT 200

        ) x

    ),'[]'::jsonb);

END;

$function$;


-- Financial commands remain disabled pending
-- isolated transaction verification.

REVOKE ALL ON FUNCTION
public.neo_customer_deposit_refund_request(
    uuid,uuid,uuid,numeric,text,text
)
FROM PUBLIC,anon,authenticated;

REVOKE ALL ON FUNCTION
public.neo_customer_deposit_refund_decide(
    uuid,boolean,text
)
FROM PUBLIC,anon,authenticated;

REVOKE ALL ON FUNCTION
public.neo_customer_deposit_refund_history(uuid,uuid)
FROM PUBLIC,anon;

GRANT EXECUTE ON FUNCTION
public.neo_customer_deposit_refund_history(uuid,uuid)
TO authenticated;


-- Protect reserved refunds against subsequent allocation.

CREATE OR REPLACE FUNCTION
public.neo_customer_deposit_movement_reservation_guard()
RETURNS trigger

LANGUAGE plpgsql
SECURITY DEFINER

SET search_path TO pg_catalog,public

AS $function$

DECLARE

    d public.neo_customer_advance_deposits%ROWTYPE;

    v_used numeric;

    v_reserved numeric;

BEGIN

    SELECT *
    INTO d

    FROM public.neo_customer_advance_deposits

    WHERE id = NEW.deposit_id

    FOR UPDATE;

    IF d.id IS NULL
       OR d.organization_id
          IS DISTINCT FROM NEW.organization_id
       OR d.branch_id
          IS DISTINCT FROM NEW.branch_id
    THEN
        RAISE EXCEPTION 'Invalid deposit movement scope';
    END IF;

    IF NEW.amount IS NULL
       OR NEW.amount <= 0
       OR NEW.amount::text IN (
           'NaN','Infinity','-Infinity'
       )
       OR NEW.amount <> round(NEW.amount,2)
    THEN
        RAISE EXCEPTION 'Invalid deposit movement amount';
    END IF;

    IF NEW.movement_type = 'allocation' THEN

        SELECT coalesce(sum(m.amount),0)
        INTO v_used

        FROM public.neo_customer_deposit_movements m

        WHERE m.deposit_id = d.id
          AND m.organization_id = d.organization_id;

        SELECT coalesce(sum(r.amount),0)
        INTO v_reserved

        FROM public.neo_customer_deposit_refund_requests r

        WHERE r.deposit_id = d.id
          AND r.organization_id = d.organization_id
          AND r.status IN (
              'pending-approval','approved'
          );

        IF NEW.amount >
           d.original_amount-v_used-v_reserved
        THEN
            RAISE EXCEPTION
              'Allocation exceeds available balance after reserved refunds';
        END IF;

    ELSIF NEW.movement_type = 'refund' THEN

        IF NOT EXISTS (

            SELECT 1

            FROM public.neo_customer_deposit_refund_requests r

            JOIN public.journal_entries j
              ON j.id = r.refund_journal_id

            JOIN public.payments p
              ON p.id = r.refund_payment_id

            WHERE r.id = NEW.source_record_id

              AND r.organization_id = d.organization_id

              AND r.branch_id = d.branch_id

              AND r.customer_id = d.customer_id

              AND r.deposit_id = d.id

              AND r.status = 'settled'

              AND r.amount = NEW.amount

              AND r.currency = d.currency

              AND r.refund_journal_id = NEW.journal_id

              AND r.settled_by = NEW.performed_by

              AND p.organization_id = d.organization_id

              AND p.branch_id = d.branch_id

              AND p.customer_id = d.customer_id

              AND p.amount = -NEW.amount

              AND p.currency = d.currency

              AND p.status = 'confirmed'

              AND p.posted_journal_id = j.id

              AND j.organization_id = d.organization_id

              AND j.branch_id = d.branch_id

              AND j.currency = d.currency

              AND j.status = 'posted'

              AND j.reversed_by_journal_id IS NULL

              AND j.total_debit = NEW.amount

              AND j.total_credit = NEW.amount

        ) THEN

            RAISE EXCEPTION
              'Refund movement requires approved settlement evidence';

        END IF;

        SELECT coalesce(sum(m.amount),0)
        INTO v_used

        FROM public.neo_customer_deposit_movements m

        WHERE m.deposit_id = d.id
          AND m.organization_id = d.organization_id;

        SELECT coalesce(sum(r.amount),0)
        INTO v_reserved

        FROM public.neo_customer_deposit_refund_requests r

        WHERE r.deposit_id = d.id
          AND r.organization_id = d.organization_id
          AND r.status IN (
              'pending-approval','approved'
          );

        IF NEW.amount >
           d.original_amount-v_used-v_reserved
        THEN
            RAISE EXCEPTION
              'Refund exceeds remaining deposit liability';
        END IF;

    ELSE

        RAISE EXCEPTION 'Unsupported deposit movement';

    END IF;

    RETURN NEW;

END;

$function$;

REVOKE ALL ON FUNCTION
public.neo_customer_deposit_movement_reservation_guard()
FROM PUBLIC,anon,authenticated;

DROP TRIGGER IF EXISTS
neo_customer_deposit_movement_reservation_guard
ON public.neo_customer_deposit_movements;

CREATE TRIGGER
neo_customer_deposit_movement_reservation_guard

BEFORE INSERT

ON public.neo_customer_deposit_movements

FOR EACH ROW

EXECUTE FUNCTION
public.neo_customer_deposit_movement_reservation_guard();

NOTIFY pgrst,'reload schema';


CREATE OR REPLACE FUNCTION
public.neo_customer_deposit_refund_settle(
    _refund uuid,
    _account uuid
)
RETURNS jsonb

LANGUAGE plpgsql
SECURITY DEFINER

SET search_path TO pg_catalog,public

AS $function$

DECLARE

    org uuid := public.current_org_id();

    actor uuid := auth.uid();

    r public.neo_customer_deposit_refund_requests%ROWTYPE;

    d public.neo_customer_advance_deposits%ROWTYPE;

    original_payment public.payments%ROWTYPE;

    v_shift uuid;

    v_payment uuid;

    v_journal uuid;

    v_posting jsonb;

    v_cash_code text;

    v_account_code text;

    v_used numeric;

    v_reserved numeric;

    v_expected_cash numeric;

    v_cash_after_payment numeric;

    v_cash_after_refund numeric;

    v_movement uuid;

    v_receipt text;

BEGIN

    IF actor IS NULL
       OR org IS NULL
       OR public.current_access_scope() IS NULL
       OR public.current_access_scope() = 'technical'

    THEN

        RAISE EXCEPTION 'Refund settlement access denied'
          USING ERRCODE='42501';

    END IF;

    PERFORM public.neo_assert_capability(
        'finance','payments','refund_payment'
    );

    SELECT *
    INTO r

    FROM public.neo_customer_deposit_refund_requests

    WHERE id = _refund
      AND organization_id = org;

    IF r.id IS NULL
       OR public.neo_branch_in_scope(r.branch_id)
          IS NOT TRUE
    THEN

        RAISE EXCEPTION 'Refund unavailable'
          USING ERRCODE='42501';

    END IF;

    SELECT *
    INTO d

    FROM public.neo_customer_advance_deposits

    WHERE id = r.deposit_id
      AND organization_id = org
      AND branch_id = r.branch_id
      AND customer_id = r.customer_id

    FOR UPDATE;

    IF d.id IS NULL THEN
        RAISE EXCEPTION 'Refund deposit unavailable';
    END IF;

    SELECT *
    INTO r

    FROM public.neo_customer_deposit_refund_requests

    WHERE id = _refund
      AND organization_id = org

    FOR UPDATE;

    -- Replay never disburses cash again.

    IF r.status = 'settled' THEN

        IF NOT EXISTS (

            SELECT 1

            FROM public.neo_customer_deposit_movements m

            JOIN public.payments p
              ON p.id = r.refund_payment_id

            JOIN public.journal_entries j
              ON j.id = r.refund_journal_id

            WHERE m.organization_id = org

              AND m.branch_id = r.branch_id

              AND m.deposit_id = d.id

              AND m.source_record_id = r.id

              AND m.movement_type = 'refund'

              AND m.amount = r.amount

              AND m.journal_id = j.id

              AND p.organization_id = org

              AND p.branch_id = r.branch_id

              AND p.customer_id = r.customer_id

              AND p.destination_account_id = _account

              AND p.amount = -r.amount

              AND p.currency = r.currency

              AND p.status = 'confirmed'

              AND p.posted_journal_id = j.id

              AND j.organization_id = org

              AND j.branch_id = r.branch_id

              AND j.currency = r.currency

              AND j.status = 'posted'

              AND j.reversed_by_journal_id IS NULL

              AND j.total_debit = r.amount

              AND j.total_credit = r.amount

        ) THEN

            RAISE EXCEPTION
              'Existing refund requires reconciliation';

        END IF;

        RETURN jsonb_build_object(
            'ok',true,
            'refund_id',r.id,
            'status','settled',
            'payment_id',r.refund_payment_id,
            'journal_id',r.refund_journal_id,
            'already_settled',true
        );

    END IF;

    IF r.status <> 'approved'

       OR r.decided_by IS NULL

       OR r.decided_by = r.requested_by

       OR r.decided_at IS NULL

    THEN

        RAISE EXCEPTION
          'Independent approved refund required';

    END IF;

    IF r.currency IS DISTINCT FROM d.currency

       OR r.amount IS NULL

       OR r.amount <= 0

       OR r.amount::text IN (
           'NaN','Infinity','-Infinity'
       )

    THEN

        RAISE EXCEPTION 'Invalid refund amount or currency';

    END IF;

    PERFORM public.neo_customer_advance_deposit_position(
        r.branch_id,r.customer_id
    );

    SELECT *
    INTO original_payment

    FROM public.payments

    WHERE id = d.payment_id
      AND organization_id = org
      AND branch_id = r.branch_id
      AND customer_id = r.customer_id

    FOR UPDATE;

    IF original_payment.id IS NULL

       OR original_payment.status <> 'confirmed'

       OR original_payment.method <> 'cash'

       OR original_payment.currency
          IS DISTINCT FROM r.currency

       OR original_payment.amount
          IS DISTINCT FROM d.original_amount

    THEN

        RAISE EXCEPTION
          'Original cash deposit could not be verified';

    END IF;

    SELECT coalesce(sum(m.amount),0)
    INTO v_used

    FROM public.neo_customer_deposit_movements m

    WHERE m.deposit_id = d.id
      AND m.organization_id = org;

    SELECT coalesce(sum(f.amount),0)
    INTO v_reserved

    FROM public.neo_customer_deposit_refund_requests f

    WHERE f.deposit_id = d.id
      AND f.organization_id = org
      AND f.id <> r.id

      AND f.status IN (
          'pending-approval','approved'
      );

    IF r.amount >
       d.original_amount-v_used-v_reserved
    THEN

        RAISE EXCEPTION
          'Refund exceeds remaining available liability';

    END IF;

    IF _account IS NULL THEN

        RAISE EXCEPTION 'Cash settlement account required';

    END IF;

    PERFORM public.neo_assert_financial_account(
        org,r.branch_id,_account
    );

    v_cash_code :=
        public.neo_gl_settlement_code_for(
            org,'cash'
        );

    SELECT a.code
    INTO v_account_code
    FROM public.bank_accounts b
    JOIN public.chart_of_accounts a
      ON a.id = b.gl_account_id
     AND a.organization_id = b.organization_id
    WHERE b.id = _account
      AND b.organization_id = org
      AND (
          b.branch_id IS NULL
          OR b.branch_id = r.branch_id
      )
      AND b.active IS TRUE
      AND a.active IS TRUE
      AND a.postable IS TRUE
      AND coalesce(a.is_header,false) IS FALSE
      AND a.category = 'asset'
    FOR SHARE OF b,a;

    IF v_account_code IS NULL

       OR v_account_code
          IS DISTINCT FROM v_cash_code

    THEN

        RAISE EXCEPTION
          'Refund requires an authorised cash account';

    END IF;

    -- Use the existing cashier shift register.

    SELECT s.id

    INTO v_shift

    FROM public.pos_shifts s

    WHERE s.organization_id = org

      AND s.branch_id = r.branch_id

      AND s.cashier_id = actor

      AND s.status = 'open'

    ORDER BY s.id

    LIMIT 1

    FOR UPDATE;

    IF v_shift IS NULL THEN

        RAISE EXCEPTION
          'An open cashier shift is required';

    END IF;

    v_expected_cash :=
        public.cash_shift_expected(v_shift);

    IF v_expected_cash IS NULL

       OR v_expected_cash::text IN (
           'NaN','Infinity','-Infinity'
       )

       OR v_expected_cash < r.amount

    THEN

        RAISE EXCEPTION
          'Insufficient confirmed cashier cash balance';

    END IF;

    PERFORM public.neo_finance_ensure_account(
        org,
        '2030',
        'Customer advance deposits',
        'liability',
        'current_liabilities'
    );

    v_payment := gen_random_uuid();

    v_receipt := public.next_document_number('receipt');

    -- Liability reduction, not sales reversal.

    v_posting := public.neo_gl_post(

        org,

        r.branch_id,

        'finance',

        'customer_deposit_refund',

        r.id,

        'settlement',

        public.neo_local_today(r.branch_id),

        r.currency,

        'Approved customer deposit refund ' ||
            r.id::text,

        jsonb_build_array(

            jsonb_build_object(
                'code','2030',
                'debit',r.amount,
                'credit',0,
                'description','Reduce customer advance liability'
            ),

            jsonb_build_object(
                'code',v_cash_code,
                'debit',0,
                'credit',r.amount,
                'description','Cash refund to customer'
            )

        ),

        r.customer_id

    );

    v_journal :=
        nullif(
            v_posting->>'journal_id',''
        )::uuid;

    IF v_journal IS NULL
       OR (v_posting->>'ok')::boolean IS NOT TRUE
    THEN

        RAISE EXCEPTION
          'Refund journal posting could not be confirmed';

    END IF;

    IF NOT EXISTS (

        SELECT 1

        FROM public.journal_entries j

        WHERE j.id = v_journal

          AND j.organization_id = org

          AND j.branch_id = r.branch_id

          AND j.source_document_id = r.id

          AND j.source_document_type =
              'customer_deposit_refund:settlement'

          AND j.currency = r.currency

          AND j.status = 'posted'

          AND j.reversed_by_journal_id IS NULL

          AND j.total_debit = r.amount

          AND j.total_credit = r.amount

    ) THEN

        RAISE EXCEPTION
          'Refund accounting evidence could not be confirmed';

    END IF;

    INSERT INTO public.payments (

        id,

        organization_id,

        branch_id,

        customer_id,

        receipt_number,

        amount,

        currency,

        method,

        status,

        received_by,

        paid_at,

        destination_account_id,

        shift_id,

        source_module,

        source_record_id,

        idempotency_key,

        posted_journal_id

    )
    VALUES (

        v_payment,

        org,

        r.branch_id,

        r.customer_id,

        v_receipt,

        -r.amount,

        r.currency,

        'cash',

        'confirmed',

        actor,

        now(),

        _account,

        v_shift,

        'customer_deposit_refund',

        r.id,

        'customer-deposit-refund:' || r.id::text,

        v_journal

    );


    v_cash_after_payment :=
        public.cash_shift_expected(v_shift);

    IF v_cash_after_payment IS NULL
       OR v_cash_after_payment::text IN (
           'NaN','Infinity','-Infinity'
       )
    THEN
        RAISE EXCEPTION
          'Cashier balance could not be reconciled';
    END IF;

    IF v_cash_after_payment = v_expected_cash THEN

        -- The negative payment is not independently
        -- reducing expected till cash. Record the
        -- canonical refund cash movement.

    INSERT INTO public.cash_movements (
        organization_id,
        shift_id,
        movement_type,
        amount,
        reason,
        reference,
        created_by
    )
    VALUES (
        org,
        v_shift,
        'refund',
        r.amount,
        'Customer deposit refund: ' || r.reason,
        v_receipt,
        actor
    );

    ELSIF v_cash_after_payment <>
          v_expected_cash-r.amount
    THEN

        RAISE EXCEPTION
          'Unexpected cashier cash effect from refund payment';

    END IF;

    v_cash_after_refund :=
        public.cash_shift_expected(v_shift);

    IF v_cash_after_refund IS DISTINCT FROM
       v_expected_cash-r.amount
    THEN

        RAISE EXCEPTION
          'Refund must reduce cashier cash exactly once';

    END IF;

    UPDATE public.neo_customer_deposit_refund_requests

    SET status = 'settled',

        settled_by = actor,

        settled_at = now(),

        refund_payment_id = v_payment,

        refund_journal_id = v_journal

    WHERE id = r.id;

    INSERT INTO public.neo_customer_deposit_movements (

        organization_id,

        branch_id,

        deposit_id,

        movement_type,

        source_record_id,

        journal_id,

        amount,

        performed_by,

        intent_key

    )
    VALUES (

        org,

        r.branch_id,

        d.id,

        'refund',

        r.id,

        v_journal,

        r.amount,

        actor,

        'refund-settlement:' || r.id::text

    )
    RETURNING id INTO v_movement;

    PERFORM public.neo_customer_advance_deposit_position(
        r.branch_id,r.customer_id
    );

    RETURN jsonb_build_object(

        'ok',true,

        'refund_id',r.id,

        'status','settled',

        'payment_id',v_payment,

        'receipt_number',v_receipt,

        'journal_id',v_journal,

        'movement_id',v_movement,

        'amount',r.amount,

        'currency',r.currency,

        'shift_id',v_shift,

        'already_settled',false

    );

END;

$function$;

REVOKE ALL ON FUNCTION
public.neo_customer_deposit_refund_settle(uuid,uuid)
FROM PUBLIC,anon,authenticated;

NOTIFY pgrst,'reload schema';


CREATE UNIQUE INDEX IF NOT EXISTS
neo_customer_deposit_refund_movement_unique

ON public.neo_customer_deposit_movements (
    organization_id,
    source_record_id
)

WHERE movement_type = 'refund';

NOTIFY pgrst,'reload schema';


CREATE OR REPLACE FUNCTION
public.neo_customer_deposit_refund_context(
    _branch uuid,
    _customer uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog,public
AS $function$

DECLARE

    org uuid := public.current_org_id();

    actor uuid := auth.uid();

    may_request boolean;

    may_decide boolean;

    may_settle boolean;

    v_history jsonb;

BEGIN

    v_history :=
        public.neo_customer_deposit_refund_history(
            _branch,_customer
        );

    may_request := coalesce(
        public.has_permission(
            'finance','ar.allocate_receipt'
        )
        OR public.is_org_admin(),
        false
    );

    may_decide := coalesce(
        public.has_permission(
            'finance','payment.approve'
        )
        OR public.has_permission(
            'finance','approve'
        )
        OR public.is_org_admin(),
        false
    );

    may_settle := coalesce(
        public.has_permission(
            'finance','payments','refund_payment'
        )
        OR public.is_org_admin(),
        false
    );

    RETURN jsonb_build_object(

        'customer_id',_customer,

        'branch_id',_branch,

        'history',v_history,

        'request_enabled',
            may_request AND has_function_privilege(
                'authenticated',
                'public.neo_customer_deposit_refund_request(uuid,uuid,uuid,numeric,text,text)',
                'EXECUTE'
            ),

        'decision_enabled',
            may_decide AND has_function_privilege(
                'authenticated',
                'public.neo_customer_deposit_refund_decide(uuid,boolean,text)',
                'EXECUTE'
            ),

        'settlement_enabled',
            may_settle AND has_function_privilege(
                'authenticated',
                'public.neo_customer_deposit_refund_settle(uuid,uuid)',
                'EXECUTE'
            ),

        'accounts',coalesce((

            SELECT jsonb_agg(
                jsonb_build_object(
                    'id',b.id,
                    'name',b.name
                )
                ORDER BY b.name,b.id
            )

            FROM public.bank_accounts b

            JOIN public.chart_of_accounts a
              ON a.id = b.gl_account_id
              AND a.organization_id = org

            WHERE b.organization_id = org

              AND (
                  b.branch_id IS NULL
                  OR b.branch_id = _branch
              )

              AND b.active IS TRUE

              AND a.active IS TRUE

              AND a.postable IS TRUE

              AND NOT coalesce(a.is_header,false)

              AND a.code =
                  public.neo_gl_settlement_code_for(
                      org,'cash'
                  )

              AND may_settle

        ),'[]'::jsonb),

        'deposits',coalesce((

            SELECT jsonb_agg(
                to_jsonb(x)
                ORDER BY x.received_at DESC,x.id
            )

            FROM (

                SELECT

                    d.id,

                    p.receipt_number,

                    d.currency,

                    d.received_at,

                    d.original_amount,

                    d.original_amount -

                    coalesce((

                        SELECT sum(m.amount)

                        FROM public.neo_customer_deposit_movements m

                        WHERE m.deposit_id = d.id
                          AND m.organization_id = org

                    ),0) AS unspent_amount,

                    coalesce((

                        SELECT sum(r.amount)

                        FROM public.neo_customer_deposit_refund_requests r

                        WHERE r.deposit_id = d.id

                          AND r.organization_id = org

                          AND r.status IN (
                              'pending-approval',
                              'approved'
                          )

                    ),0) AS reserved_amount

                FROM public.neo_customer_advance_deposits d

                JOIN public.payments p
                  ON p.id = d.payment_id
                  AND p.organization_id = org
                  AND p.branch_id = _branch
                  AND p.customer_id = _customer
                  AND p.status = 'confirmed'
                  AND p.amount = d.original_amount
                  AND p.currency = d.currency
                  AND p.posted_journal_id = d.journal_id

                JOIN public.journal_entries j
                  ON j.id = d.journal_id
                  AND j.organization_id = org
                  AND j.branch_id = _branch
                  AND j.currency = d.currency
                  AND j.status = 'posted'
                  AND j.reversed_by_journal_id IS NULL
                  AND j.total_debit = d.original_amount
                  AND j.total_credit = d.original_amount

                WHERE d.organization_id = org

                  AND d.branch_id = _branch

                  AND d.customer_id = _customer

                  AND may_request

            ) x

        ),'[]'::jsonb)

    );

END;

$function$;

REVOKE ALL ON FUNCTION
public.neo_customer_deposit_refund_context(uuid,uuid)
FROM PUBLIC,anon;

GRANT EXECUTE ON FUNCTION
public.neo_customer_deposit_refund_context(uuid,uuid)
TO authenticated;

NOTIFY pgrst,'reload schema';

COMMIT;

-- NEO_COLLECTION_PROPERTY_INTEGRITY_V1
-- Preserve existing payment and refund execution infrastructure.
-- Do not grant new financial permissions or modify existing balances.

DO $folio_scope$
DECLARE
    d text;
    anchor text;
BEGIN

    d := pg_get_functiondef(
        'public.neo_pms_collection_headroom(uuid,uuid,uuid)'
        ::regprocedure
    );

    IF strpos(d,'neo_folio_collection_property_scope_v1')>0 THEN
        RETURN;
    END IF;

    anchor :=
      'IF source.reservation_id IS NOT NULL THEN';

    IF strpos(d,anchor)=0 THEN
        RAISE EXCEPTION
          'Canonical folio collection boundary differs';
    END IF;

    d := replace(
        d,
        anchor,
        $guard$

 -- neo_folio_collection_property_scope_v1

 IF auth.uid() IS NULL
    OR public.current_org_id() IS NULL
    OR public.neo_branch_in_scope(source.branch_id) IS NOT TRUE
 THEN
     RAISE EXCEPTION
       'Folio is outside the authorized collection scope'
       USING ERRCODE='42501';
 END IF;

$guard$ || anchor
    );

    EXECUTE d;

END;
$folio_scope$;


-- Preserve current collection permission classes.
-- Require an authenticated organization context.

CREATE OR REPLACE FUNCTION public.neo_pos_can_take_payment()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO public,pg_temp
AS $function$

 SELECT auth.uid() IS NOT NULL

    AND public.current_org_id() IS NOT NULL

    AND (

        public.has_permission(
            'pos','payments','process'
        ) IS TRUE

        OR public.has_permission(
            'finance','collections','collect_payment'
        ) IS TRUE

        OR public.has_permission(
            'finance','collections','settle_bill'
        ) IS TRUE

        OR public.has_permission(
            'finance','collections','issue_receipt'
        ) IS TRUE

        OR public.has_permission(
            'finance','payments','create'
        ) IS TRUE

        OR public.has_permission(
            'finance','till','confirm_cash'
        ) IS TRUE

    );

$function$;


-- Guard the existing external refund settlement entry point.
-- The underlying refund engine retains responsibility
-- for settlement authorization and journal posting.

DO $refund_scope$
DECLARE
    d text;
    anchor text;
BEGIN

    d := pg_get_functiondef(
        'public.neo_pos_refund_settle(uuid,text,uuid,boolean)'
        ::regprocedure
    );

    IF strpos(d,'neo_external_refund_property_scope_v1')>0 THEN
        RETURN;
    END IF;

    anchor :=
      'p:=public.neo_refund_receipt_lock(r.payment_id);';

    IF strpos(d,anchor)=0 THEN
        RAISE EXCEPTION
          'Canonical external refund boundary differs';
    END IF;

    d := replace(
        d,
        anchor,
        $guard$

 -- neo_external_refund_property_scope_v1

 IF auth.uid() IS NULL
    OR org IS NULL
    OR NOT EXISTS (

        SELECT 1

        FROM public.pos_payments payment

        JOIN public.pos_orders orders
          ON orders.id = payment.order_id
         AND orders.organization_id =
             payment.organization_id

        WHERE payment.id = r.payment_id
          AND payment.organization_id = org

          AND public.neo_branch_in_scope(
              orders.branch_id
          ) IS TRUE

    )
 THEN
     RAISE EXCEPTION
       'Refund is outside the authorized property'
       USING ERRCODE='42501';
 END IF;

 IF nullif(btrim(coalesce(_reference,'')),'') IS NULL
 THEN
     RAISE EXCEPTION
       'A completed external refund reference is required'
       USING ERRCODE='22023';
 END IF;

$guard$ || anchor
    );

    EXECUTE d;

END;
$refund_scope$;


-- NEO_INTEGRATED_COLLECTION_EXECUTION_V1
-- Preserve current financial permissions, original receipt
-- ownership and existing operational balances.

DO $cash_collection_authority$
DECLARE
    d text;
    anchor text;
BEGIN

    d := pg_get_functiondef(
        'public.neo_cash_request_pos_payment(uuid,numeric,text,text,text,numeric)'
        ::regprocedure
    );

    IF strpos(d,'neo_cash_collection_authority_v1')>0 THEN
        RETURN;
    END IF;

    anchor :=
      'OR public.is_org_admin()) THEN';

    IF strpos(d,anchor)=0 THEN
        RAISE EXCEPTION
          'Canonical cash collection permission boundary differs';
    END IF;

    d := replace(
        d,
        anchor,
        $replacement$

          OR public.neo_pos_can_take_payment() IS TRUE
          OR public.is_org_admin()) THEN

$replacement$
    );

    anchor := '  IF _amount IS NULL OR _amount <= 0 THEN';

    IF strpos(d,anchor)=0 THEN
        RAISE EXCEPTION
          'Canonical cash amount boundary differs';
    END IF;

    d := replace(
        d,
        anchor,
        $guard$

  -- neo_cash_collection_authority_v1

  IF auth.uid() IS NULL OR _org IS NULL THEN
      RAISE EXCEPTION
        'An authenticated collection operator is required'
        USING ERRCODE='42501';
  END IF;

$guard$ || anchor
    );

    EXECUTE d;

END;
$cash_collection_authority$;


-- Legacy cash requests must use the canonical six-argument
-- workflow, including tender and stable transaction identity.

CREATE OR REPLACE FUNCTION public.neo_cash_request_pos_payment(
    _order uuid,
    _amount numeric,
    _reference text DEFAULT NULL,
    _notes text DEFAULT '',
    _idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public,pg_temp
AS $function$
BEGIN

    IF nullif(btrim(coalesce(_idempotency_key,'')),'') IS NULL THEN
        RAISE EXCEPTION
          'A stable cash collection identity is required'
          USING ERRCODE='22023';
    END IF;

    RETURN public.neo_cash_request_pos_payment(
        _order,
        _amount,
        _reference,
        _notes,
        _idempotency_key,
        _amount
    );

END;
$function$;


-- Protect reservation-level collection calculations.

DO $reservation_collection_scope$
DECLARE
    d text;
    anchor text;
BEGIN

    d := pg_get_functiondef(
        'public.neo_reservation_collection_facts(uuid,uuid,uuid)'
        ::regprocedure
    );

    IF strpos(d,'neo_reservation_collection_scope_v1')>0 THEN
        RETURN;
    END IF;

    anchor :=
      'cur:=public.neo_fact_currency(booking.organization_id,booking.branch_id);';

    IF strpos(d,anchor)=0 THEN
        RAISE EXCEPTION
          'Reservation collection currency boundary differs';
    END IF;

    d := replace(
        d,
        anchor,
        $guard$

 -- neo_reservation_collection_scope_v1

 IF public.neo_branch_in_scope(booking.branch_id) IS NOT TRUE THEN
     RAISE EXCEPTION
       'Reservation is outside the authorized property'
       USING ERRCODE='42501';
 END IF;

$guard$ || anchor
    );

    EXECUTE d;

END;
$reservation_collection_scope$;


-- Strengthen the existing accommodation charge command.
-- Do not change the underlying room-rate calculation.

DO $room_charge_integrity$
DECLARE
    d text;
    anchor text;
BEGIN

    d := pg_get_functiondef(
        'public.pms_post_room_charge(uuid,text,text,numeric,numeric,numeric,text,text,text)'
        ::regprocedure
    );

    IF strpos(d,'neo_room_charge_integrity_v1')>0 THEN
        RETURN;
    END IF;

    anchor :=
      '  IF _f.status <> ''open'' THEN';

    IF strpos(d,anchor)=0 THEN
        RAISE EXCEPTION
          'Legacy room-charge lifecycle boundary differs';
    END IF;

    d := replace(
        d,
        anchor,
        $guard$

  -- neo_room_charge_integrity_v1

  IF auth.uid() IS NULL
     OR _org IS NULL
     OR public.neo_branch_in_scope(_f.branch_id) IS NOT TRUE
  THEN
      RAISE EXCEPTION
        'Room charge is outside the authorized property'
        USING ERRCODE='42501';
  END IF;

  IF _quantity IS NULL
     OR _quantity <= 0
     OR _quantity::text IN ('NaN','Infinity','-Infinity')
     OR _unit_price IS NULL
     OR _unit_price < 0
     OR _unit_price::text IN ('NaN','Infinity','-Infinity')
     OR coalesce(_tax,0) < 0
     OR coalesce(_tax,0)::text IN ('NaN','Infinity','-Infinity')
  THEN
      RAISE EXCEPTION
        'Room charge quantities and amounts must be valid'
        USING ERRCODE='22023';
  END IF;

  IF nullif(btrim(coalesce(_description,'')),'') IS NULL
     OR nullif(btrim(coalesce(_category,'')),'') IS NULL
     OR nullif(btrim(coalesce(_idempotency_key,'')),'') IS NULL
  THEN
      RAISE EXCEPTION
        'Room charge description, category and identity are required'
        USING ERRCODE='22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
      hashtextextended(
          _org::text || ':folio-charge:' || _idempotency_key,
          0
      )
  );

$guard$ || anchor
    );

    anchor := '  IF _id IS NOT NULL THEN RETURN _id; END IF;';

    IF strpos(d,anchor)=0 THEN
        RAISE EXCEPTION
          'Room charge replay boundary differs';
    END IF;

    d := replace(
        d,
        anchor,
        $replacement$

  IF _id IS NOT NULL THEN

      IF NOT EXISTS (

          SELECT 1
          FROM public.folio_lines l

          WHERE l.id = _id
            AND l.organization_id = _org
            AND l.branch_id = _f.branch_id
            AND l.folio_id = _folio
            AND l.line_type = 'charge'
            AND l.category IS NOT DISTINCT FROM _category
            AND l.source_module IS NOT DISTINCT FROM _source_module
            AND l.source_record_id IS NOT DISTINCT FROM _source_record_id
            AND l.quantity IS NOT DISTINCT FROM _quantity
            AND l.unit_price IS NOT DISTINCT FROM _unit_price
            AND l.tax_amount IS NOT DISTINCT FROM coalesce(_tax,0)
            AND l.net_amount IS NOT DISTINCT FROM
                round(_quantity * _unit_price,2) + coalesce(_tax,0)

            AND coalesce(l.status,'posted') NOT IN (
                'void','voided','cancelled','reversed'
            )
      ) THEN

          RAISE EXCEPTION
            'Saved room charge differs from this transaction'
            USING ERRCODE='23514';

      END IF;

      RETURN _id;

  END IF;

$replacement$
    );

    EXECUTE d;

END;
$room_charge_integrity$;


-- Protect property-specific business-day closure.

DO $business_day_scope$
DECLARE
    d text;
    anchor text;
BEGIN

    d := pg_get_functiondef(
        'public.neo_close_business_day(uuid,date,text)'
        ::regprocedure
    );

    IF strpos(d,'neo_business_day_scope_v1')>0 THEN
        RETURN;
    END IF;

    anchor :=
      ' IF EXISTS(SELECT 1 FROM public.business_days';

    IF strpos(d,anchor)=0 THEN
        RAISE EXCEPTION
          'Business-day closure boundary differs';
    END IF;

    d := replace(
        d,
        anchor,
        $guard$

 -- neo_business_day_scope_v1

 IF auth.uid() IS NULL
    OR _branch IS NULL
    OR public.neo_branch_in_scope(_branch) IS NOT TRUE
    OR NOT EXISTS (
        SELECT 1 FROM public.branches b
        WHERE b.id = _branch
          AND b.organization_id = org
    )
 THEN
     RAISE EXCEPTION
       'Business-day closure is outside the authorized property'
       USING ERRCODE='42501';
 END IF;

$guard$ || anchor
    );

    EXECUTE d;

END;
$business_day_scope$;
