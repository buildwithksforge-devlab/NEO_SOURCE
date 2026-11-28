BEGIN;


CREATE OR REPLACE FUNCTION
public.neo_bill_reopening_cash_refund_valid(
    _payment uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog,public

AS $function$

DECLARE

    org uuid := public.current_org_id();

    p public.payments;

    r public.cash_refund_requests;

    j public.journal_entries;

    original_amount numeric;

    refund_count bigint;

    settled_amount numeric;

BEGIN

    IF org IS NULL
       OR auth.uid() IS NULL
       OR public.current_access_scope() IS NULL
       OR public.current_access_scope() = 'technical'
       OR _payment IS NULL
    THEN
        RETURN false;
    END IF;

    SELECT *
    INTO p
    FROM public.payments
    WHERE id = _payment
      AND organization_id = org;

    IF NOT FOUND
       OR p.branch_id IS NULL
       OR public.neo_branch_in_scope(p.branch_id) IS NOT TRUE
       OR p.status IS DISTINCT FROM 'confirmed'
       OR p.method IS DISTINCT FROM 'cash'
       OR p.source_module IS DISTINCT FROM 'cash_refund'
       OR p.amount IS NULL
       OR p.amount >= 0
       OR p.amount::text IN ('NaN','Infinity','-Infinity')
       OR p.amount <> round(p.amount,2)
       OR nullif(btrim(p.currency),'') IS NULL
       OR nullif(btrim(p.receipt_number),'') IS NULL
       OR p.posted_journal_id IS NULL
       OR p.shift_id IS NULL
    THEN
        RETURN false;
    END IF;

    SELECT count(*)
    INTO refund_count
    FROM public.cash_refund_requests
    WHERE refund_payment_id = p.id;

    IF refund_count <> 1 THEN
        RETURN false;
    END IF;

    SELECT *
    INTO r
    FROM public.cash_refund_requests
    WHERE refund_payment_id = p.id
      AND organization_id = org
      AND branch_id = p.branch_id;

    IF NOT FOUND
       OR r.status IS DISTINCT FROM 'settled'
       OR r.amount IS DISTINCT FROM -p.amount
       OR r.currency IS DISTINCT FROM p.currency
       OR r.id IS DISTINCT FROM p.source_record_id
       OR r.settled_by IS NULL
       OR r.settled_at IS NULL
       OR r.settled_by IS DISTINCT FROM p.received_by
       OR r.shift_id IS DISTINCT FROM p.shift_id
       OR r.refund_receipt_number IS DISTINCT FROM p.receipt_number
       OR p.folio_id IS DISTINCT FROM r.folio_id
       OR nullif(btrim(r.original_receipt_number),'') IS NULL
       OR p.external_reference IS DISTINCT FROM r.original_receipt_number
       OR (
           r.payment_id IS NULL
           AND r.pos_payment_id IS NULL
       )
       OR (
           r.payment_id IS NOT NULL
           AND r.pos_payment_id IS NOT NULL
       )
    THEN
        RETURN false;
    END IF;

    IF r.pos_payment_id IS NOT NULL THEN

        SELECT x.amount
        INTO original_amount
        FROM public.pos_payments x
        WHERE x.id = r.pos_payment_id
          AND x.organization_id = org
          AND x.branch_id = p.branch_id
          AND x.currency = p.currency
          AND x.method = 'cash'
          AND x.status IN ('confirmed','refunded')
          AND x.receipt_number = r.original_receipt_number;

        SELECT coalesce(sum(x.amount),0)
        INTO settled_amount
        FROM public.cash_refund_requests x
        WHERE x.organization_id = org
          AND x.pos_payment_id = r.pos_payment_id
          AND x.status = 'settled';

    ELSE

        SELECT x.amount
        INTO original_amount
        FROM public.payments x
        WHERE x.id = r.payment_id
          AND x.id <> p.id
          AND x.organization_id = org
          AND x.branch_id = p.branch_id
          AND x.currency = p.currency
          AND x.method = 'cash'
          AND x.status IN ('confirmed','refunded')
          AND x.receipt_number = r.original_receipt_number
          AND x.folio_id IS NOT DISTINCT FROM r.folio_id;

        SELECT coalesce(sum(x.amount),0)
        INTO settled_amount
        FROM public.cash_refund_requests x
        WHERE x.organization_id = org
          AND x.payment_id = r.payment_id
          AND x.status = 'settled';

    END IF;

    IF original_amount IS NULL
       OR original_amount <= 0
       OR original_amount::text IN ('NaN','Infinity','-Infinity')
       OR settled_amount::text IN ('NaN','Infinity','-Infinity')
       OR settled_amount < r.amount
       OR settled_amount > original_amount
       OR r.amount > original_amount
    THEN
        RETURN false;
    END IF;

    SELECT *
    INTO j
    FROM public.journal_entries
    WHERE id = p.posted_journal_id
      AND organization_id = org
      AND branch_id = p.branch_id;

    IF NOT FOUND
       OR j.status IS DISTINCT FROM 'posted'
       OR j.currency IS DISTINCT FROM p.currency
       OR j.reversed_by_journal_id IS NOT NULL
       OR j.total_debit IS DISTINCT FROM r.amount
       OR j.total_credit IS DISTINCT FROM r.amount
       OR j.source_document_id IS NULL
       OR j.source_document_id NOT IN (r.id,p.id)
    THEN
        RETURN false;
    END IF;

    IF EXISTS (

        SELECT 1
        FROM public.journal_entry_lines l
        WHERE l.journal_id = j.id
          AND (
              l.organization_id IS DISTINCT FROM org
              OR l.branch_id IS DISTINCT FROM p.branch_id
              OR l.debit IS NULL
              OR l.credit IS NULL
              OR l.debit < 0
              OR l.credit < 0
              OR l.debit::text IN ('NaN','Infinity','-Infinity')
              OR l.credit::text IN ('NaN','Infinity','-Infinity')
          )

    ) THEN
        RETURN false;
    END IF;

    IF NOT EXISTS (

        SELECT 1
        FROM public.journal_entry_lines l
        WHERE l.journal_id = j.id
        GROUP BY l.journal_id
        HAVING sum(l.debit) = r.amount
           AND sum(l.credit) = r.amount

    ) THEN
        RETURN false;
    END IF;

    RETURN true;

END;

$function$;

REVOKE ALL ON FUNCTION
public.neo_bill_reopening_cash_refund_valid(uuid)
FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION
public.neo_pos_bill_reopening_financial_evidence(
    _order uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog,public
AS $function$
DECLARE

    org uuid := public.current_org_id();

    actor uuid := auth.uid();

    o public.pos_orders;

    order_data jsonb;

    payment_count bigint;

    payment_total numeric;

    pending_refunds bigint;

    settled_refunds bigint;

    invalid_refunds bigint;

BEGIN

    IF actor IS NULL

       OR org IS NULL

       OR public.current_access_scope() IS NULL

       OR public.current_access_scope() = 'technical'

    THEN

        RAISE EXCEPTION
            'Authorized workspace access required'
            USING ERRCODE = '42501';

    END IF;

    SELECT *
    INTO o

    FROM public.pos_orders

    WHERE id = _order

      AND organization_id = org

    FOR UPDATE;

    IF NOT FOUND

       OR o.branch_id IS NULL

       OR public.neo_branch_in_scope(
           o.branch_id
       ) IS NOT TRUE

    THEN

        RAISE EXCEPTION
            'POS order outside authorized property'
            USING ERRCODE = '42501';

    END IF;

    order_data := to_jsonb(o);

    SELECT

        count(*),

        coalesce(sum(p.amount),0)

    INTO

        payment_count,

        payment_total

    FROM public.payments p

    WHERE p.organization_id = org

      AND p.source_module = 'pos'

      AND p.source_record_id = o.id;

    IF payment_total::text IN (
        'NaN','Infinity','-Infinity'
    ) THEN

        RAISE EXCEPTION
            'Invalid payment evidence requires reconciliation';

    END IF;

    SELECT

        count(*) FILTER (
            WHERE r.status IN (
                'pending_approval',
                'approved'
            )
        ),

        count(*) FILTER (
            WHERE r.status = 'settled'
        ),

        count(*) FILTER (

            WHERE r.status = 'settled'

            AND public.neo_bill_reopening_cash_refund_valid(
                r.refund_payment_id
            ) IS NOT TRUE

        )

    INTO

        pending_refunds,

        settled_refunds,

        invalid_refunds

    FROM public.cash_refund_requests r

    JOIN public.payments p

      ON p.id = r.payment_id

     AND p.organization_id = r.organization_id

    WHERE r.organization_id = org

      AND p.source_module = 'pos'

      AND p.source_record_id = o.id;

    RETURN jsonb_build_object(

        'order_id',o.id,

        'organization_id',org,

        'branch_id',o.branch_id,

        'order_status',order_data->>'status',

        'payment_status',order_data->>'payment_status',

        'payment_record_count',payment_count,

        'recorded_payment_amount',payment_total,

        'pending_refund_count',pending_refunds,

        'settled_refund_count',settled_refunds,

        'invalid_refund_count',invalid_refunds,

        'requires_financial_review',

            payment_count > 0

            OR pending_refunds > 0

            OR settled_refunds > 0

            OR invalid_refunds > 0,

        'direct_reopen_eligible',

            payment_count = 0

            AND pending_refunds = 0

            AND settled_refunds = 0

            AND invalid_refunds = 0

            AND order_data->>'payment_status' = 'unpaid'

    );

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_pos_bill_reopening_financial_evidence(uuid)
FROM PUBLIC,anon,authenticated;


CREATE OR REPLACE FUNCTION
public.neo_pos_assert_bill_reopening_financial_integrity(
    _order uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog,public
AS $function$
DECLARE

    evidence jsonb;

BEGIN

    evidence :=
        public.neo_pos_bill_reopening_financial_evidence(
            _order
        );

    IF coalesce(
        (evidence->>'invalid_refund_count')::bigint,
        0
    ) > 0 THEN

        RAISE EXCEPTION
            'Existing refund evidence requires reconciliation';

    END IF;

    IF coalesce(
        (evidence->>'pending_refund_count')::bigint,
        0
    ) > 0 THEN

        RAISE EXCEPTION
            'Outstanding refund requests must be resolved before reopening';

    END IF;

    IF (
        evidence->>'direct_reopen_eligible'
    )::boolean IS NOT TRUE THEN

        RAISE EXCEPTION
            'Bill requires controlled financial reopening and settlement reconciliation';

    END IF;

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_pos_assert_bill_reopening_financial_integrity(uuid)
FROM PUBLIC,anon,authenticated;

NOTIFY pgrst,'reload schema';


-- Controlled bill reopening lifecycle.
-- Financial settlement and production records are preserved.

CREATE TABLE IF NOT EXISTS public.neo_pos_bill_reopening_requests (

    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    organization_id uuid NOT NULL,

    branch_id uuid NOT NULL,

    order_id uuid NOT NULL
        REFERENCES public.pos_orders(id)
        ON DELETE RESTRICT,

    reason text NOT NULL
        CHECK (
            length(btrim(reason))
            BETWEEN 10 AND 4000
        ),

    status text NOT NULL DEFAULT 'pending-approval'
        CHECK (
            status IN (
                'pending-approval',
                'approved',
                'rejected',
                'executed'
            )
        ),

    requested_by uuid NOT NULL,

    requested_at timestamptz NOT NULL DEFAULT now(),

    approved_by uuid,

    approved_at timestamptz,

    decision_note text,

    executed_by uuid,

    executed_at timestamptz,

    intent_key text NOT NULL,

    original_order_status text NOT NULL,

    original_payment_status text,

    financial_snapshot jsonb NOT NULL,

    execution_snapshot jsonb,

    UNIQUE (organization_id,intent_key),

    CHECK (
        approved_by IS NULL
        OR approved_by <> requested_by
    ),

    CHECK (
        status = 'pending-approval'
        OR (
            approved_by IS NOT NULL
            AND approved_at IS NOT NULL
            AND decision_note IS NOT NULL
        )
    ),

    CHECK (
        status <> 'executed'
        OR (
            executed_by IS NOT NULL
            AND executed_at IS NOT NULL
            AND execution_snapshot IS NOT NULL
        )
    )

);

ALTER TABLE public.neo_pos_bill_reopening_requests
ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON
public.neo_pos_bill_reopening_requests
FROM PUBLIC,anon,authenticated;

CREATE UNIQUE INDEX IF NOT EXISTS
neo_pos_bill_reopening_active_request

ON public.neo_pos_bill_reopening_requests (
    organization_id,
    order_id
)

WHERE status IN (
    'pending-approval',
    'approved'
);


-- Request controlled reopening.

CREATE OR REPLACE FUNCTION
public.neo_pos_request_bill_reopening(
    _order uuid,
    _reason text,
    _intent_key text
)
RETURNS jsonb

LANGUAGE plpgsql
SECURITY DEFINER

SET search_path TO pg_catalog,public

AS $function$

DECLARE

    org uuid := public.current_org_id();

    actor uuid := auth.uid();

    o public.pos_orders;

    r public.neo_pos_bill_reopening_requests%ROWTYPE;

    evidence jsonb;

    v_reason text := btrim(coalesce(_reason,''));

    v_key text := btrim(coalesce(_intent_key,''));

BEGIN

    IF actor IS NULL

       OR org IS NULL

       OR public.current_access_scope() IS NULL

       OR public.current_access_scope() = 'technical'

       OR NOT coalesce(
           public.has_permission(
               'pos','bill.reopen.request'
           )
           OR public.is_org_admin(),
           false
       )

    THEN

        RAISE EXCEPTION 'Bill reopening request access denied'
          USING ERRCODE='42501';

    END IF;

    IF length(v_reason) NOT BETWEEN 10 AND 4000

       OR length(v_key) NOT BETWEEN 1 AND 200

    THEN

        RAISE EXCEPTION
          'Valid reopening reason and transaction identity required';

    END IF;

    PERFORM pg_advisory_xact_lock(

        hashtextextended(
            org::text ||
            ':bill-reopening:' ||
            v_key,
            0
        )

    );

    SELECT *
    INTO o

    FROM public.pos_orders

    WHERE id = _order

      AND organization_id = org

    FOR UPDATE;

    IF NOT FOUND

       OR o.branch_id IS NULL

       OR public.neo_branch_in_scope(
           o.branch_id
       ) IS NOT TRUE

    THEN

        RAISE EXCEPTION 'Bill outside authorised property'
          USING ERRCODE='42501';

    END IF;

    SELECT *
    INTO r

    FROM public.neo_pos_bill_reopening_requests

    WHERE organization_id = org

      AND intent_key = v_key;

    IF FOUND THEN

        IF r.order_id IS DISTINCT FROM _order

           OR r.branch_id IS DISTINCT FROM o.branch_id

           OR r.requested_by IS DISTINCT FROM actor

           OR r.reason IS DISTINCT FROM v_reason

        THEN

            RAISE EXCEPTION
              'Reopening retry payload mismatch';

        END IF;

        RETURN jsonb_build_object(

            'ok',true,

            'request_id',r.id,

            'order_id',r.order_id,

            'status',r.status,

            'already_requested',true

        );

    END IF;

    IF o.status IS NULL

       OR o.status NOT IN (
           'closed',
           'completed',
           'paid'
       )

    THEN

        RAISE EXCEPTION
          'Only finished bills require controlled reopening';

    END IF;

    evidence :=
        public.neo_pos_bill_reopening_financial_evidence(
            o.id
        );

    IF EXISTS (

        SELECT 1

        FROM public.neo_pos_bill_reopening_requests x

        WHERE x.organization_id = org

          AND x.order_id = o.id

          AND x.status IN (
              'pending-approval',
              'approved'
          )

    ) THEN

        RAISE EXCEPTION
          'An active reopening request already exists';

    END IF;

    INSERT INTO public.neo_pos_bill_reopening_requests (

        organization_id,

        branch_id,

        order_id,

        reason,

        requested_by,

        intent_key,

        original_order_status,

        original_payment_status,

        financial_snapshot

    )
    VALUES (

        org,

        o.branch_id,

        o.id,

        v_reason,

        actor,

        v_key,

        o.status,

        to_jsonb(o)->>'payment_status',

        evidence

    )

    RETURNING * INTO r;

    RETURN jsonb_build_object(

        'ok',true,

        'request_id',r.id,

        'order_id',o.id,

        'status',r.status,

        'requires_financial_review',
            evidence->'requires_financial_review',

        'direct_reopen_eligible',
            evidence->'direct_reopen_eligible',

        'already_requested',false

    );

END;

$function$;


-- Independent approval or rejection.

CREATE OR REPLACE FUNCTION
public.neo_pos_decide_bill_reopening(
    _request uuid,
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

    actor uuid := auth.uid();

    r public.neo_pos_bill_reopening_requests%ROWTYPE;

    o public.pos_orders;

    evidence jsonb;

    v_note text := btrim(coalesce(_note,''));

    v_status text;

BEGIN

    IF actor IS NULL

       OR org IS NULL

       OR public.current_access_scope() IS NULL

       OR public.current_access_scope() = 'technical'

       OR NOT coalesce(
           public.has_permission(
               'pos','bill.reopen.approve'
           )
           OR public.has_permission(
               'finance','approve'
           )
           OR public.is_org_admin(),
           false
       )

    THEN

        RAISE EXCEPTION 'Bill reopening approval access denied'
          USING ERRCODE='42501';

    END IF;

    IF _approve IS NULL

       OR length(v_note) NOT BETWEEN 10 AND 4000

    THEN

        RAISE EXCEPTION
          'Valid reopening decision reason required';

    END IF;

    SELECT *
    INTO r

    FROM public.neo_pos_bill_reopening_requests

    WHERE id = _request

      AND organization_id = org;

    IF NOT FOUND

       OR public.neo_branch_in_scope(
           r.branch_id
       ) IS NOT TRUE

    THEN

        RAISE EXCEPTION 'Reopening request unavailable'
          USING ERRCODE='42501';

    END IF;

    SELECT *
    INTO o

    FROM public.pos_orders

    WHERE id = r.order_id

      AND organization_id = org

      AND branch_id = r.branch_id

    FOR UPDATE;

    IF NOT FOUND THEN

        RAISE EXCEPTION
          'Original bill unavailable';

    END IF;

    SELECT *
    INTO r

    FROM public.neo_pos_bill_reopening_requests

    WHERE id = _request

      AND organization_id = org

    FOR UPDATE;

    IF r.requested_by = actor THEN

        RAISE EXCEPTION
          'Independent bill reopening approval required';

    END IF;

    v_status := CASE
        WHEN _approve THEN 'approved'
        ELSE 'rejected'
    END;

    IF r.status = v_status

       AND r.approved_by = actor

       AND r.decision_note = v_note

    THEN

        RETURN jsonb_build_object(

            'ok',true,

            'request_id',r.id,

            'order_id',r.order_id,

            'status',r.status,

            'already_decided',true

        );

    END IF;

    IF r.status <> 'pending-approval' THEN

        RAISE EXCEPTION
          'Reopening decision already closed';

    END IF;

    IF _approve THEN

        IF o.status IS DISTINCT FROM
           r.original_order_status

           OR (
               to_jsonb(o)->>'payment_status'
           ) IS DISTINCT FROM
               r.original_payment_status

        THEN

            RAISE EXCEPTION
              'Bill changed since reopening was requested';

        END IF;

        evidence :=
            public.neo_pos_bill_reopening_financial_evidence(
                o.id
            );

        IF coalesce(
            (evidence->>'invalid_refund_count')::bigint,
            0
        ) > 0 THEN

            RAISE EXCEPTION
              'Invalid refund evidence requires reconciliation';

        END IF;

        IF coalesce(
            (evidence->>'pending_refund_count')::bigint,
            0
        ) > 0 THEN

            RAISE EXCEPTION
              'Outstanding refunds must be resolved first';

        END IF;

    END IF;

    UPDATE public.neo_pos_bill_reopening_requests

    SET status = v_status,

        approved_by = actor,

        approved_at = now(),

        decision_note = v_note

    WHERE id = r.id;

    RETURN jsonb_build_object(

        'ok',true,

        'request_id',r.id,

        'order_id',r.order_id,

        'status',v_status,

        'bill_reopened',false

    );

END;

$function$;


-- Reopening context for the existing POS terminal.

CREATE OR REPLACE FUNCTION
public.neo_pos_bill_reopening_context(
    _order uuid
)
RETURNS jsonb

LANGUAGE plpgsql
SECURITY DEFINER

SET search_path TO pg_catalog,public

AS $function$

DECLARE

    org uuid := public.current_org_id();

    actor uuid := auth.uid();

    evidence jsonb;

    may_request boolean;

    may_decide boolean;

BEGIN

    IF actor IS NULL

       OR org IS NULL

       OR public.current_access_scope() IS NULL

       OR public.current_access_scope() = 'technical'

       OR NOT coalesce(
           public.has_permission('pos','bill.reopen.request')
           OR public.has_permission('pos','bill.reopen.approve')
           OR public.has_permission('finance','approve')
           OR public.is_org_admin(),
           false
       )

    THEN

        RAISE EXCEPTION 'Bill reopening context access denied'
          USING ERRCODE='42501';

    END IF;

    evidence :=
        public.neo_pos_bill_reopening_financial_evidence(
            _order
        );

    may_request := coalesce(
        public.has_permission('pos','bill.reopen.request')
        OR public.is_org_admin(),
        false
    );

    may_decide := coalesce(
        public.has_permission('pos','bill.reopen.approve')
        OR public.has_permission('finance','approve')
        OR public.is_org_admin(),
        false
    );

    RETURN jsonb_build_object(

        'order_id',_order,

        'financial_evidence',evidence,

        'request_enabled',

            may_request AND has_function_privilege(

                'authenticated',

                'public.neo_pos_request_bill_reopening(uuid,text,text)',

                'EXECUTE'

            ),

        'approval_enabled',

            may_decide AND has_function_privilege(

                'authenticated',

                'public.neo_pos_decide_bill_reopening(uuid,boolean,text)',

                'EXECUTE'

            ),

        'history',coalesce((

            SELECT jsonb_agg(

                jsonb_build_object(

                    'id',r.id,

                    'reason',r.reason,

                    'status',r.status,

                    'requested_at',r.requested_at,

                    'approved_at',r.approved_at,

                    'decision_note',r.decision_note,

                    'executed_at',r.executed_at,

                    'may_decide',

                        may_decide

                        AND r.requested_by <> actor

                        AND r.status = 'pending-approval'

                )

                ORDER BY r.requested_at DESC

            )

            FROM public.neo_pos_bill_reopening_requests r

            WHERE r.organization_id = org

              AND r.order_id = _order

              AND r.branch_id =
                  (evidence->>'branch_id')::uuid

        ),'[]'::jsonb)

    );

END;

$function$;


-- Prevent direct reopening through an ordinary status update.

CREATE OR REPLACE FUNCTION
public.neo_pos_controlled_bill_reopening_guard()
RETURNS trigger

LANGUAGE plpgsql
SECURITY DEFINER

SET search_path TO pg_catalog,public

AS $function$

BEGIN

    IF OLD.status IN (
        'closed',
        'completed',
        'paid'
    )

    AND NEW.status IN (
        'draft',
        'open',
        'awaiting-payment',
        'sent',
        'accepted',
        'preparing',
        'ready',
        'served'
    )

    THEN

        RAISE EXCEPTION
          'Finished bills require the controlled reopening workflow';

    END IF;

    RETURN NEW;

END;

$function$;

REVOKE ALL ON FUNCTION
public.neo_pos_controlled_bill_reopening_guard()
FROM PUBLIC,anon,authenticated;

DROP TRIGGER IF EXISTS
trg_neo_pos_controlled_bill_reopening_guard
ON public.pos_orders;

CREATE TRIGGER
trg_neo_pos_controlled_bill_reopening_guard

BEFORE UPDATE OF status

ON public.pos_orders

FOR EACH ROW

EXECUTE FUNCTION
public.neo_pos_controlled_bill_reopening_guard();


-- Keep financial reopening writes disabled until verified.

REVOKE ALL ON FUNCTION
public.neo_pos_request_bill_reopening(uuid,text,text)
FROM PUBLIC,anon,authenticated;

REVOKE ALL ON FUNCTION
public.neo_pos_decide_bill_reopening(uuid,boolean,text)
FROM PUBLIC,anon,authenticated;

REVOKE ALL ON FUNCTION
public.neo_pos_bill_reopening_context(uuid)
FROM PUBLIC,anon;

GRANT EXECUTE ON FUNCTION
public.neo_pos_bill_reopening_context(uuid)
TO authenticated;

NOTIFY pgrst,'reload schema';


-- Approved reopening of bills without financial settlement.

CREATE OR REPLACE FUNCTION
public.neo_pos_execute_bill_reopening(
    _request uuid
)
RETURNS jsonb

LANGUAGE plpgsql
SECURITY DEFINER

SET search_path TO pg_catalog,public

AS $function$

DECLARE

    org uuid := public.current_org_id();

    actor uuid := auth.uid();

    r public.neo_pos_bill_reopening_requests%ROWTYPE;

    o public.pos_orders;

    evidence jsonb;

    before_items jsonb;

    after_items jsonb;

    before_order jsonb;

    after_order jsonb;

BEGIN

    IF actor IS NULL

       OR org IS NULL

       OR public.current_access_scope() IS NULL

       OR public.current_access_scope() = 'technical'

       OR NOT coalesce(
           public.has_permission(
               'pos','bill.reopen.execute'
           )
           OR public.is_org_admin(),
           false
       )

    THEN

        RAISE EXCEPTION
          'Bill reopening execution access denied'
          USING ERRCODE='42501';

    END IF;

    SELECT *
    INTO r

    FROM public.neo_pos_bill_reopening_requests

    WHERE id = _request
      AND organization_id = org;

    IF NOT FOUND

       OR public.neo_branch_in_scope(
           r.branch_id
       ) IS NOT TRUE

    THEN

        RAISE EXCEPTION
          'Reopening request unavailable'
          USING ERRCODE='42501';

    END IF;

    SELECT *
    INTO o

    FROM public.pos_orders

    WHERE id = r.order_id
      AND organization_id = org
      AND branch_id = r.branch_id

    FOR UPDATE;

    IF NOT FOUND THEN

        RAISE EXCEPTION
          'Original POS order unavailable';

    END IF;

    SELECT *
    INTO r

    FROM public.neo_pos_bill_reopening_requests

    WHERE id = _request
      AND organization_id = org

    FOR UPDATE;

    IF r.status = 'executed' THEN

        IF r.execution_snapshot IS NULL

           OR r.executed_by IS NULL

           OR r.executed_at IS NULL

        THEN

            RAISE EXCEPTION
              'Existing reopening requires reconciliation';

        END IF;

        RETURN jsonb_build_object(

            'ok',true,

            'request_id',r.id,

            'order_id',r.order_id,

            'status','executed',

            'already_executed',true,

            'current_order_status',o.status,

            'requires_reload',true

        );

    END IF;

    IF r.status <> 'approved'

       OR r.approved_by IS NULL

       OR r.approved_at IS NULL

       OR r.approved_by = r.requested_by

    THEN

        RAISE EXCEPTION
          'Independent approved reopening required';

    END IF;

    IF o.status IS DISTINCT FROM
       r.original_order_status

       OR (
           to_jsonb(o)->>'payment_status'
       ) IS DISTINCT FROM
           r.original_payment_status

    THEN

        RAISE EXCEPTION
          'Order changed after reopening was requested';

    END IF;

    -- Existing financial evidence guard.

    PERFORM
        public.neo_pos_assert_bill_reopening_financial_integrity(
            o.id
        );

    evidence :=
        public.neo_pos_bill_reopening_financial_evidence(
            o.id
        );

    -- Reject any POS payment history, including
    -- pending, failed or previously reversed payments.
    -- These require a separate reconciliation pathway.

    IF EXISTS (

        SELECT 1

        FROM public.pos_payments p

        WHERE p.order_id = o.id
          AND p.organization_id = org

    ) THEN

        RAISE EXCEPTION
          'POS payment history requires financial reconciliation';

    END IF;

    IF EXISTS (

        SELECT 1

        FROM public.payments p

        WHERE p.organization_id = org

          AND p.source_record_id = o.id

    ) THEN

        RAISE EXCEPTION
          'Existing payment evidence requires reconciliation';

    END IF;

    IF EXISTS (

        SELECT 1

        FROM public.journal_entries j

        WHERE j.organization_id = org

          AND j.source_document_id = o.id

    ) THEN

        RAISE EXCEPTION
          'Existing order journals require financial reconciliation';

    END IF;


    -- Reject unresolved collection attempts.

    IF EXISTS (

        SELECT 1

        FROM public.cash_payment_requests p

        WHERE p.source_module = 'pos'

          AND p.source_record_id = o.id

          AND (

              p.organization_id IS DISTINCT FROM org

              OR coalesce(p.status,'') NOT IN (
                  'cancelled','rejected','failed','expired'
              )

          )

    ) THEN

        RAISE EXCEPTION
          'Existing cash collection requires reconciliation';

    END IF;

    -- A late M-Pesa callback must not settle
    -- a financially reopened bill unexpectedly.

    IF EXISTS (

        SELECT 1

        FROM public.mpesa_transactions t

        WHERE (

            t.source_module IN ('pos','pos_order')

            AND t.source_record_id = o.id

        )

        AND (

            t.organization_id IS DISTINCT FROM org

            OR coalesce(t.status,'') NOT IN (
                'failed','cancelled','expired'
            )

            OR t.result_code = 0

        )

    ) THEN

        RAISE EXCEPTION
          'Existing M-Pesa transaction requires reconciliation';

    END IF;

    IF EXISTS (

        SELECT 1

        FROM public.pos_refund_requests refund_row

        WHERE refund_row.order_id = o.id

    ) THEN

        RAISE EXCEPTION
          'Existing POS refund activity requires reconciliation';

    END IF;

    -- Detect actual room-charge history even if the
    -- original order header lost its folio reference.

    IF EXISTS (

        SELECT 1

        FROM public.folio_lines f

        WHERE f.source_module = 'pos'

          AND f.source_record_uuid = o.id

    ) THEN

        RAISE EXCEPTION
          'Existing guest folio activity requires reconciliation';

    END IF;

    IF o.paid_total IS DISTINCT FROM 0 THEN

        RAISE EXCEPTION
          'Recorded paid total must be reconciled before reopening';

    END IF;

    before_order := to_jsonb(o);

    -- Prevent reopening an order with linked
    -- guest folio or room-charge evidence.

    IF nullif(
        before_order->>'folio_id',''
    ) IS NOT NULL

       OR nullif(
           before_order->>'room_charge_id',''
       ) IS NOT NULL

       OR nullif(
           before_order->>'settlement_journal_id',''
       ) IS NOT NULL

    THEN

        RAISE EXCEPTION
          'Linked settlement requires financial reconciliation';

    END IF;

    -- Lock existing order items before reopening.

    PERFORM 1

    FROM public.pos_order_items i

    WHERE i.organization_id = org
      AND i.order_id = o.id

    ORDER BY i.id

    FOR UPDATE;

    SELECT coalesce(

        jsonb_agg(
            to_jsonb(i)
            ORDER BY i.id
        ),

        '[]'::jsonb

    )

    INTO before_items

    FROM public.pos_order_items i

    WHERE i.organization_id = org
      AND i.order_id = o.id;

    -- Execution authorization is transaction-local.

    PERFORM set_config(

        'neo.bill_reopening_request',

        r.id::text,

        true

    );

    -- Only reopen the original order header.
    -- Never recreate items or reset production status.

    UPDATE public.pos_orders

    SET status = 'awaiting-payment'

    WHERE id = o.id
      AND organization_id = org
      AND branch_id = r.branch_id
      AND status = r.original_order_status;

    IF NOT FOUND THEN

        RAISE EXCEPTION
          'Original bill could not be reopened';

    END IF;

    PERFORM set_config(

        'neo.bill_reopening_request',

        '',

        true

    );

    SELECT *
    INTO o

    FROM public.pos_orders

    WHERE id = r.order_id
      AND organization_id = org;

    IF NOT FOUND

       OR o.status IS DISTINCT FROM 'awaiting-payment'

       OR (
           to_jsonb(o)->>'payment_status'
       ) IS DISTINCT FROM 'unpaid'

    THEN

        RAISE EXCEPTION
          'Canonical order reopening postcondition failed';

    END IF;

    after_order := to_jsonb(o);

    SELECT coalesce(

        jsonb_agg(
            to_jsonb(i)
            ORDER BY i.id
        ),

        '[]'::jsonb

    )

    INTO after_items

    FROM public.pos_order_items i

    WHERE i.organization_id = org
      AND i.order_id = o.id;

    IF before_items IS DISTINCT FROM after_items THEN

        RAISE EXCEPTION
          'Reopening must not modify existing production items';

    END IF;

    -- Reopening may not change recorded financial totals.

    IF before_order->'grand_total'
       IS DISTINCT FROM after_order->'grand_total'

       OR before_order->'subtotal'
       IS DISTINCT FROM after_order->'subtotal'

       OR before_order->'tax_total'
       IS DISTINCT FROM after_order->'tax_total'

       OR before_order->'discount_total'
       IS DISTINCT FROM after_order->'discount_total'

       OR before_order->'service_charge_total'
       IS DISTINCT FROM after_order->'service_charge_total'

       OR before_order->'paid_total'
       IS DISTINCT FROM after_order->'paid_total'

       OR before_order->'tip_amount'
       IS DISTINCT FROM after_order->'tip_amount'

       OR before_order->'delivery_fee'
       IS DISTINCT FROM after_order->'delivery_fee'

       OR before_order->'currency'
       IS DISTINCT FROM after_order->'currency'

       OR before_order->'payment_status'
       IS DISTINCT FROM after_order->'payment_status'

    THEN

        RAISE EXCEPTION
          'Reopening unexpectedly changed financial totals';

    END IF;

    IF EXISTS (

        SELECT 1

        FROM public.pos_payments p

        WHERE p.organization_id = org
          AND p.order_id = o.id

    )

    OR EXISTS (

        SELECT 1

        FROM public.payments p

        WHERE p.organization_id = org
          AND p.source_record_id = o.id

    )

    OR EXISTS (

        SELECT 1

        FROM public.journal_entries j

        WHERE j.organization_id = org
          AND j.source_document_id = o.id

    )

    THEN

        RAISE EXCEPTION
          'Unexpected financial activity during reopening';

    END IF;

    UPDATE public.neo_pos_bill_reopening_requests

    SET status = 'executed',

        executed_by = actor,

        executed_at = now(),

        execution_snapshot = jsonb_build_object(

            'before_order',before_order,

            'after_order',after_order,

            'financial_evidence',evidence,

            'preserved_item_count',
                jsonb_array_length(before_items),

            'production_items_preserved',true

        )

    WHERE id = r.id;

    RETURN jsonb_build_object(

        'ok',true,

        'request_id',r.id,

        'order_id',o.id,

        'status','executed',

        'order_status',o.status,

        'preserved_item_count',
            jsonb_array_length(before_items),

        'already_executed',false,

        'requires_reload',true

    );

END;

$function$;

REVOKE ALL ON FUNCTION
public.neo_pos_execute_bill_reopening(uuid)
FROM PUBLIC,anon,authenticated;


-- Replace the unconditional reopening guard
-- with an approved transaction-bound guard.

CREATE OR REPLACE FUNCTION
public.neo_pos_controlled_bill_reopening_guard()
RETURNS trigger

LANGUAGE plpgsql
SECURITY DEFINER

SET search_path TO pg_catalog,public

AS $function$

DECLARE

    v_request text;

BEGIN

    IF OLD.status IN (
        'closed',
        'completed',
        'paid'
    )

    AND NEW.status IN (
        'draft',
        'open',
        'awaiting-payment',
        'sent',
        'accepted',
        'preparing',
        'ready',
        'served'
    )

    THEN

        v_request := current_setting(
            'neo.bill_reopening_request',
            true
        );

        IF nullif(v_request,'') IS NULL

           OR NEW.status IS DISTINCT FROM 'awaiting-payment'

           OR OLD.organization_id
              IS DISTINCT FROM NEW.organization_id

           OR OLD.branch_id
              IS DISTINCT FROM NEW.branch_id

           OR OLD.id IS DISTINCT FROM NEW.id

           OR NOT EXISTS (

               SELECT 1

               FROM public.neo_pos_bill_reopening_requests r

               WHERE r.id::text = v_request

                 AND r.organization_id = OLD.organization_id

                 AND r.branch_id = OLD.branch_id

                 AND r.order_id = OLD.id

                 AND r.status = 'approved'

                 AND r.original_order_status = OLD.status

                 AND r.approved_by <> r.requested_by

                 AND r.approved_at IS NOT NULL

                 AND public.current_org_id() =
                     OLD.organization_id

                 AND auth.uid() IS NOT NULL

                 AND public.current_access_scope() IS NOT NULL

                 AND public.current_access_scope() <> 'technical'

                 AND public.neo_branch_in_scope(
                     OLD.branch_id
                 ) IS TRUE

                 AND coalesce(

                     public.has_permission(
                         'pos','bill.reopen.execute'
                     )

                     OR public.is_org_admin(),

                     false

                 )

           )

        THEN

            RAISE EXCEPTION
              'Approved controlled reopening is required';

        END IF;

        PERFORM
            public.neo_pos_assert_bill_reopening_financial_integrity(
                OLD.id
            );

    END IF;

    RETURN NEW;

END;

$function$;


-- Activation state and current execution eligibility.

CREATE OR REPLACE FUNCTION
public.neo_pos_bill_reopening_execution_context(
    _order uuid
)
RETURNS jsonb

LANGUAGE plpgsql
SECURITY DEFINER

SET search_path TO pg_catalog,public

AS $function$

DECLARE

    org uuid := public.current_org_id();

    context jsonb;

    evidence jsonb;

    v_allowed boolean;

    v_clear boolean;

BEGIN

    context :=
        public.neo_pos_bill_reopening_context(
            _order
        );

    evidence :=
        context->'financial_evidence';

    v_allowed := coalesce(

        public.has_permission(
            'pos','bill.reopen.execute'
        )

        OR public.is_org_admin(),

        false

    );

    v_clear :=

        coalesce(
            (
                evidence->>'direct_reopen_eligible'
            )::boolean,
            false
        )

        AND NOT EXISTS (

            SELECT 1

            FROM public.pos_payments p

            WHERE p.organization_id = org
              AND p.order_id = _order

        )

        AND NOT EXISTS (

            SELECT 1

            FROM public.payments p

            WHERE p.organization_id = org
              AND p.source_record_id = _order

        )

        AND NOT EXISTS (

            SELECT 1

            FROM public.journal_entries j

            WHERE j.organization_id = org
              AND j.source_document_id = _order

        )

        AND NOT EXISTS (

            SELECT 1

            FROM public.pos_orders o

            WHERE o.id = _order
              AND o.organization_id = org

              AND (

                  nullif(
                      to_jsonb(o)->>'folio_id',''
                  ) IS NOT NULL

                  OR nullif(
                      to_jsonb(o)->>'room_charge_id',''
                  ) IS NOT NULL

              )

        );

    RETURN context || jsonb_build_object(

        'execution_enabled',

            v_allowed

            AND has_function_privilege(

                'authenticated',

                'public.neo_pos_execute_bill_reopening(uuid)',

                'EXECUTE'

            ),

        'execution_financially_eligible',

            v_clear,

        'requires_financial_reconciliation',

            NOT v_clear

    );

END;

$function$;

REVOKE ALL ON FUNCTION
public.neo_pos_bill_reopening_execution_context(uuid)
FROM PUBLIC,anon;

GRANT EXECUTE ON FUNCTION
public.neo_pos_bill_reopening_execution_context(uuid)
TO authenticated;

NOTIFY pgrst,'reload schema';

COMMIT;

-- NEO_POS_REFUND_FINANCIAL_CLOSURE_V1

CREATE OR REPLACE FUNCTION public.neo_pos_refund_financial_guard(
    _request uuid,
    _approve boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $function$
DECLARE
    r public.pos_refund_requests%ROWTYPE;
    p public.pos_payments%ROWTYPE;
    o public.pos_orders%ROWTYPE;
BEGIN

    IF auth.uid() IS NULL
       OR public.current_org_id() IS NULL
       OR public.current_access_scope() IS NULL
       OR public.current_access_scope()::text='technical'
    THEN
        RAISE EXCEPTION 'Operational refund authority required'
            USING ERRCODE='42501';
    END IF;

    SELECT *
    INTO r
    FROM public.pos_refund_requests
    WHERE id=_request
    FOR UPDATE;

    IF NOT FOUND
       OR r.organization_id IS DISTINCT FROM public.current_org_id()
       OR r.branch_id IS NULL
       OR public.neo_branch_in_scope(r.branch_id) IS DISTINCT FROM true
    THEN
        RAISE EXCEPTION 'Refund unavailable in authorized property scope'
            USING ERRCODE='42501';
    END IF;

    IF _approve IS NULL THEN
        RAISE EXCEPTION 'Explicit refund decision required';
    END IF;

    IF r.status<>'pending' OR NOT _approve THEN
        RETURN;
    END IF;

    IF r.amount IS NULL
       OR r.amount<=0
       OR r.amount::text IN ('NaN','Infinity','-Infinity')
       OR round(r.amount,2)<>r.amount
    THEN
        RAISE EXCEPTION 'Invalid refund amount';
    END IF;

    SELECT *
    INTO p
    FROM public.pos_payments
    WHERE id=r.payment_id
    FOR UPDATE;

    IF NOT FOUND
       OR p.organization_id IS DISTINCT FROM r.organization_id
       OR p.branch_id IS DISTINCT FROM r.branch_id
       OR p.order_id IS DISTINCT FROM r.order_id
       OR p.status IS DISTINCT FROM 'confirmed'
    THEN
        RAISE EXCEPTION 'Original confirmed payment required';
    END IF;

    SELECT *
    INTO o
    FROM public.pos_orders
    WHERE id=r.order_id
    FOR UPDATE;

    IF NOT FOUND
       OR o.organization_id IS DISTINCT FROM r.organization_id
       OR o.branch_id IS DISTINCT FROM r.branch_id
       OR o.currency IS DISTINCT FROM p.currency
    THEN
        RAISE EXCEPTION 'Refund order identity mismatch';
    END IF;

    IF p.amount IS NULL
       OR p.amount<=0
       OR p.amount::text IN ('NaN','Infinity','-Infinity')
       OR round(p.amount,2)<>p.amount
    THEN
        RAISE EXCEPTION 'Invalid original payment amount';
    END IF;

    IF r.amount>p.amount THEN
        RAISE EXCEPTION 'Refund exceeds original collection';
    END IF;

    -- The legacy executor changes the entire payment
    -- to refunded. Do not use that operation for a
    -- partial refund.

    IF r.amount<p.amount THEN
        RAISE EXCEPTION
            'Partial refund requires controlled partial settlement accounting';
    END IF;

    IF r.method IS NOT NULL
       AND r.method IS DISTINCT FROM p.method
    THEN
        RAISE EXCEPTION 'Refund settlement method differs from original payment';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.pos_refund_requests x
        WHERE x.id<>r.id
          AND x.payment_id=p.id
          AND x.status='processed'
    ) THEN
        RAISE EXCEPTION 'Original payment already has processed refund evidence';
    END IF;

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_pos_refund_financial_guard(uuid,boolean)
FROM PUBLIC,anon,authenticated,service_role;


-- Require a successful actual journal before allowing
-- the legacy refund transaction to commit.

CREATE OR REPLACE FUNCTION public.neo_pos_refund_require_posting(
    _request uuid,
    _posting jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $function$
DECLARE
    r public.pos_refund_requests%ROWTYPE;
    p public.pos_payments%ROWTYPE;
    j public.journal_entries%ROWTYPE;
    v_journal uuid;
    v_debit numeric;
    v_credit numeric;
    v_count integer;
BEGIN

    IF _posting IS NULL
       OR _posting->>'ok' IS DISTINCT FROM 'true'
       OR nullif(_posting->>'journal_id','') IS NULL
    THEN
        RAISE EXCEPTION
            'Refund accounting was not successfully posted';
    END IF;

    v_journal:=(_posting->>'journal_id')::uuid;

    SELECT *
    INTO r
    FROM public.pos_refund_requests
    WHERE id=_request
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Refund evidence unavailable';
    END IF;

    SELECT *
    INTO p
    FROM public.pos_payments
    WHERE id=r.payment_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Refund payment unavailable';
    END IF;

    SELECT *
    INTO j
    FROM public.journal_entries
    WHERE id=v_journal
    FOR UPDATE;

    IF NOT FOUND
       OR j.organization_id IS DISTINCT FROM r.organization_id
       OR j.branch_id IS DISTINCT FROM r.branch_id
       OR j.source_document_id IS DISTINCT FROM r.id
       OR j.source_document_type IS DISTINCT FROM 'pos_refund:refund'
       OR j.status::text IS DISTINCT FROM 'posted'
       OR j.currency IS DISTINCT FROM p.currency
       OR j.total_debit IS DISTINCT FROM r.amount
       OR j.total_credit IS DISTINCT FROM r.amount
       OR j.reversed_by_journal_id IS NOT NULL
       OR j.reverses_journal_id IS NOT NULL
       OR EXISTS (
           SELECT 1
           FROM public.journal_entries reversal
           WHERE reversal.reverses_journal_id=j.id
             AND reversal.status::text='posted'
       )
    THEN
        RAISE EXCEPTION 'Refund journal evidence is inconsistent';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.journal_entry_lines l
        WHERE l.journal_id=j.id
          AND (
              l.organization_id IS DISTINCT FROM r.organization_id
              OR l.branch_id IS DISTINCT FROM r.branch_id
              OR l.debit IS NULL
              OR l.credit IS NULL
              OR l.debit<0
              OR l.credit<0
              OR l.debit::text IN ('NaN','Infinity','-Infinity')
              OR l.credit::text IN ('NaN','Infinity','-Infinity')
              OR (l.debit>0 AND l.credit>0)
          )
    ) THEN
        RAISE EXCEPTION 'Refund journal lines are invalid';
    END IF;

    SELECT count(*),
           coalesce(sum(debit),0),
           coalesce(sum(credit),0)
    INTO v_count,v_debit,v_credit
    FROM public.journal_entry_lines
    WHERE journal_id=j.id;

    IF v_count<2
       OR v_debit IS DISTINCT FROM r.amount
       OR v_credit IS DISTINCT FROM r.amount
    THEN
        RAISE EXCEPTION 'Refund journal is not balanced to the approved amount';
    END IF;

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_pos_refund_require_posting(uuid,jsonb)
FROM PUBLIC,anon,authenticated,service_role;


DO $refund_install$
DECLARE
    v_definition text;
    v_anchor text;
BEGIN

    v_definition:=pg_get_functiondef(
        'public.neo_pos_refund_decide(uuid,boolean,text)'::regprocedure
    );

    v_anchor:='  IF r.status <> ''pending'' THEN';

    IF (
        length(v_definition)
        -length(replace(v_definition,v_anchor,''))
    )/length(v_anchor)<>1 THEN
        RAISE EXCEPTION 'Refund decision boundary differs';
    END IF;

    v_definition:=replace(
        v_definition,
        v_anchor,
        $guard$

  PERFORM public.neo_pos_refund_financial_guard(
      r.id,_approve
  );

$guard$ || v_anchor
    );

    v_anchor:='  post := public.neo_finance_post_refund(''pos_refund'', r.id, true);';

    IF (
        length(v_definition)
        -length(replace(v_definition,v_anchor,''))
    )/length(v_anchor)<>1 THEN
        RAISE EXCEPTION 'Refund accounting boundary differs';
    END IF;

    v_definition:=replace(
        v_definition,
        v_anchor,
        $posting$

  post := public.neo_finance_post_refund(
      'pos_refund',r.id,false
  );

  PERFORM public.neo_pos_refund_require_posting(
      r.id,post
  );

$posting$
    );

    EXECUTE v_definition;

END;
$refund_install$;
