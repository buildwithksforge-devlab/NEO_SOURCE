BEGIN;

ALTER TABLE public.neo_supplier_invoice_submissions

ADD COLUMN review_status text NOT NULL DEFAULT 'submitted'
CHECK (
    review_status IN (
        'submitted',
        'under-review',
        'returned',
        'rejected',
        'captured'
    )
),

ADD COLUMN canonical_invoice_id uuid
REFERENCES public.supplier_invoices(id),

ADD COLUMN reviewed_by uuid,

ADD COLUMN reviewed_at timestamptz,

ADD COLUMN review_note text;

CREATE UNIQUE INDEX neo_supplier_submission_canonical_invoice

ON public.neo_supplier_invoice_submissions (
    canonical_invoice_id
)

WHERE canonical_invoice_id IS NOT NULL;


-- =============================================
-- FINANCE REVIEW AUTHORITY
-- =============================================

CREATE OR REPLACE FUNCTION
public.neo_supplier_submission_review(
    _submission uuid,
    _decision text,
    _reason text
)
RETURNS jsonb

LANGUAGE plpgsql

SECURITY DEFINER

SET search_path TO pg_catalog,public

AS $function$

DECLARE

    org uuid := public.current_org_id();

    s public.neo_supplier_invoice_submissions%ROWTYPE;

    v_reason text := btrim(coalesce(_reason,''));

BEGIN

    IF auth.uid() IS NULL
       OR org IS NULL
       OR public.current_access_scope() IS NULL
       OR public.current_access_scope() = 'technical'
       OR NOT coalesce(
           public.has_permission('finance','edit')
           OR public.is_org_admin(),
           false
       )
    THEN
        RAISE EXCEPTION 'Finance review access denied'
          USING ERRCODE='42501';
    END IF;

    IF _decision IS NULL
       OR _decision NOT IN (
           'under-review',
           'returned',
           'rejected'
       )
       OR length(v_reason) NOT BETWEEN 5 AND 4000
    THEN
        RAISE EXCEPTION 'Invalid review decision or reason';
    END IF;

    SELECT *
    INTO s
    FROM public.neo_supplier_invoice_submissions x
    WHERE x.id = _submission
      AND x.organization_id = org
    FOR UPDATE;

    IF s.id IS NULL
       OR public.neo_branch_in_scope(s.branch_id) IS NOT TRUE
    THEN
        RAISE EXCEPTION 'Supplier submission unavailable'
          USING ERRCODE='42501';
    END IF;

    IF s.canonical_invoice_id IS NOT NULL
       OR s.review_status = 'captured'
    THEN
        RAISE EXCEPTION
          'Captured submissions must be managed through the official invoice';
    END IF;



    IF s.review_status = _decision
       AND s.review_note = v_reason
       AND s.reviewed_by = auth.uid()
    THEN
        RETURN jsonb_build_object(
            'ok',true,
            'submission_id',s.id,
            'review_status',s.review_status,
            'duplicate_prevented',true
        );
    END IF;

    IF s.review_status = 'rejected' THEN
        RAISE EXCEPTION 'Rejected submission is closed';
    END IF;

    UPDATE public.neo_supplier_invoice_submissions
    SET review_status = _decision,
        reviewed_by = auth.uid(),
        reviewed_at = now(),
        review_note = v_reason
    WHERE id = s.id;

    INSERT INTO public.audit_logs (
        organization_id,
        branch_id,
        user_id,
        action,
        module,
        record_id,
        previous_value,
        new_value,
        reason
    )
    VALUES (
        org,s.branch_id,auth.uid(),
        'finance.supplier_submission.review',
        'finance',s.id::text,
        jsonb_build_object(
            'review_status',s.review_status
        ),
        jsonb_build_object(
            'review_status',_decision
        ),
        v_reason
    );

    RETURN jsonb_build_object(
        'ok',true,
        'submission_id',s.id,
        'review_status',_decision
    );

END;
$function$;


-- =============================================
-- CAPTURE THROUGH THE EXISTING INVOICE ENGINE
-- =============================================


ALTER TABLE public.neo_supplier_invoice_submissions
ADD COLUMN IF NOT EXISTS
    capture_request_evidence jsonb;


CREATE TABLE public.neo_supplier_capture_line_reservations (

    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    organization_id uuid NOT NULL,

    submission_id uuid NOT NULL
        REFERENCES public.neo_supplier_invoice_submissions(id),

    supplier_invoice_id uuid NOT NULL
        REFERENCES public.supplier_invoices(id),

    receipt_id uuid NOT NULL
        REFERENCES public.goods_receipts(id),

    purchase_order_line_id uuid NOT NULL
        REFERENCES public.purchase_order_lines(id),

    quantity numeric NOT NULL,

    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT neo_supplier_capture_quantity_valid
        CHECK (
            quantity > 0
            AND quantity::text NOT IN (
                'NaN','Infinity','-Infinity'
            )
        ),

    UNIQUE (
        submission_id,
        purchase_order_line_id
    )

);

ALTER TABLE public.neo_supplier_capture_line_reservations
ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.neo_supplier_capture_line_reservations
FROM PUBLIC,anon,authenticated;

CREATE INDEX neo_supplier_capture_reservation_lookup
ON public.neo_supplier_capture_line_reservations (
    organization_id,
    receipt_id,
    purchase_order_line_id
);

CREATE OR REPLACE FUNCTION
public.neo_supplier_submission_capture(
    _submission uuid,
    _receipt uuid,
    _lines jsonb,
    _due_date date DEFAULT NULL
)
RETURNS jsonb

LANGUAGE plpgsql

SECURITY DEFINER

SET search_path TO pg_catalog,public

AS $function$

DECLARE

    org uuid := public.current_org_id();

    s public.neo_supplier_invoice_submissions%ROWTYPE;

    inv public.supplier_invoices%ROWTYPE;

    payload jsonb;

    result jsonb;

    invoice_id uuid;

    v_capture_evidence jsonb;

    v_line jsonb;

    v_line_id uuid;

    v_quantity numeric;

    v_price numeric;

    v_tax numeric;

    v_seen uuid[] := ARRAY[]::uuid[];    v_original_line public.purchase_order_lines%ROWTYPE;

    v_receipt_accepted numeric;

    v_receipt_reserved numeric;

    v_order_pending numeric;

BEGIN

    IF auth.uid() IS NULL
       OR org IS NULL
       OR public.current_access_scope() IS NULL
       OR public.current_access_scope() = 'technical'
       OR NOT coalesce(
           public.has_permission('finance','edit')
           OR public.is_org_admin(),
           false
       )
    THEN
        RAISE EXCEPTION 'Finance invoice capture denied'
          USING ERRCODE='42501';
    END IF;

    SELECT *
    INTO s
    FROM public.neo_supplier_invoice_submissions x
    WHERE x.id = _submission
      AND x.organization_id = org
    FOR UPDATE;

    IF s.id IS NULL
       OR public.neo_branch_in_scope(s.branch_id) IS NOT TRUE
    THEN
        RAISE EXCEPTION 'Supplier submission unavailable'
          USING ERRCODE='42501';
    END IF;

    IF jsonb_typeof(_lines) IS DISTINCT FROM 'array'
       OR jsonb_array_length(_lines) = 0
       OR jsonb_array_length(_lines) > 500
    THEN
        RAISE EXCEPTION 'Verified invoice lines are required';
    END IF;

    SELECT jsonb_build_object(
        'receipt_id',_receipt,
        'due_date',_due_date,
        'lines',jsonb_agg(
            x.value
            ORDER BY
                x.value->>'purchase_order_line_id',
                x.value::text
        )
    )
    INTO v_capture_evidence
    FROM jsonb_array_elements(_lines) x(value);

    IF s.canonical_invoice_id IS NOT NULL THEN

        IF s.capture_request_evidence IS NULL
           OR s.capture_request_evidence
                IS DISTINCT FROM v_capture_evidence
        THEN
            RAISE EXCEPTION
              'Existing invoice capture payload differs; reload the captured invoice';
        END IF;

        SELECT *
        INTO inv
        FROM public.supplier_invoices i
        WHERE i.id = s.canonical_invoice_id
          AND i.organization_id = org
          AND i.branch_id = s.branch_id
          AND i.supplier_id = s.supplier_id
          AND i.order_id = s.purchase_order_id;

        IF inv.id IS NULL
           OR inv.amount IS DISTINCT FROM s.declared_amount
        THEN
            RAISE EXCEPTION
              'Existing linked invoice requires reconciliation';
        END IF;

        RETURN jsonb_build_object(
            'ok',true,
            'submission_id',s.id,
            'invoice_id',inv.id,
            'invoice_status',inv.status,
            'already_captured',true,
            'requires_reload',true
        );

    END IF;

    IF s.review_status NOT IN (
        'submitted','under-review'
    ) THEN
        RAISE EXCEPTION
          'Submission is not eligible for invoice capture';
    END IF;

    IF _receipt IS NULL
       OR NOT EXISTS (
           SELECT 1
           FROM public.goods_receipts g
           WHERE g.id = _receipt
             AND g.organization_id = org
             AND g.branch_id = s.branch_id
             AND g.supplier_id = s.supplier_id
             AND g.order_id = s.purchase_order_id
             AND g.status = 'posted'
       )
    THEN
        RAISE EXCEPTION
          'Select a posted goods receipt for this purchase order';
    END IF;

    IF jsonb_typeof(_lines) IS DISTINCT FROM 'array'
       OR jsonb_array_length(_lines) = 0
    THEN
        RAISE EXCEPTION
          'Verified invoice lines are required';
    END IF;

    IF _due_date IS NOT NULL
       AND _due_date < s.invoice_date
    THEN
        RAISE EXCEPTION 'Invalid invoice due date';
    END IF;

    IF public.neo_fact_currency(
        org,s.branch_id
    ) IS DISTINCT FROM s.currency THEN
        RAISE EXCEPTION
          'Submission currency does not match property currency';
    END IF;

    -- SUPPLIER_CAPTURE_INTEGRITY_V2

    PERFORM 1
    FROM public.purchase_orders p
    WHERE p.id = s.purchase_order_id
      AND p.organization_id = org
      AND p.branch_id = s.branch_id
      AND p.supplier_id = s.supplier_id
      AND p.status NOT IN (
          'draft',
          'cancelled',
          'voided',
          'rejected',
          'pending-approval',
          'pending_approval'
      )
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
          'Supplier purchase order is unavailable for capture';
    END IF;    -- SUPPLIER_LEGACY_CAPTURE_BOUNDARY_V1

    -- Do not silently ignore invoices created through
    -- a different capture path without quantity evidence.

    IF EXISTS (

        SELECT 1

        FROM public.supplier_invoices i

        WHERE i.organization_id = org

          AND i.order_id = s.purchase_order_id

          AND i.status NOT IN (
              'cancelled','voided','rejected'
          )

          AND (

              i.approved_at IS NULL

              OR i.receipt_id = _receipt

          )

          AND NOT EXISTS (

              SELECT 1

              FROM public.neo_supplier_capture_line_reservations r

              WHERE r.organization_id = org

                AND r.supplier_invoice_id = i.id

          )

    ) THEN

        RAISE EXCEPTION
          'Existing supplier invoice requires quantity reconciliation before additional capture';

    END IF;

    FOR v_line IN
        SELECT value
        FROM jsonb_array_elements(_lines)
    LOOP

        IF jsonb_typeof(v_line) IS DISTINCT FROM 'object'
        THEN
            RAISE EXCEPTION 'Invalid invoice line';
        END IF;

        v_line_id := nullif(
            v_line->>'purchase_order_line_id',''
        )::uuid;

        v_quantity := nullif(
            v_line->>'quantity',''
        )::numeric;

        v_price := nullif(
            v_line->>'unit_price',''
        )::numeric;

        v_tax := coalesce(
            nullif(v_line->>'tax_amount','')::numeric,
            0
        );

        IF v_line_id IS NULL
           OR v_line_id = ANY(v_seen)
           OR v_quantity IS NULL
           OR v_price IS NULL
           OR v_quantity <= 0
           OR v_price < 0
           OR v_tax < 0
           OR v_quantity::text IN (
               'NaN','Infinity','-Infinity'
           )
           OR v_price::text IN (
               'NaN','Infinity','-Infinity'
           )
           OR v_tax::text IN (
               'NaN','Infinity','-Infinity'
           )
           OR v_quantity > 100000000
           OR v_price > 100000000
           OR v_tax > 100000000
           OR v_tax <> round(v_tax,2)
        THEN
            RAISE EXCEPTION
              'Invalid or duplicate supplier invoice line';
        END IF;

        v_seen := array_append(
            v_seen,v_line_id
        );

        SELECT *
        INTO v_original_line
        FROM public.purchase_order_lines p
        WHERE p.id = v_line_id          AND p.order_id = s.purchase_order_id
          AND p.organization_id = org
        FOR UPDATE;

        IF v_original_line.id IS NULL THEN
            RAISE EXCEPTION
              'Invoice line does not belong to the original purchase order';
        END IF;

        IF nullif(
            v_line->>'stock_item_id',''
        )::uuid IS DISTINCT FROM
            v_original_line.stock_item_id
        THEN
            RAISE EXCEPTION
              'Invoice stock item differs from the original purchase order';
        END IF;

        IF v_quantity >
           v_original_line.quantity
        THEN
            RAISE EXCEPTION
              'Invoice quantity exceeds the original purchase order';
        END IF;        -- Selected GRN accepted quantity, net of recorded returns.

        SELECT coalesce(sum(
            greatest(
                0,
                coalesce(g.quantity_accepted,0)
                - coalesce(g.quantity_returned,0)
            )
        ),0)
        INTO v_receipt_accepted

        FROM public.goods_receipt_lines g

        WHERE g.organization_id = org
          AND g.receipt_id = _receipt
          AND g.order_line_id = v_line_id
          AND g.stock_item_id IS NOT DISTINCT FROM v_original_line.stock_item_id;

        SELECT coalesce(sum(r.quantity),0)

        INTO v_receipt_reserved

        FROM public.neo_supplier_capture_line_reservations r

        JOIN public.supplier_invoices i
          ON i.id = r.supplier_invoice_id

        WHERE r.organization_id = org
          AND r.receipt_id = _receipt
          AND r.purchase_order_line_id = v_line_id
          AND i.organization_id = org
          AND i.status NOT IN (
              'cancelled','voided','rejected'
          );

        IF v_quantity >
           v_receipt_accepted-v_receipt_reserved
        THEN
            RAISE EXCEPTION
              'Invoice quantity exceeds available accepted goods receipt quantity';
        END IF;

        SELECT coalesce(sum(r.quantity),0)

        INTO v_order_pending

        FROM public.neo_supplier_capture_line_reservations r

        JOIN public.supplier_invoices i
          ON i.id = r.supplier_invoice_id

        WHERE r.organization_id = org
          AND r.purchase_order_line_id = v_line_id
          AND i.organization_id = org
          AND i.approved_at IS NULL
          AND i.status NOT IN (
              'cancelled','voided','rejected'
          );

        IF v_quantity >
            coalesce(v_original_line.accepted_quantity,0)
            - coalesce(v_original_line.invoiced_quantity,0)
            - v_order_pending
        THEN
            RAISE EXCEPTION
              'Invoice quantity exceeds unreserved accepted purchase order quantity';
        END IF;

        IF coalesce(
            nullif(
                v_line->>'discount_amount',''
            )::numeric,
            0
        ) <> 0
        THEN
            RAISE EXCEPTION
              'Supplier capture does not support an unverified line discount';
        END IF;

    END LOOP;

    payload := jsonb_build_object(
        'branch_id',s.branch_id,
        'supplier_id',s.supplier_id,
        'order_id',s.purchase_order_id,
        'receipt_id',_receipt,
        'invoice_number',s.invoice_number,
        'invoice_date',s.invoice_date,
        'due_date',_due_date,
        'notes',s.notes,
        'allow_duplicate',false,
        'lines',_lines
    );

    result := public.neo_supplier_invoice_capture(
        payload
    );

    invoice_id := nullif(
        result->>'invoice_id',''
    )::uuid;

    IF (result->>'ok')::boolean IS NOT TRUE
       OR invoice_id IS NULL
    THEN
        RAISE EXCEPTION
          'Canonical invoice capture failed';
    END IF;

    SELECT *
    INTO inv
    FROM public.supplier_invoices i
    WHERE i.id = invoice_id
      AND i.organization_id = org
      AND i.branch_id = s.branch_id
      AND i.supplier_id = s.supplier_id
      AND i.order_id = s.purchase_order_id
      AND i.receipt_id = _receipt;

    IF inv.id IS NULL
       OR inv.amount IS DISTINCT FROM s.declared_amount
       OR inv.status IS DISTINCT FROM 'draft'
       OR inv.journal_id IS NOT NULL
    THEN
        RAISE EXCEPTION
          'Captured invoice differs from submitted financial evidence';
    END IF;
    -- Canonical capture already recorded the reservations.
    -- The submission retains its own immutable capture
    -- evidence and canonical invoice relationship.

    IF (
        SELECT count(*)
        FROM public.neo_supplier_capture_line_reservations r
        WHERE r.organization_id=org
          AND r.supplier_invoice_id=inv.id
          AND r.receipt_id=_receipt
    ) IS DISTINCT FROM jsonb_array_length(_lines)::bigint
    THEN
        RAISE EXCEPTION
          'Canonical supplier reservation evidence is incomplete';
    END IF;

    IF EXISTS (

        SELECT 1

        FROM jsonb_array_elements(_lines) x(value)

        WHERE NOT EXISTS (

            SELECT 1

            FROM public.neo_supplier_capture_line_reservations r

            WHERE r.organization_id=org

              AND r.supplier_invoice_id=inv.id

              AND r.receipt_id=_receipt

              AND r.purchase_order_line_id=
                  (x.value->>'purchase_order_line_id')::uuid

              AND r.quantity=
                  (x.value->>'quantity')::numeric

        )

    ) THEN

        RAISE EXCEPTION
          'Canonical supplier reservation differs from submission';

    END IF;


    UPDATE public.neo_supplier_invoice_submissions

    SET canonical_invoice_id = inv.id,
        capture_request_evidence = v_capture_evidence,
        review_status = 'captured',
        reviewed_by = auth.uid(),
        reviewed_at = now(),
        review_note = 'Captured through canonical invoice engine'
    WHERE id = s.id;

    INSERT INTO public.audit_logs (
        organization_id,
        branch_id,
        user_id,
        action,
        module,
        record_id,
        new_value
    )
    VALUES (
        org,s.branch_id,auth.uid(),
        'finance.supplier_submission.capture',
        'finance',s.id::text,
        jsonb_build_object(
            'invoice_id',inv.id,
            'receipt_id',_receipt,
            'amount',inv.amount
        )
    );

    RETURN jsonb_build_object(
        'ok',true,
        'submission_id',s.id,
        'invoice_id',inv.id,
        'match',result->'match',
        'payable_created',false
    );

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_supplier_submission_review(uuid,text,text)
FROM PUBLIC,anon;

GRANT EXECUTE ON FUNCTION
public.neo_supplier_submission_review(uuid,text,text)
TO authenticated;

-- Keep invoice capture disabled until the
-- complete matching and approval chain is verified.

REVOKE ALL ON FUNCTION
public.neo_supplier_submission_capture(uuid,uuid,jsonb,date)
FROM PUBLIC,anon,authenticated;

NOTIFY pgrst,'reload schema';

CREATE OR REPLACE FUNCTION
public.neo_partner_supplier_invoice_submissions(

    _branch uuid,

    _relationship uuid

)
RETURNS jsonb

LANGUAGE plpgsql

STABLE

SECURITY DEFINER

SET search_path TO pg_catalog,public

AS $function$

DECLARE

    rel public.neo_access_relationships%ROWTYPE;

BEGIN

    IF auth.uid() IS NULL
      OR _branch IS NULL
    THEN

      RAISE EXCEPTION 'Authentication required'
        USING ERRCODE='42501';

    END IF;

    SELECT *

    INTO rel

    FROM public.neo_access_relationships r

    WHERE r.id = _relationship

      AND r.auth_user_id = auth.uid()

      AND r.door = 'partner'

      AND r.status = 'active'

      AND r.supplier_id IS NOT NULL

      AND (
        r.branch_id IS NULL
        OR r.branch_id = _branch
      );

    IF rel.id IS NULL

      OR NOT EXISTS (

        SELECT 1

        FROM public.branches b

        WHERE b.id = _branch

          AND b.organization_id = rel.organization_id

          AND b.active IS TRUE

      )

    THEN

      RAISE EXCEPTION 'Supplier access denied'
        USING ERRCODE='42501';

    END IF;

    RETURN coalesce((

      SELECT jsonb_agg(
        to_jsonb(x)
        ORDER BY x.submitted_at DESC,x.id DESC
      )

      FROM (

        SELECT

          s.id,

          p.order_number,

          s.invoice_number,

          s.invoice_date,

          s.currency,

          s.declared_amount,

          s.delivery_reference,

          s.notes,

          s.submitted_at,

          s.review_status AS submission_status,
          s.review_note,
          s.reviewed_at,
          s.canonical_invoice_id

        FROM public.neo_supplier_invoice_submissions s

        JOIN public.purchase_orders p

          ON p.id = s.purchase_order_id

          AND p.organization_id = s.organization_id

          AND p.branch_id = s.branch_id

          AND p.supplier_id = s.supplier_id

        WHERE s.organization_id = rel.organization_id

          AND s.branch_id = _branch

          AND s.supplier_id = rel.supplier_id

        ORDER BY s.submitted_at DESC,s.id DESC

        LIMIT 200

      ) x

    ),'[]'::jsonb);

END;

$function$;

CREATE OR REPLACE FUNCTION
public.neo_supplier_invoice_submission_register(

    _branch uuid DEFAULT NULL

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

      OR NOT coalesce(

        public.has_permission('finance','view')

        OR public.has_permission(
          'procurement','quotations.manage'
        )

        OR public.has_permission(
          'procurement','orders.create'
        )

        OR public.is_org_admin(),

        false

      )

    THEN

      RAISE EXCEPTION 'Invoice register access denied'
        USING ERRCODE='42501';

    END IF;

    IF _branch IS NOT NULL

      AND public.neo_branch_in_scope(_branch) IS NOT TRUE

    THEN

      RAISE EXCEPTION 'Property access denied'
        USING ERRCODE='42501';

    END IF;

    RETURN coalesce((

      SELECT jsonb_agg(
        to_jsonb(x)
        ORDER BY x.submitted_at DESC,x.id DESC
      )

      FROM (

        SELECT

          i.id,

          i.branch_id,

          i.supplier_id,

          s.name AS supplier_name,

          i.purchase_order_id,

          p.order_number,

          i.invoice_number,

          i.invoice_date,

          i.currency,

          i.declared_amount,

          i.delivery_reference,

          i.notes,

          i.submitted_at,
          i.review_status,
          i.review_note,
          i.reviewed_at,
          i.canonical_invoice_id

        FROM public.neo_supplier_invoice_submissions i

        JOIN public.suppliers s

          ON s.id = i.supplier_id

          AND s.organization_id = i.organization_id

        JOIN public.purchase_orders p

          ON p.id = i.purchase_order_id

          AND p.organization_id = i.organization_id

          AND p.branch_id = i.branch_id

          AND p.supplier_id = i.supplier_id

        WHERE i.organization_id = org

          AND (
            _branch IS NULL
            OR i.branch_id = _branch
          )

          AND public.neo_branch_in_scope(
            i.branch_id
          ) IS TRUE

        ORDER BY i.submitted_at DESC,i.id DESC

        LIMIT 300

      ) x

    ),'[]'::jsonb);

END;

$function$;

NOTIFY pgrst,'reload schema';


CREATE OR REPLACE FUNCTION
public.neo_supplier_submission_capture_context(
    _submission uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog,public
AS $function$
DECLARE

    org uuid := public.current_org_id();

    s public.neo_supplier_invoice_submissions%ROWTYPE;

BEGIN

    IF auth.uid() IS NULL
       OR org IS NULL
       OR public.current_access_scope() IS NULL
       OR public.current_access_scope() = 'technical'
       OR NOT coalesce(
           public.has_permission('finance','edit')
           OR public.is_org_admin(),false
       )
    THEN
        RAISE EXCEPTION 'Invoice capture access denied'
          USING ERRCODE='42501';
    END IF;

    SELECT *
    INTO s
    FROM public.neo_supplier_invoice_submissions
    WHERE id = _submission
      AND organization_id = org;

    IF s.id IS NULL
       OR public.neo_branch_in_scope(s.branch_id) IS NOT TRUE
    THEN
        RAISE EXCEPTION 'Submission unavailable'
          USING ERRCODE='42501';
    END IF;

    IF s.review_status NOT IN (
        'submitted','under-review'
    )
       OR s.canonical_invoice_id IS NOT NULL
    THEN
        RAISE EXCEPTION 'Submission is not available for capture';
    END IF;

    RETURN jsonb_build_object(
        'execution_enabled',
        has_function_privilege(
            'authenticated',
            'public.neo_supplier_submission_capture(uuid,uuid,jsonb,date)',
            'EXECUTE'
        ),


        'submission_id',s.id,

        'currency',s.currency,

        'declared_amount',s.declared_amount,

        'invoice_number',s.invoice_number,

        'invoice_date',s.invoice_date,

        'receipts',coalesce((

            SELECT jsonb_agg(
                jsonb_build_object(
                    'id',g.id,
                    'reference',coalesce(
                        to_jsonb(g)->>'receipt_number',
                        to_jsonb(g)->>'grn_number',
                        g.id::text
                    )
                )
            )

            FROM public.goods_receipts g

            WHERE g.organization_id = org
              AND g.branch_id = s.branch_id
              AND g.supplier_id = s.supplier_id
              AND g.order_id = s.purchase_order_id
              AND g.status = 'posted'

        ),'[]'::jsonb),

        'order_lines',coalesce((

            SELECT jsonb_agg(
                jsonb_build_object(
                    'id',p.id,
                    'stock_item_id',p.stock_item_id,
                    'description',p.description,
                    'quantity',p.quantity,
                    'unit_price',p.unit_price,
                    'accepted_quantity',
                        coalesce(p.accepted_quantity,0),
                    'invoiced_quantity',
                        coalesce(p.invoiced_quantity,0)
                )
            )

            FROM public.purchase_order_lines p

            WHERE p.organization_id = org
              AND p.order_id = s.purchase_order_id

        ),'[]'::jsonb)

    );

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_supplier_submission_capture_context(uuid)
FROM PUBLIC,anon;

GRANT EXECUTE ON FUNCTION
public.neo_supplier_submission_capture_context(uuid)
TO authenticated;


CREATE OR REPLACE FUNCTION
public.neo_partner_supplier_invoice_payment_position(
    _branch uuid,
    _relationship uuid,
    _submission uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog,public
AS $function$
DECLARE

    rel public.neo_access_relationships%ROWTYPE;

    s public.neo_supplier_invoice_submissions%ROWTYPE;

    inv public.supplier_invoices%ROWTYPE;

    paid numeric;

BEGIN

    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
          USING ERRCODE='42501';
    END IF;

    SELECT *
    INTO rel
    FROM public.neo_access_relationships r
    WHERE r.id = _relationship
      AND r.auth_user_id = auth.uid()
      AND r.door = 'partner'
      AND r.status = 'active'
      AND r.supplier_id IS NOT NULL
      AND (
          r.branch_id IS NULL
          OR r.branch_id = _branch
      );

    IF rel.id IS NULL
       OR NOT EXISTS (
           SELECT 1
           FROM public.branches b
           WHERE b.id = _branch
             AND b.organization_id = rel.organization_id
             AND b.active IS TRUE
       )
    THEN
        RAISE EXCEPTION 'Supplier access denied'
          USING ERRCODE='42501';
    END IF;

    SELECT *
    INTO s
    FROM public.neo_supplier_invoice_submissions
    WHERE id = _submission
      AND organization_id = rel.organization_id
      AND branch_id = _branch
      AND supplier_id = rel.supplier_id;

    IF s.id IS NULL THEN
        RAISE EXCEPTION 'Invoice submission unavailable'
          USING ERRCODE='42501';
    END IF;

    IF s.canonical_invoice_id IS NULL THEN
        RETURN jsonb_build_object(
            'invoice_number',s.invoice_number,
            'review_status',s.review_status,
            'payable_recognized',false
        );
    END IF;

    SELECT *
    INTO inv
    FROM public.supplier_invoices
    WHERE id = s.canonical_invoice_id
      AND organization_id = s.organization_id
      AND branch_id = s.branch_id
      AND supplier_id = s.supplier_id
      AND order_id = s.purchase_order_id;

    IF inv.id IS NULL THEN
        RAISE EXCEPTION
          'Linked invoice requires reconciliation';
    END IF;

    IF inv.journal_id IS NULL
       OR inv.approved_at IS NULL
       OR inv.status NOT IN (
           'approved','partially_paid','paid'
       )
    THEN
        RETURN jsonb_build_object(
            'invoice_number',inv.invoice_number,
            'review_status',s.review_status,
            'invoice_status',inv.status,
            'payable_recognized',false
        );
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.journal_entries j
        WHERE j.id = inv.journal_id
          AND j.organization_id = inv.organization_id
          AND j.branch_id = inv.branch_id
          AND j.source_document_id = inv.id
          AND j.source_document_type = 'supplier_invoice:payable'
          AND j.currency = s.currency
          AND j.status = 'posted'
          AND j.reversed_by_journal_id IS NULL
          AND j.total_debit = inv.amount
          AND j.total_credit = inv.amount
    ) THEN
        RAISE EXCEPTION
          'Supplier payable requires reconciliation';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.supplier_payments p
        LEFT JOIN public.journal_entries j
          ON j.id = p.journal_id
        WHERE p.supplier_invoice_id = inv.id
          AND p.status = 'paid'
          AND (
              p.organization_id IS DISTINCT FROM inv.organization_id
              OR p.branch_id IS DISTINCT FROM inv.branch_id
              OR p.supplier_id IS DISTINCT FROM inv.supplier_id
              OR j.id IS NULL
              OR j.organization_id IS DISTINCT FROM inv.organization_id
              OR j.branch_id IS DISTINCT FROM inv.branch_id
              OR j.source_document_id IS DISTINCT FROM p.id
              OR j.source_document_type IS DISTINCT FROM
                  'supplier_payment:settlement'
              OR j.currency IS DISTINCT FROM s.currency
              OR j.status IS DISTINCT FROM 'posted'
              OR j.reversed_by_journal_id IS NOT NULL
              OR j.total_debit IS DISTINCT FROM p.amount
              OR j.total_credit IS DISTINCT FROM p.amount
              OR p.amount IS NULL
              OR p.amount <= 0
              OR p.amount::text IN (
                  'NaN','Infinity','-Infinity'
              )
          )
    ) THEN
        RAISE EXCEPTION
          'Supplier settlement requires reconciliation';
    END IF;

    SELECT coalesce(sum(p.amount),0)
    INTO paid
    FROM public.supplier_payments p
    WHERE p.supplier_invoice_id = inv.id
      AND p.organization_id = inv.organization_id
      AND p.branch_id = inv.branch_id
      AND p.supplier_id = inv.supplier_id
      AND p.status = 'paid';

    IF inv.amount IS NULL
       OR inv.amount <= 0
       OR inv.amount::text IN (
           'NaN','Infinity','-Infinity'
       )
       OR paid < 0
       OR paid::text IN (
           'NaN','Infinity','-Infinity'
       )
       OR paid > inv.amount
       OR paid IS DISTINCT FROM coalesce(inv.paid_amount,0)
       OR (
           inv.status = 'paid'
           AND paid IS DISTINCT FROM inv.amount
       )
       OR (
           inv.status = 'partially_paid'
           AND (
               paid <= 0
               OR paid >= inv.amount
           )
       )
    THEN
        RAISE EXCEPTION
          'Supplier outstanding balance requires reconciliation';
    END IF;

    RETURN jsonb_build_object(

        'invoice_number',inv.invoice_number,

        'invoice_status',inv.status,

        'currency',s.currency,

        'payable_recognized',true,

        'invoice_amount',inv.amount,

        'settled_amount',paid,

        'outstanding_amount',inv.amount-paid,

        'payments',coalesce((

            SELECT jsonb_agg(
                jsonb_build_object(
                    'payment_number',p.payment_number,
                    'amount',p.amount,
                    'paid_on',p.paid_on,
                    'method',p.method,
                    'status',p.status
                )
                ORDER BY p.paid_on DESC,p.id DESC
            )

            FROM public.supplier_payments p

            WHERE p.organization_id = inv.organization_id
              AND p.branch_id = inv.branch_id
              AND p.supplier_id = inv.supplier_id
              AND p.supplier_invoice_id = inv.id
              AND p.status = 'paid'

        ),'[]'::jsonb)

    );

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_partner_supplier_invoice_payment_position(
    uuid,uuid,uuid
)
FROM PUBLIC,anon;

GRANT EXECUTE ON FUNCTION
public.neo_partner_supplier_invoice_payment_position(
    uuid,uuid,uuid
)
TO authenticated;

COMMIT;


CREATE OR REPLACE FUNCTION public.neo_supplier_invoice_accept(_invoice uuid, _reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_org uuid := current_org_id();
  inv record; pol public.procurement_matching_policies; l record;
  v_net numeric; v_tax numeric; v_lines jsonb := '[]'::jsonb; v_res jsonb; v_debit_code text;
BEGIN
  IF NOT (has_permission('finance','approve') OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to accept supplier invoices';
  END IF;
  SELECT * INTO inv FROM supplier_invoices WHERE id = _invoice AND organization_id = v_org FOR UPDATE;
  IF inv IS NULL OR NOT public.neo_branch_in_scope(inv.branch_id) THEN
    RAISE EXCEPTION 'Invoice not found in property scope' USING ERRCODE='42501'; END IF;  IF inv.status IN ('cancelled','void','voided','rejected','reversed') THEN
    RAISE EXCEPTION 'Cancelled or rejected invoice cannot be posted' USING ERRCODE='22023'; END IF;  -- SUPPLIER_CURRENT_POSTING_EVIDENCE_V1

  IF auth.uid() IS NULL
     OR public.current_access_scope() IS NULL
     OR public.current_access_scope()='technical'
  THEN

    RAISE EXCEPTION 'Operational finance approval required'
      USING ERRCODE='42501';

  END IF;

  IF inv.journal_id IS NOT NULL THEN

    IF NOT EXISTS (

      SELECT 1

      FROM public.journal_entries j

      WHERE j.id=inv.journal_id

        AND j.organization_id=v_org

        AND j.branch_id IS NOT DISTINCT FROM inv.branch_id

        AND j.source_document_id=_invoice

        AND j.source_document_type='supplier_invoice:payable'

        AND j.status='posted'

        AND j.currency=
            public.neo_fact_currency(v_org,inv.branch_id)

        AND j.reverses_journal_id IS NULL

        AND j.reversed_by_journal_id IS NULL

        AND round(j.total_debit,2)=round(inv.amount,2)

        AND round(j.total_credit,2)=round(inv.amount,2)

        AND NOT EXISTS (

          SELECT 1

          FROM public.journal_entries reversal

          WHERE reversal.reverses_journal_id=j.id

            AND reversal.status='posted'

        )

        AND (

          SELECT coalesce(sum(journal_line.debit),0)

          FROM public.journal_entry_lines journal_line

          WHERE journal_line.journal_id=j.id

            AND journal_line.organization_id=v_org

            AND journal_line.branch_id IS NOT DISTINCT FROM inv.branch_id

        )=round(inv.amount,2)

        AND (

          SELECT coalesce(sum(journal_line.credit),0)

          FROM public.journal_entry_lines journal_line

          WHERE journal_line.journal_id=j.id

            AND journal_line.organization_id=v_org

            AND journal_line.branch_id IS NOT DISTINCT FROM inv.branch_id

        )=round(inv.amount,2)

        AND NOT EXISTS (

          SELECT 1

          FROM public.journal_entry_lines journal_line

          WHERE journal_line.journal_id=j.id

            AND (

              journal_line.organization_id IS DISTINCT FROM v_org

              OR journal_line.branch_id IS DISTINCT FROM inv.branch_id

              OR journal_line.debit IS NULL

              OR journal_line.credit IS NULL

              OR journal_line.debit<0

              OR journal_line.credit<0

              OR journal_line.debit::text IN ('NaN','Infinity','-Infinity')

              OR journal_line.credit::text IN ('NaN','Infinity','-Infinity')

            )

        )

    ) THEN

      RAISE EXCEPTION
        'Saved invoice journal is not confirmed; accounting reconciliation required';

    END IF;

    IF inv.approved_at IS NULL

       OR inv.status NOT IN (
         'approved','partially_paid','paid'
       )

    THEN

      RAISE EXCEPTION
        'Saved invoice approval state requires reconciliation';

    END IF;

    RETURN jsonb_build_object(
      'ok',true,
      'already_posted',true,
      'journal_id',inv.journal_id
    );

  END IF;  -- SUPPLIER_ACCOUNTING_INTEGRITY_V3

  IF inv.status IS NULL OR inv.status NOT IN ('draft','received') THEN

    RAISE EXCEPTION
      'Only a valid draft invoice may create a new payable';

  END IF;

  IF auth.uid() IS NULL
     OR public.current_access_scope() IS NULL
     OR public.current_access_scope() = 'technical'
  THEN

    RAISE EXCEPTION 'Operational finance approval required'
      USING ERRCODE='42501';

  END IF;

  IF inv.created_by IS NULL
     OR inv.created_by = auth.uid()
  THEN

    RAISE EXCEPTION
      'Supplier invoice requires independent approval';

  END IF;

  IF inv.order_id IS NOT NULL THEN

    PERFORM 1

    FROM public.purchase_orders po

    WHERE po.id=inv.order_id
      AND po.organization_id=v_org
      AND po.branch_id=inv.branch_id
      AND po.supplier_id=inv.supplier_id

    FOR UPDATE;

    IF NOT FOUND THEN

      RAISE EXCEPTION
        'Supplier purchase order unavailable for approval';

    END IF;

  END IF;

  IF inv.match_status = 'pending' THEN
    PERFORM public.proc_three_way_match(_invoice);
    SELECT * INTO inv FROM supplier_invoices WHERE id = _invoice;
  END IF;
  IF inv.match_status = 'held' AND COALESCE(btrim(_reason),'') = '' THEN
    RAISE EXCEPTION 'This invoice is on hold. A written override reason is required.';
  END IF;

  IF inv.order_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.purchase_orders po WHERE po.id=inv.order_id
      AND po.organization_id=v_org AND po.branch_id=inv.branch_id
      AND po.supplier_id=inv.supplier_id AND po.status NOT IN ('cancelled','voided')) THEN
    RAISE EXCEPTION 'Invoice order, property and supplier do not match' USING ERRCODE='23514'; END IF;
  IF inv.receipt_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.goods_receipts gr WHERE gr.id=inv.receipt_id
      AND gr.organization_id=v_org AND gr.branch_id=inv.branch_id
      AND gr.supplier_id=inv.supplier_id AND gr.order_id IS NOT DISTINCT FROM inv.order_id
      AND gr.status='posted') THEN
    RAISE EXCEPTION 'Invoice receipt does not match a posted delivery' USING ERRCODE='23514'; END IF;
  IF (SELECT count(*) FROM public.supplier_invoice_lines il WHERE il.supplier_invoice_id=_invoice) = 0
    OR round(inv.amount,2) IS DISTINCT FROM (
      SELECT round(COALESCE(sum(il.total_amount),0),2) FROM public.supplier_invoice_lines il
      WHERE il.supplier_invoice_id=_invoice) THEN
    RAISE EXCEPTION 'Invoice header and line amounts do not agree' USING ERRCODE='23514'; END IF;  IF inv.order_id IS NOT NULL THEN

    IF inv.receipt_id IS NULL THEN

      RAISE EXCEPTION
        'Order invoice requires posted goods receipt evidence';

    END IF;

    -- Reservation-backed invoices must have exact
    -- purchase order line attribution.

    IF EXISTS (

      SELECT 1

      FROM public.neo_supplier_capture_line_reservations r

      WHERE r.supplier_invoice_id=_invoice

    ) THEN

      IF EXISTS (

        SELECT 1

        FROM public.neo_supplier_capture_line_reservations r

        LEFT JOIN public.purchase_order_lines p
          ON p.id=r.purchase_order_line_id

        WHERE r.supplier_invoice_id=_invoice

          AND (

            r.organization_id IS DISTINCT FROM v_org

            OR r.receipt_id IS DISTINCT FROM inv.receipt_id

            OR p.id IS NULL

            OR p.order_id IS DISTINCT FROM inv.order_id

            OR p.organization_id IS DISTINCT FROM v_org            OR r.quantity >

              coalesce(p.accepted_quantity,0)
              - coalesce(p.invoiced_quantity,0)

            OR r.quantity > (

              SELECT coalesce(sum(

                greatest(

                  0,

                  coalesce(g.quantity_accepted,0)
                  -coalesce(g.quantity_returned,0)

                )

              ),0)

              FROM public.goods_receipt_lines g

              WHERE g.organization_id=v_org

                AND g.receipt_id=inv.receipt_id

                AND g.order_line_id=p.id

                AND g.stock_item_id IS NOT DISTINCT FROM p.stock_item_id

            )

          )

      ) THEN

        RAISE EXCEPTION
          'Supplier invoice reservation evidence requires reconciliation';

      END IF;

      IF (

        SELECT coalesce(sum(r.quantity),0)

        FROM public.neo_supplier_capture_line_reservations r

        WHERE r.supplier_invoice_id=_invoice

      ) IS DISTINCT FROM (

        SELECT coalesce(sum(il.quantity),0)

        FROM public.supplier_invoice_lines il

        WHERE il.supplier_invoice_id=_invoice

      ) THEN

        RAISE EXCEPTION
          'Invoice and reservation quantities do not reconcile';

      END IF;

    ELSE

      -- Legacy/direct capture: refuse ambiguous
      -- purchase order line attribution.

      IF EXISTS (

        SELECT 1

        FROM public.supplier_invoice_lines il

        WHERE il.supplier_invoice_id=_invoice

          AND (

            SELECT count(*)

            FROM public.purchase_order_lines p

            WHERE p.organization_id=v_org

              AND p.order_id=inv.order_id

              AND (

                p.stock_item_id=il.stock_item_id

                OR (

                  il.stock_item_id IS NULL

                  AND p.stock_item_id IS NULL

                  AND lower(p.description)=
                      lower(coalesce(il.description,''))

                )

              )

          ) <> 1

      ) THEN

        RAISE EXCEPTION
          'Legacy invoice requires exact purchase order line reconciliation';

      END IF;

    END IF;

  END IF;

  pol := public.neo_matching_policy(v_org, inv.branch_id);  IF inv.amount IS NULL

     OR inv.amount::text IN ('NaN','Infinity','-Infinity')

     OR inv.amount<=0

     OR inv.amount<>round(inv.amount,2)

     OR coalesce(inv.tax_amount,0)::text IN (
       'NaN','Infinity','-Infinity'
     )

     OR coalesce(inv.tax_amount,0)<0

     OR coalesce(inv.tax_amount,0)>inv.amount

  THEN

    RAISE EXCEPTION
      'Supplier invoice contains invalid financial amounts';

  END IF;

  IF EXISTS (

    SELECT 1

    FROM public.supplier_invoice_lines il

    WHERE il.supplier_invoice_id=_invoice

      AND (

        il.organization_id IS DISTINCT FROM v_org

        OR il.quantity IS NULL

        OR il.quantity<=0

        OR il.quantity::text IN (
          'NaN','Infinity','-Infinity'
        )

        OR il.net_amount IS NULL

        OR il.tax_amount IS NULL

        OR il.total_amount IS NULL

        OR il.net_amount<0

        OR il.tax_amount<0

        OR il.total_amount<0

        OR il.net_amount::text IN (
          'NaN','Infinity','-Infinity'
        )

        OR il.tax_amount::text IN (
          'NaN','Infinity','-Infinity'
        )

        OR il.total_amount IS DISTINCT FROM
           round(il.net_amount+il.tax_amount,2)

      )

  ) THEN

    RAISE EXCEPTION
      'Supplier invoice line evidence is invalid';

  END IF;

  IF (

    SELECT round(coalesce(sum(il.tax_amount),0),2)

    FROM public.supplier_invoice_lines il

    WHERE il.supplier_invoice_id=_invoice

  ) IS DISTINCT FROM round(coalesce(inv.tax_amount,0),2)

  THEN

    RAISE EXCEPTION
      'Supplier invoice tax amounts do not reconcile';

  END IF;

  v_tax := round(COALESCE(inv.tax_amount,0), 2);
  v_net := round(COALESCE(inv.amount,0) - v_tax, 2);
  IF v_net + v_tax <= 0 THEN RAISE EXCEPTION 'Invoice has no value to post'; END IF;

  v_debit_code := CASE WHEN inv.order_id IS NULL THEN pol.expense_account_code ELSE pol.grni_account_code END;
  PERFORM public.neo_finance_ensure_account(v_org, v_debit_code,
    CASE WHEN inv.order_id IS NULL THEN 'Other Operating Expenses' ELSE 'Goods Received Not Invoiced' END,
    CASE WHEN inv.order_id IS NULL THEN 'operating_expense' ELSE 'liability' END,
    CASE WHEN inv.order_id IS NULL THEN 'Operating Expenses' ELSE 'Payables' END);
  PERFORM public.neo_finance_ensure_account(v_org, pol.payable_account_code, 'Accounts Payable', 'liability', 'Payables');

  v_lines := v_lines || jsonb_build_object('code', v_debit_code, 'debit', v_net,
    'description', CASE WHEN inv.order_id IS NULL THEN 'Non-order supplier invoice' ELSE 'Clear goods received not invoiced' END);
  IF v_tax > 0 THEN
    PERFORM public.neo_finance_ensure_account(v_org, pol.tax_input_account_code, 'VAT Input (Recoverable)', 'asset', 'Tax');
    v_lines := v_lines || jsonb_build_object('code', pol.tax_input_account_code, 'debit', v_tax, 'description', 'Recoverable input tax');
  END IF;
  v_lines := v_lines || jsonb_build_object('code', pol.payable_account_code, 'credit', round(v_net + v_tax,2), 'description', 'Supplier payable');

  v_res := public.neo_gl_post(v_org, inv.branch_id, 'procurement', 'supplier_invoice', _invoice, 'payable',
    COALESCE(inv.invoice_date, public.neo_local_today(inv.branch_id)), public.neo_fact_currency(v_org, inv.branch_id),
    'Supplier invoice ' || inv.invoice_number, v_lines);  IF coalesce((v_res->>'ok')::boolean,false)
        IS NOT TRUE

     OR nullif(v_res->>'journal_id','') IS NULL

  THEN

    RAISE EXCEPTION
      'Supplier payable posting was not confirmed';

  END IF;

  IF NOT EXISTS (

    SELECT 1

    FROM public.journal_entries j

    WHERE j.id=(v_res->>'journal_id')::uuid

      AND j.organization_id=v_org

      AND j.branch_id=inv.branch_id

      AND j.status='posted'
      AND j.reverses_journal_id IS NULL AND j.reversed_by_journal_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.journal_entries reversal
        WHERE reversal.reverses_journal_id=j.id
          AND reversal.status='posted'
      )

      AND j.currency=
          public.neo_fact_currency(v_org,inv.branch_id)

      AND j.source_document_id=_invoice

      AND j.source_document_type='supplier_invoice:payable'

      AND round(j.total_debit,2)=
          round(inv.amount,2)

      AND round(j.total_credit,2)=
          round(inv.amount,2)

  ) THEN

    RAISE EXCEPTION
      'Supplier payable journal evidence does not reconcile';

  END IF;

  UPDATE supplier_invoices
     SET journal_id = (v_res->>'journal_id')::uuid,
         status = 'approved',
         match_status = CASE WHEN match_status = 'held' THEN 'approved-with-variance' ELSE match_status END,
         approved_by = auth.uid(), approved_at = now(),
         notes = COALESCE(notes,'') || CASE WHEN COALESCE(btrim(_reason),'') = '' THEN '' ELSE E'\nAccepted: ' || _reason END
   WHERE id = _invoice;

  -- Reflect what has been invoiced back onto the purchase order trail.
  IF inv.order_id IS NOT NULL THEN
        IF EXISTS (

      SELECT 1

      FROM public.neo_supplier_capture_line_reservations r

      WHERE r.supplier_invoice_id=_invoice

    ) THEN

      UPDATE public.purchase_order_lines p

      SET invoiced_quantity=
          coalesce(p.invoiced_quantity,0)+r.quantity

      FROM public.neo_supplier_capture_line_reservations r

      WHERE r.supplier_invoice_id=_invoice

        AND r.organization_id=v_org

        AND p.id=r.purchase_order_line_id

        AND p.order_id=inv.order_id

        AND p.organization_id=v_org;

    ELSE

      FOR l IN

        SELECT

          il.stock_item_id,

          CASE

            WHEN il.stock_item_id IS NULL

            THEN lower(coalesce(il.description,''))

            ELSE NULL

          END AS description_key,

          sum(il.quantity) AS quantity

        FROM public.supplier_invoice_lines il

        WHERE il.supplier_invoice_id=_invoice

        GROUP BY

          il.stock_item_id,

          CASE

            WHEN il.stock_item_id IS NULL

            THEN lower(coalesce(il.description,''))

            ELSE NULL

          END

      LOOP

        UPDATE public.purchase_order_lines p

        SET invoiced_quantity=
            coalesce(p.invoiced_quantity,0)+l.quantity

        WHERE p.order_id=inv.order_id

          AND p.organization_id=v_org

          AND (

            p.stock_item_id=l.stock_item_id

            OR (

              l.stock_item_id IS NULL

              AND p.stock_item_id IS NULL

              AND lower(p.description)=l.description_key

            )

          )

          AND coalesce(p.invoiced_quantity,0)+l.quantity

              <= coalesce(p.accepted_quantity,0);

        IF NOT FOUND THEN

          RAISE EXCEPTION
            'Legacy invoice quantity exceeds accepted order quantity';

        END IF;

      END LOOP;

    END IF;
    UPDATE purchase_orders
       SET invoiced_amount = COALESCE(invoiced_amount,0) + round(COALESCE(inv.amount,0),2),
           status = CASE WHEN status IN ('closed','cancelled','voided') THEN status
                         WHEN COALESCE(invoiced_amount,0) + COALESCE(inv.amount,0) >= COALESCE(total_amount,0) THEN 'fully-invoiced'
                         ELSE 'partially-invoiced' END
     WHERE id = inv.order_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'journal_id', v_res->>'journal_id', 'amount', round(v_net + v_tax,2));
END $$;

CREATE OR REPLACE FUNCTION public.neo_supplier_payment_advance(
  _payment uuid,
  _action text,
  _reason text DEFAULT NULL::text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  p public.supplier_payments;
  _act text := lower(btrim(coalesce(_action,'')));
  _next text;
  _amt numeric;
  _cur text;
  _cash_code text; _cash_name text;
  _res jsonb; _jid uuid; _msg text;
  _inv public.supplier_invoices;
  _paid numeric := 0;
  _other_paid numeric := 0;  _outstanding numeric := 0;  _ap_code text;

  _historical_ap_count integer;

  _historical_ap_code text;

  _bank_gl_id uuid;

  _posting_policy public.procurement_matching_policies;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'No workspace context'; END IF;
  SELECT * INTO p FROM public.supplier_payments
   WHERE id = _payment AND organization_id = _org FOR UPDATE;
  IF p.id IS NULL THEN RAISE EXCEPTION 'Supplier payment not found'; END IF;
  IF p.branch_id IS NOT NULL AND NOT public.neo_branch_in_scope(p.branch_id) THEN
    RAISE EXCEPTION 'That supplier payment belongs to a property outside your access scope' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('supplier-payment:' || _payment::text, 0));

  _next := CASE _act
    WHEN 'submit'  THEN 'awaiting-approval'
    WHEN 'approve' THEN 'approved'
    WHEN 'release' THEN 'released'
    WHEN 'settle'  THEN 'paid'
    WHEN 'fail'    THEN 'failed'
    ELSE NULL END;
  IF _next IS NULL THEN RAISE EXCEPTION 'Unknown supplier payment action "%"', _action; END IF;



  IF _act = 'approve' THEN
    IF NOT (public.has_permission('finance','payment','approve') OR public.is_org_admin()) THEN
      RAISE EXCEPTION 'Not permitted to approve supplier payments' USING ERRCODE = '42501';
    END IF;    IF p.created_by IS NULL OR p.created_by = auth.uid() THEN
      RAISE EXCEPTION 'A supplier payment cannot be approved by the person who raised it';
    END IF;
  ELSE
    IF NOT (public.has_permission('finance','ap','edit') OR public.is_org_admin()) THEN
      RAISE EXCEPTION 'Not permitted to work supplier payments' USING ERRCODE = '42501';
    END IF;
  END IF;

IF auth.uid() IS NULL
     OR public.current_access_scope() IS NULL
     OR public.current_access_scope()='technical'
  THEN

    RAISE EXCEPTION 'Operational finance payment authority required'
      USING ERRCODE='42501';

  END IF;

  IF p.status = _next AND _act <> 'settle' THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'status', p.status, 'payment_id', p.id);
  END IF;  IF _act IN ('submit','approve','release','fail')

     AND p.journal_id IS NOT NULL

  THEN

    RAISE EXCEPTION
      'A posted supplier payment requires controlled accounting recovery';

  END IF;

  IF _act = 'submit'  AND p.status NOT IN ('scheduled','draft','pending','failed')
    THEN RAISE EXCEPTION 'Only a scheduled payment can be sent for approval (currently "%")', p.status; END IF;
  IF _act = 'approve' AND p.status <> 'awaiting-approval'
    THEN RAISE EXCEPTION 'Only a payment awaiting approval can be approved (currently "%")', p.status; END IF;
  IF _act = 'release' AND p.status <> 'approved'
    THEN RAISE EXCEPTION 'Only an approved payment can be released (currently "%")', p.status; END IF;
  IF _act = 'settle'  AND p.status NOT IN ('released','paid')
    THEN RAISE EXCEPTION 'Only a released payment can be settled (currently "%")', p.status; END IF;
  IF _act = 'fail'    AND p.status NOT IN ('released','approved','awaiting-approval')
    THEN RAISE EXCEPTION 'This payment cannot be marked failed from "%"', p.status; END IF;
  IF _act = 'fail' AND nullif(btrim(coalesce(_reason,'')),'') IS NULL
    THEN RAISE EXCEPTION 'A reason is required when a supplier payment fails'; END IF;

  IF p.amount IS NULL
     OR p.amount::text IN ('NaN','Infinity','-Infinity')
     OR p.amount <= 0
     OR p.amount <> round(p.amount,2)
  THEN

    RAISE EXCEPTION 'Invalid supplier payment amount';

  END IF;

  _amt := round(coalesce(p.amount,0), 2);
  _cur := coalesce(nullif(p.currency,''), public.neo_fact_currency(_org, p.branch_id));

  IF _act = 'settle' THEN    IF _amt <= 0 THEN
      RAISE EXCEPTION 'A supplier payment with no amount cannot be settled';
    END IF;

    IF p.branch_id IS NULL

       OR p.approved_by IS NULL

       OR p.approved_at IS NULL

       OR p.approved_by IS NOT DISTINCT FROM p.created_by

    THEN

      RAISE EXCEPTION
        'Supplier settlement requires independent approved payment evidence';

    END IF;

    IF length(btrim(coalesce(p.external_reference,'')))=0
    THEN

      RAISE EXCEPTION
        'Verified external supplier payment reference required';

    END IF;    -- Serialise settlement attempts sharing a
    -- payment reference within the same organization.

    PERFORM pg_advisory_xact_lock(

      hashtextextended(

        'supplier-external-payment:' ||

        _org::text || ':' ||

        lower(btrim(p.external_reference)),

        0

      )

    );

    IF EXISTS (

      SELECT 1

      FROM public.supplier_payments duplicate_payment

      WHERE duplicate_payment.organization_id=_org

        AND duplicate_payment.id<>p.id

        AND lower(btrim(
          duplicate_payment.external_reference
        ))=lower(btrim(p.external_reference))

        AND (

          duplicate_payment.status='paid'

          OR duplicate_payment.journal_id IS NOT NULL

        )

    ) THEN

      RAISE EXCEPTION
        'External supplier payment reference already settled';

    END IF;

    _posting_policy :=
      public.neo_matching_policy(_org,p.branch_id);

    _ap_code := _posting_policy.payable_account_code;

    IF nullif(btrim(_ap_code),'') IS NULL THEN

      RAISE EXCEPTION
        'Supplier payable account is not configured';

    END IF;    -- SUPPLIER_SETTLEMENT_CLOSURE_V1

    IF p.supplier_invoice_id IS NULL THEN

      RAISE EXCEPTION
        'Supplier invoice liability is required for this settlement';

    END IF;

    IF p.supplier_invoice_id IS NOT NULL THEN
       SELECT * INTO _inv FROM public.supplier_invoices
       WHERE id = p.supplier_invoice_id AND organization_id = _org FOR UPDATE;
      IF _inv.id IS NULL THEN RAISE EXCEPTION 'The linked supplier invoice could not be found'; END IF;       IF _inv.branch_id IS DISTINCT FROM p.branch_id

          OR _inv.journal_id IS NULL

          OR _cur IS DISTINCT FROM
            public.neo_fact_currency(_org,p.branch_id)

       THEN

         RAISE EXCEPTION
           'Supplier invoice property, currency or journal mismatch';

       END IF;

       IF NOT EXISTS (

         SELECT 1

         FROM public.journal_entries j

         WHERE j.id=_inv.journal_id

           AND j.organization_id=_org

           AND j.branch_id=p.branch_id

           AND j.status='posted'
           AND j.reverses_journal_id IS NULL AND j.reversed_by_journal_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM public.journal_entries reversal
             WHERE reversal.reverses_journal_id=j.id
               AND reversal.status='posted'
           )

           AND j.currency=_cur

           AND j.source_document_id=_inv.id

           AND j.source_document_type='supplier_invoice:payable'

           AND round(j.total_credit,2)=
               round(_inv.amount,2)

       ) THEN

         RAISE EXCEPTION
           'Linked supplier invoice has no valid payable journal';

       END IF;       -- SUPPLIER_ACCOUNTING_INTEGRITY_V4

       -- Settle the actual historical liability account
       -- rather than silently using a changed policy.

       SELECT

         count(DISTINCT a.id)::integer,

         min(a.code)

       INTO

         _historical_ap_count,

         _historical_ap_code

       FROM public.journal_entry_lines jl

       JOIN public.chart_of_accounts a

         ON a.id=jl.account_id

       WHERE jl.journal_id=_inv.journal_id

         AND a.organization_id=_org

         AND a.category='liability'

         AND coalesce(jl.credit,0)>0

         AND coalesce(jl.debit,0)=0;

       IF _historical_ap_count <> 1

          OR _historical_ap_code IS NULL

       THEN

         RAISE EXCEPTION
           'Historical supplier liability account requires reconciliation';

       END IF;

       IF NOT EXISTS (

         SELECT 1

         FROM public.chart_of_accounts a

         WHERE a.organization_id=_org

           AND a.code=_historical_ap_code

           AND a.category='liability'

           AND a.active IS TRUE

           AND a.postable IS TRUE

           AND a.is_header IS NOT TRUE

       ) THEN

         RAISE EXCEPTION
           'Historical supplier liability account is not postable';

       END IF;       IF EXISTS (

         SELECT 1

         FROM public.journal_entry_lines jl

         WHERE jl.journal_id=_inv.journal_id

           AND (

             jl.organization_id IS DISTINCT FROM _org

             OR jl.branch_id IS DISTINCT FROM p.branch_id

             OR jl.debit IS NULL

             OR jl.credit IS NULL

             OR jl.debit<0

             OR jl.credit<0

             OR jl.debit::text IN (
               'NaN','Infinity','-Infinity'
             )

             OR jl.credit::text IN (
               'NaN','Infinity','-Infinity'
             )

             OR (
               jl.debit>0
               AND jl.credit>0
             )

           )

       ) THEN

         RAISE EXCEPTION
           'Historical supplier journal contains invalid accounting lines';

       END IF;

       IF (

         SELECT coalesce(sum(jl.debit),0)

         FROM public.journal_entry_lines jl

         WHERE jl.journal_id=_inv.journal_id

       ) IS DISTINCT FROM round(_inv.amount,2)

       OR (

         SELECT coalesce(sum(jl.credit),0)

         FROM public.journal_entry_lines jl

         WHERE jl.journal_id=_inv.journal_id

       ) IS DISTINCT FROM round(_inv.amount,2)

       THEN

         RAISE EXCEPTION
           'Historical supplier liability journal lines do not reconcile';

       END IF;

       _ap_code := _historical_ap_code;

       IF _inv.supplier_id IS DISTINCT FROM p.supplier_id THEN
        RAISE EXCEPTION 'The linked invoice belongs to a different supplier';
      END IF;
      IF coalesce(_inv.match_status,'') = 'held' THEN
        RAISE EXCEPTION 'The linked supplier invoice is held by matching and cannot be paid';
      END IF;
      IF _inv.approved_at IS NULL OR lower(coalesce(_inv.status,'')) NOT IN ('approved','partially_paid','paid') THEN
        RAISE EXCEPTION 'Accept and post the supplier invoice before settlement';
      END IF;       IF EXISTS (

         SELECT 1

         FROM public.supplier_payments sp

         WHERE sp.organization_id=_org

           AND sp.supplier_invoice_id=_inv.id

           AND sp.status='paid'

           AND sp.id<>p.id

           AND (

             sp.branch_id IS DISTINCT FROM p.branch_id

             OR sp.supplier_id IS DISTINCT FROM p.supplier_id

             OR sp.currency IS DISTINCT FROM _cur

             OR sp.amount IS NULL

             OR sp.amount<=0

             OR sp.amount::text IN (
               'NaN','Infinity','-Infinity'
             )

             OR sp.journal_id IS NULL

             OR NOT EXISTS (

               SELECT 1

               FROM public.journal_entries previous_journal

               WHERE previous_journal.id=sp.journal_id

                 AND previous_journal.organization_id=_org

                 AND previous_journal.branch_id=p.branch_id

                 AND previous_journal.currency=_cur

                 AND previous_journal.status='posted'

                 AND previous_journal.reversed_by_journal_id IS NULL

                 AND previous_journal.reverses_journal_id IS NULL

                 AND previous_journal.source_document_id=sp.id

                 AND previous_journal.source_document_type=
                     'supplier_payment:settlement'

                 AND round(previous_journal.total_debit,2)=
                     round(sp.amount,2)

                 AND round(previous_journal.total_credit,2)=
                     round(sp.amount,2)

                 AND NOT EXISTS (

                   SELECT 1

                   FROM public.journal_entries reversal

                   WHERE reversal.reverses_journal_id=
                         previous_journal.id

                     AND reversal.status='posted'

                 )

             )

           )

       ) THEN

         RAISE EXCEPTION
           'Previous supplier payments require accounting reconciliation';

       END IF;

       SELECT coalesce(sum(sp.amount),0) INTO _other_paid
        FROM public.supplier_payments sp
       WHERE sp.organization_id = _org
         AND sp.supplier_invoice_id = _inv.id
         AND sp.status = 'paid'
         AND sp.id <> p.id;
      _outstanding := round(greatest(coalesce(_inv.amount,0) - _other_paid, 0), 2);
      IF _amt > _outstanding + 0.009 THEN
        RAISE EXCEPTION 'This payment is % but only % remains outstanding on invoice %',
          _amt, _outstanding, _inv.invoice_number;
      END IF;
    END IF;

    IF p.journal_id IS NOT NULL
       OR EXISTS (SELECT 1 FROM public.finance_posting_receipts
                   WHERE organization_id = _org
                     AND idempotency_key = 'supplier-payment:' || _payment::text
                     AND status = 'posted') THEN       IF p.journal_id IS NULL

          OR NOT EXISTS (

            SELECT 1

            FROM public.journal_entries j

            WHERE j.id=p.journal_id

              AND j.organization_id=_org

              AND j.branch_id=p.branch_id

              AND j.status='posted'
              AND j.reverses_journal_id IS NULL AND j.reversed_by_journal_id IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM public.journal_entries reversal
                WHERE reversal.reverses_journal_id=j.id
                  AND reversal.status='posted'
              )

              AND j.currency=_cur

              AND j.source_document_id=p.id

              AND j.source_document_type='supplier_payment:settlement'

              AND round(j.total_debit,2)=_amt

              AND round(j.total_credit,2)=_amt

          )

       THEN

         RAISE EXCEPTION
           'Existing supplier payment requires journal reconciliation';

       END IF;

       UPDATE public.supplier_payments SET status = 'paid', updated_at = now() WHERE id = _payment;
      IF p.schedule_id IS NOT NULL THEN
        UPDATE public.payment_schedules SET status='paid', updated_at=now()
         WHERE id=p.schedule_id AND organization_id=_org;
      END IF;
      IF p.supplier_invoice_id IS NOT NULL THEN
        SELECT coalesce(sum(sp.amount),0) INTO _paid FROM public.supplier_payments sp
         WHERE sp.supplier_invoice_id = p.supplier_invoice_id AND sp.status = 'paid';
        UPDATE public.supplier_invoices
           SET paid_amount = round(_paid,2),
               status = CASE WHEN _paid >= round(coalesce(amount,0),2) - 0.009 THEN 'paid' ELSE 'partially_paid' END,
               updated_at = now()
         WHERE id = p.supplier_invoice_id AND organization_id = _org;
      END IF;
      RETURN jsonb_build_object('ok', true, 'idempotent', true, 'status', 'paid',
        'payment_id', p.id, 'journal_id', p.journal_id);
    END IF;

    SELECT c.code, c.name INTO _cash_code, _cash_name FROM (VALUES
        ('bank','1020','Bank Accounts'),
        ('bank_transfer','1020','Bank Accounts'),
        ('bank-transfer','1020','Bank Accounts'),
        ('transfer','1020','Bank Accounts'),
        ('eft','1020','Bank Accounts'),
        ('rtgs','1020','Bank Accounts'),
        ('cheque','1020','Bank Accounts'),
        ('check','1020','Bank Accounts'),
        ('mpesa','1030','M-Pesa Clearing'),
        ('mobile','1030','M-Pesa Clearing'),
        ('mobile_money','1030','M-Pesa Clearing'),
        ('card','1040','Card Clearing')
      ) AS c(method, code, name)
     WHERE c.method = lower(coalesce(p.method,'bank'));    IF _cash_code IS NULL
       AND lower(coalesce(p.method,'')) <> 'cash'
       AND p.bank_account_id IS NULL
    THEN
      RAISE EXCEPTION
        'Unsupported supplier settlement method';
    END IF;

    _cash_code := coalesce(_cash_code, '1010');
    _cash_name := coalesce(_cash_name, 'Cash on Hand');

    IF p.bank_account_id IS NOT NULL THEN

      SELECT

        a.id,

        a.code,

        a.name

      INTO

        _bank_gl_id,

        _cash_code,

        _cash_name

      FROM public.bank_accounts b

      JOIN public.chart_of_accounts a

        ON a.id=b.gl_account_id

      WHERE b.id=p.bank_account_id        AND b.organization_id=_org

        AND (
          b.branch_id IS NULL
          OR b.branch_id=p.branch_id
        )

        AND b.currency=_cur

        AND b.active IS TRUE

        AND a.organization_id=_org

        AND a.active IS TRUE

        AND a.postable IS TRUE

        AND a.is_header IS NOT TRUE

        AND a.category='asset'

      FOR SHARE OF b,a;

      IF _bank_gl_id IS NULL THEN

        RAISE EXCEPTION
          'Selected supplier settlement account has no active ledger mapping';

      END IF;

    ELSIF lower(coalesce(p.method,'')) IN (

      'bank','bank_transfer','bank-transfer',

      'transfer','eft','rtgs','cheque','check'

    ) THEN

      RAISE EXCEPTION
        'Bank supplier payment requires a selected bank account';

    END IF;

    BEGIN      IF _cash_code IS NOT DISTINCT FROM _ap_code THEN

        RAISE EXCEPTION
          'Settlement asset and supplier payable account must differ';

      END IF;

      PERFORM public.neo_finance_ensure_account(_org, _cash_code, _cash_name, 'asset', 'Cash and Bank');
      PERFORM public.neo_finance_ensure_account(_org, _ap_code, 'Accounts Payable', 'liability', 'Payables');

      _res := public.neo_gl_post(
        _org, p.branch_id, 'payables', 'supplier_payment', _payment, 'settlement',
        coalesce(p.paid_on, CURRENT_DATE), _cur,
        'Supplier payment ' || coalesce(nullif(p.payment_number,''), _payment::text),
        jsonb_build_array(
          jsonb_build_object('code',_ap_code,'debit', _amt, 'description','Supplier liability settled'),
          jsonb_build_object('code', _cash_code, 'credit', _amt,
            'description','Paid to supplier (' || coalesce(p.method,'bank') || ')')
        ), NULL);       _jid := nullif(_res->>'journal_id','')::uuid;

       IF coalesce((_res->>'ok')::boolean,false)
            IS NOT TRUE

          OR _jid IS NULL

       THEN

         RAISE EXCEPTION
           'Supplier settlement journal posting was not confirmed';

       END IF;

       IF NOT EXISTS (

         SELECT 1

         FROM public.journal_entries j

         WHERE j.id=_jid

           AND j.organization_id=_org

           AND j.branch_id=p.branch_id

           AND j.currency=_cur

           AND j.status='posted'
           AND j.reverses_journal_id IS NULL AND j.reversed_by_journal_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM public.journal_entries reversal
             WHERE reversal.reverses_journal_id=j.id
               AND reversal.status='posted'
           )

           AND j.source_document_id=p.id

           AND j.source_document_type='supplier_payment:settlement'

           AND round(j.total_debit,2)=_amt

           AND round(j.total_credit,2)=_amt

       ) THEN

         RAISE EXCEPTION
           'Supplier settlement journal does not reconcile';

       END IF;
    EXCEPTION WHEN OTHERS THEN
      _msg := SQLERRM;
      UPDATE public.supplier_payments SET status = 'failed', updated_at = now() WHERE id = _payment;
      IF p.schedule_id IS NOT NULL THEN
        UPDATE public.payment_schedules SET status='failed', updated_at=now()
         WHERE id=p.schedule_id AND organization_id=_org;
      END IF;
      PERFORM public.neo_record_posting_receipt(_org, p.branch_id, 'supplier-payment', _payment,
        p.payment_number, 'failed', _amt, _cur, NULL, NULL, _msg, coalesce(p.paid_on, CURRENT_DATE));
      RETURN jsonb_build_object('ok', false, 'status','failed', 'payment_id', p.id, 'detail', _msg);
    END;

    UPDATE public.supplier_payments
       SET status = 'paid', journal_id = _jid, updated_at = now()
     WHERE id = _payment;
    IF p.schedule_id IS NOT NULL THEN
      UPDATE public.payment_schedules SET status='paid', updated_at=now()
       WHERE id=p.schedule_id AND organization_id=_org;
    END IF;

    PERFORM public.neo_record_posting_receipt(_org, p.branch_id, 'supplier-payment', _payment,
      p.payment_number, CASE WHEN _jid IS NOT NULL THEN 'posted' ELSE 'blocked' END,
      _amt, _cur, NULL, _res->>'detail', NULL, coalesce(p.paid_on, CURRENT_DATE));

    PERFORM public.neo_financial_state_set(_org, p.branch_id, 'supplier-payment', _payment,
      p.payment_number, 'paid', CASE WHEN _jid IS NOT NULL THEN 'posted' ELSE 'blocked' END,
      'Paying a supplier reduces what the business owes and reduces the bank or cash account.',
      _amt, _cur, coalesce(p.paid_on, CURRENT_DATE), _jid, NULL, NULL, auth.uid(), NULL);

    IF p.supplier_invoice_id IS NOT NULL THEN
      SELECT coalesce(sum(sp.amount),0) INTO _paid FROM public.supplier_payments sp
       WHERE sp.supplier_invoice_id = p.supplier_invoice_id AND sp.status = 'paid';
      UPDATE public.supplier_invoices
         SET paid_amount = round(_paid,2),
             status = CASE WHEN _paid >= round(coalesce(amount,0),2) - 0.009 THEN 'paid' ELSE 'partially_paid' END,
             updated_at = now()
       WHERE id = p.supplier_invoice_id AND organization_id = _org;
    END IF;
  ELSE
    UPDATE public.supplier_payments
       SET status = _next,           approved_by = CASE

             WHEN _act='approve' THEN auth.uid()

             WHEN _act='submit' THEN NULL

             ELSE approved_by

           END,

           approved_at = CASE

             WHEN _act='approve' THEN now()

             WHEN _act='submit' THEN NULL

             ELSE approved_at

           END,
           updated_at = now()
     WHERE id = _payment;

    IF p.schedule_id IS NOT NULL THEN
      UPDATE public.payment_schedules
         SET status = CASE _act
           WHEN 'submit' THEN 'pending_approval'
           WHEN 'approve' THEN 'approved'
           WHEN 'release' THEN 'released'
           WHEN 'fail' THEN 'failed'
           ELSE status END,
             updated_at = now()
       WHERE id = p.schedule_id AND organization_id = _org;
    END IF;
  END IF;

  INSERT INTO public.audit_logs
    (organization_id, branch_id, user_id, action, module, record_id, previous_value, new_value, reason)
  VALUES (_org, p.branch_id, auth.uid(), 'finance.supplier_payment.' || _act, 'finance',
    _payment::text, jsonb_build_object('status', p.status),
    jsonb_build_object('status', _next, 'amount', _amt, 'journal_id', _jid),
    nullif(btrim(coalesce(_reason,'')),''));

  RETURN jsonb_build_object('ok', _act <> 'fail', 'idempotent', false, 'status', _next,
    'payment_id', p.id, 'amount', _amt, 'currency', _cur, 'journal_id', _jid);
END $function$;

-- SUPPLIER_RESERVATION_STORAGE_V1

REVOKE ALL ON TABLE
public.neo_supplier_capture_line_reservations
FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION
public.neo_supplier_capture_reservation_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog,public
AS $function$
BEGIN

    RAISE EXCEPTION
      'Supplier invoice reservation evidence is immutable';

END;
$function$;

CREATE TRIGGER
neo_supplier_capture_reservation_immutable_guard

BEFORE UPDATE OR DELETE

ON public.neo_supplier_capture_line_reservations

FOR EACH ROW

EXECUTE FUNCTION
public.neo_supplier_capture_reservation_immutable();

REVOKE ALL ON FUNCTION
public.neo_supplier_capture_reservation_immutable()
FROM PUBLIC,anon,authenticated,service_role;


-- SUPPLIER_APPROVED_EVIDENCE_V1

CREATE OR REPLACE FUNCTION
public.neo_supplier_payment_evidence_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog,public
AS $function$
BEGIN

    IF TG_OP='DELETE' THEN

        IF OLD.journal_id IS NOT NULL

           OR OLD.approved_at IS NOT NULL

           OR OLD.status IN (
               'approved','released','paid'
           )

        THEN

            RAISE EXCEPTION
                'Approved supplier payment evidence cannot be deleted';

        END IF;

        RETURN OLD;

    END IF;

    IF OLD.journal_id IS NOT NULL

       OR OLD.status IN (
           'approved','released','paid'
       )

       OR (
           OLD.approved_at IS NOT NULL
           AND OLD.status IS DISTINCT FROM 'failed'
       )

    THEN

        IF NEW.organization_id IS DISTINCT FROM OLD.organization_id

           OR NEW.branch_id IS DISTINCT FROM OLD.branch_id

           OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id

           OR NEW.supplier_invoice_id IS DISTINCT FROM OLD.supplier_invoice_id

           OR NEW.schedule_id IS DISTINCT FROM OLD.schedule_id

           OR NEW.amount IS DISTINCT FROM OLD.amount

           OR NEW.currency IS DISTINCT FROM OLD.currency

           OR NEW.method IS DISTINCT FROM OLD.method

           OR NEW.bank_account_id IS DISTINCT FROM OLD.bank_account_id

           OR NEW.created_by IS DISTINCT FROM OLD.created_by

           OR NEW.payment_number IS DISTINCT FROM OLD.payment_number

        THEN

            RAISE EXCEPTION
                'Approved supplier payment details are immutable';

        END IF;

    END IF;

    IF OLD.journal_id IS NOT NULL THEN

        IF NEW.journal_id IS DISTINCT FROM OLD.journal_id

           OR NEW.external_reference IS DISTINCT FROM OLD.external_reference

           OR NEW.paid_on IS DISTINCT FROM OLD.paid_on

           OR NEW.approved_at IS DISTINCT FROM OLD.approved_at

           OR NEW.approved_by IS DISTINCT FROM OLD.approved_by

           OR NEW.status IS DISTINCT FROM OLD.status

        THEN

            RAISE EXCEPTION
                'Posted supplier payment evidence is immutable';

        END IF;

    END IF;

    IF OLD.status='failed'

       AND OLD.journal_id IS NULL

       AND (

           NEW.amount IS DISTINCT FROM OLD.amount

           OR NEW.bank_account_id IS DISTINCT FROM OLD.bank_account_id

           OR NEW.supplier_invoice_id IS DISTINCT FROM OLD.supplier_invoice_id

           OR NEW.method IS DISTINCT FROM OLD.method

           OR NEW.currency IS DISTINCT FROM OLD.currency

       )

    THEN

        IF NEW.status NOT IN ('failed','draft','scheduled')

           OR NEW.approved_by IS NOT NULL

           OR NEW.approved_at IS NOT NULL

        THEN

            RAISE EXCEPTION
                'Changed failed supplier payment requires fresh approval';

        END IF;

    END IF;

    RETURN NEW;

END;
$function$;

CREATE TRIGGER
neo_supplier_payment_evidence_guard_trigger

BEFORE UPDATE OR DELETE

ON public.supplier_payments

FOR EACH ROW

EXECUTE FUNCTION
public.neo_supplier_payment_evidence_guard();

REVOKE ALL ON FUNCTION
public.neo_supplier_payment_evidence_guard()
FROM PUBLIC,anon,authenticated,service_role;


-- Protect the original supplier invoice liability.

CREATE OR REPLACE FUNCTION
public.neo_supplier_invoice_posted_evidence_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog,public
AS $function$
BEGIN

    IF TG_OP='DELETE' THEN

        IF OLD.journal_id IS NOT NULL THEN

            RAISE EXCEPTION
                'Posted supplier invoice cannot be deleted';

        END IF;

        RETURN OLD;

    END IF;

    IF OLD.journal_id IS NOT NULL THEN

        IF NEW.organization_id IS DISTINCT FROM OLD.organization_id

           OR NEW.branch_id IS DISTINCT FROM OLD.branch_id

           OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id

           OR NEW.order_id IS DISTINCT FROM OLD.order_id

           OR NEW.receipt_id IS DISTINCT FROM OLD.receipt_id

           OR NEW.invoice_number IS DISTINCT FROM OLD.invoice_number

           OR NEW.invoice_date IS DISTINCT FROM OLD.invoice_date

           OR NEW.amount IS DISTINCT FROM OLD.amount

           OR NEW.tax_amount IS DISTINCT FROM OLD.tax_amount

           OR NEW.journal_id IS DISTINCT FROM OLD.journal_id

           OR NEW.created_by IS DISTINCT FROM OLD.created_by

           OR NEW.approved_by IS DISTINCT FROM OLD.approved_by

           OR NEW.approved_at IS DISTINCT FROM OLD.approved_at

        THEN

            RAISE EXCEPTION
                'Posted supplier invoice evidence is immutable';

        END IF;

    END IF;

    RETURN NEW;

END;
$function$;

CREATE TRIGGER
neo_supplier_invoice_posted_evidence_guard_trigger

BEFORE UPDATE OR DELETE

ON public.supplier_invoices

FOR EACH ROW

EXECUTE FUNCTION
public.neo_supplier_invoice_posted_evidence_guard();

REVOKE ALL ON FUNCTION
public.neo_supplier_invoice_posted_evidence_guard()
FROM PUBLIC,anon,authenticated,service_role;


-- Protect invoice line evidence after financial posting.

CREATE OR REPLACE FUNCTION
public.neo_supplier_invoice_line_evidence_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog,public
AS $function$
DECLARE

    v_invoice uuid;

    v_invoices uuid[];

    v_journal uuid;

BEGIN

    IF TG_OP='INSERT' THEN

        v_invoices := ARRAY[NEW.supplier_invoice_id];

    ELSIF TG_OP='DELETE' THEN

        v_invoices := ARRAY[OLD.supplier_invoice_id];

    ELSE

        v_invoices := ARRAY[
            OLD.supplier_invoice_id,
            NEW.supplier_invoice_id
        ];

    END IF;

    FOR v_invoice IN

        SELECT DISTINCT invoice_id

        FROM unnest(v_invoices) AS x(invoice_id)

        WHERE invoice_id IS NOT NULL

        ORDER BY invoice_id

    LOOP

        SELECT i.journal_id

        INTO v_journal

        FROM public.supplier_invoices i

        WHERE i.id=v_invoice

        FOR UPDATE;

        IF NOT FOUND THEN

            RAISE EXCEPTION
                'Supplier invoice line has no valid parent';

        END IF;

        IF v_journal IS NOT NULL THEN

            RAISE EXCEPTION
                'Posted supplier invoice lines are immutable';

        END IF;

    END LOOP;

    IF TG_OP='DELETE' THEN

        RETURN OLD;

    END IF;

    RETURN NEW;

END;
$function$;

CREATE TRIGGER
neo_supplier_invoice_line_evidence_guard_trigger

BEFORE INSERT OR UPDATE OR DELETE

ON public.supplier_invoice_lines

FOR EACH ROW

EXECUTE FUNCTION
public.neo_supplier_invoice_line_evidence_guard();

REVOKE ALL ON FUNCTION
public.neo_supplier_invoice_line_evidence_guard()
FROM PUBLIC,anon,authenticated,service_role;


-- SUPPLIER_UNIFIED_CAPTURE_BOUNDARY_V1

CREATE OR REPLACE FUNCTION
public.neo_supplier_capture_order_boundary(
    _org uuid,
    _branch uuid,
    _supplier uuid,
    _order uuid,
    _receipt uuid,
    _lines jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog,public
AS $function$
DECLARE

    po public.purchase_orders%ROWTYPE;

    ln jsonb;

    po_line public.purchase_order_lines%ROWTYPE;

    line_id uuid;

    stock_id uuid;

    qty numeric;

    candidate_count integer;

    seen uuid[] := ARRAY[]::uuid[];

    accepted numeric;

    reserved numeric;

    pending numeric;

BEGIN

    IF auth.uid() IS NULL

       OR _org IS DISTINCT FROM public.current_org_id()

       OR public.current_access_scope() IS NULL

       OR public.current_access_scope()='technical'

       OR public.neo_branch_in_scope(_branch) IS NOT TRUE

       OR NOT coalesce(
           public.has_permission('finance','edit')
           OR public.is_org_admin(),
           false
       )

    THEN

        RAISE EXCEPTION
            'Operational supplier capture authority required'
            USING ERRCODE='42501';

    END IF;

    IF jsonb_typeof(_lines) IS DISTINCT FROM 'array'
       OR jsonb_array_length(_lines)=0
       OR jsonb_array_length(_lines)>500
    THEN

        RAISE EXCEPTION
            'Supplier capture requires valid invoice lines';

    END IF;

    IF _order IS NULL THEN

        IF _receipt IS NOT NULL THEN

            RAISE EXCEPTION
                'Goods receipt requires its original purchase order';

        END IF;

        RETURN;

    END IF;

    SELECT *

    INTO po

    FROM public.purchase_orders p

    WHERE p.id=_order

      AND p.organization_id=_org

      AND p.branch_id=_branch

      AND p.supplier_id=_supplier

    FOR UPDATE;

    IF po.id IS NULL

       OR po.status IS NULL

       OR po.status NOT IN (

           'approved','issued','sent','ordered',

           'partially-received','received',

           'completed','closed',

           'partially-invoiced','fully-invoiced'

       )

    THEN

        RAISE EXCEPTION
            'Approved purchase order required for invoice capture';

    END IF;

    IF _receipt IS NULL THEN

        RAISE EXCEPTION
            'Purchase order invoice requires a posted goods receipt';

    END IF;

    PERFORM 1

    FROM public.goods_receipts g

    WHERE g.id=_receipt

      AND g.organization_id=_org

      AND g.branch_id=_branch

      AND g.supplier_id=_supplier

      AND g.order_id=_order

      AND g.status='posted'

    FOR UPDATE;

    IF NOT FOUND THEN

        RAISE EXCEPTION
            'Goods receipt is unavailable for this supplier order';

    END IF;

    -- Historical invoices with no exact reservation
    -- must be reconciled rather than silently ignored.

    IF EXISTS (

        SELECT 1

        FROM public.supplier_invoices i

        WHERE i.organization_id=_org

          AND i.order_id=_order

          AND (

              i.status NOT IN (
                  'cancelled','voided','rejected'
              )

              OR i.journal_id IS NOT NULL

          )

          AND (

              i.approved_at IS NULL

              OR i.receipt_id=_receipt

          )

          AND NOT EXISTS (

              SELECT 1

              FROM public.neo_supplier_capture_line_reservations r

              WHERE r.organization_id=_org

                AND r.supplier_invoice_id=i.id

          )

    ) THEN

        RAISE EXCEPTION
            'Existing supplier invoice requires quantity reconciliation before additional capture';

    END IF;

    FOR ln IN

        SELECT value

        FROM jsonb_array_elements(_lines)

    LOOP

        IF jsonb_typeof(ln) IS DISTINCT FROM 'object' THEN

            RAISE EXCEPTION
                'Invalid supplier invoice line';

        END IF;

        qty := nullif(ln->>'quantity','')::numeric;

        stock_id := nullif(ln->>'stock_item_id','')::uuid;

        line_id := nullif(
            ln->>'purchase_order_line_id',''
        )::uuid;

        IF qty IS NULL

           OR qty<=0

           OR qty>100000000

           OR qty::text IN (
               'NaN','Infinity','-Infinity'
           )

        THEN

            RAISE EXCEPTION
                'Invalid supplier invoice quantity';

        END IF;

        -- Existing finance forms may identify only
        -- the stock item rather than the exact PO line.

        IF line_id IS NULL THEN

            SELECT count(*)::integer

            INTO candidate_count

            FROM public.purchase_order_lines p

            WHERE p.organization_id=_org

              AND p.order_id=_order

              AND p.stock_item_id IS NOT DISTINCT FROM stock_id

              AND (

                  stock_id IS NOT NULL

                  OR lower(btrim(p.description))=

                     lower(btrim(coalesce(
                         ln->>'description',''
                     )))

              );

            IF candidate_count<>1 THEN

                RAISE EXCEPTION
                    'Select the exact purchase order line for this invoice item';

            END IF;

            SELECT p.id

            INTO line_id

            FROM public.purchase_order_lines p

            WHERE p.organization_id=_org

              AND p.order_id=_order

              AND p.stock_item_id IS NOT DISTINCT FROM stock_id

              AND (

                  stock_id IS NOT NULL

                  OR lower(btrim(p.description))=

                     lower(btrim(coalesce(
                         ln->>'description',''
                     )))

              );

        END IF;

        IF line_id=ANY(seen) THEN

            RAISE EXCEPTION
                'Duplicate purchase order line in supplier invoice';

        END IF;

        seen := array_append(seen,line_id);

        SELECT *

        INTO po_line

        FROM public.purchase_order_lines p

        WHERE p.id=line_id

          AND p.organization_id=_org

          AND p.order_id=_order

        FOR UPDATE;

        IF po_line.id IS NULL

           OR po_line.stock_item_id IS DISTINCT FROM stock_id

        THEN

            RAISE EXCEPTION
                'Invoice item does not match the original purchase order line';

        END IF;

        SELECT coalesce(sum(

            greatest(

                0,

                coalesce(g.quantity_accepted,0)

                -coalesce(g.quantity_returned,0)

            )

        ),0)

        INTO accepted

        FROM public.goods_receipt_lines g

        WHERE g.organization_id=_org

          AND g.receipt_id=_receipt

          AND g.order_line_id=line_id

          AND g.stock_item_id IS NOT DISTINCT FROM stock_id;

        SELECT coalesce(sum(r.quantity),0)

        INTO reserved

        FROM public.neo_supplier_capture_line_reservations r

        JOIN public.supplier_invoices i

          ON i.id=r.supplier_invoice_id

        WHERE r.organization_id=_org

          AND i.organization_id=_org

          AND r.receipt_id=_receipt

          AND r.purchase_order_line_id=line_id

          AND (

              i.status NOT IN (
                  'cancelled','voided','rejected'
              )

              OR i.journal_id IS NOT NULL

          );

        IF qty>accepted-reserved THEN

            RAISE EXCEPTION
                'Invoice exceeds remaining accepted goods receipt quantity';

        END IF;

        SELECT coalesce(sum(r.quantity),0)

        INTO pending

        FROM public.neo_supplier_capture_line_reservations r

        JOIN public.supplier_invoices i

          ON i.id=r.supplier_invoice_id

        WHERE r.organization_id=_org

          AND i.organization_id=_org

          AND r.purchase_order_line_id=line_id

          AND i.approved_at IS NULL

          AND (

              i.status NOT IN (
                  'cancelled','voided','rejected'
              )

              OR i.journal_id IS NOT NULL

          );

        IF qty >

           coalesce(po_line.accepted_quantity,0)

           -coalesce(po_line.invoiced_quantity,0)

           -pending

        THEN

            RAISE EXCEPTION
                'Invoice exceeds unreserved accepted purchase order quantity';

        END IF;

    END LOOP;

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_supplier_capture_order_boundary(
    uuid,uuid,uuid,uuid,uuid,jsonb
)
FROM PUBLIC,anon,authenticated,service_role;


CREATE OR REPLACE FUNCTION
public.neo_supplier_capture_reservation_authority(
    _org uuid,
    _branch uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog,public
AS $function$
BEGIN

    IF auth.uid() IS NULL
       OR _org IS DISTINCT FROM public.current_org_id()
       OR public.current_access_scope() IS NULL
       OR public.current_access_scope()='technical'
       OR public.neo_branch_in_scope(_branch) IS NOT TRUE
       OR NOT coalesce(
           public.has_permission('finance','edit')
           OR public.is_org_admin(),
           false
       )
    THEN
        RAISE EXCEPTION
          'Operational supplier reservation authority required'
          USING ERRCODE='42501';
    END IF;

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_supplier_capture_reservation_authority(uuid,uuid)
FROM PUBLIC,anon,authenticated,service_role;


-- SUPPLIER_CANONICAL_RESERVATIONS_V1

ALTER TABLE public.neo_supplier_capture_line_reservations
ALTER COLUMN submission_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION
public.neo_supplier_capture_reservations_record(
    _invoice uuid,
    _lines jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog,public
AS $function$
DECLARE
    inv public.supplier_invoices%ROWTYPE;
    po_line public.purchase_order_lines%ROWTYPE;
    ln jsonb;
    line_id uuid;
    stock_id uuid;
    qty numeric;
    candidate_count integer;
    seen uuid[] := ARRAY[]::uuid[];
BEGIN

    SELECT *
    INTO inv
    FROM public.supplier_invoices i
    WHERE i.id=_invoice
      AND i.organization_id=public.current_org_id()
    FOR UPDATE;

    IF inv.id IS NULL
       OR inv.journal_id IS NOT NULL
       OR inv.status IS DISTINCT FROM 'draft'
    THEN
        RAISE EXCEPTION
          'Valid draft supplier invoice required for reservation';
    END IF;

    IF inv.order_id IS NULL THEN

        IF inv.receipt_id IS NOT NULL THEN
            RAISE EXCEPTION
              'Invoice receipt requires its purchase order';
        END IF;

        RETURN;
    END IF;

    PERFORM public.neo_supplier_capture_reservation_authority(
        inv.organization_id,
        inv.branch_id
    );

    PERFORM 1
    FROM public.purchase_orders p
    WHERE p.id=inv.order_id
      AND p.organization_id=inv.organization_id
      AND p.branch_id=inv.branch_id
      AND p.supplier_id=inv.supplier_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
          'Original purchase order unavailable';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.neo_supplier_capture_line_reservations r
        WHERE r.supplier_invoice_id=inv.id
    ) THEN
        RAISE EXCEPTION
          'Supplier invoice reservation evidence already exists';
    END IF;

    IF jsonb_typeof(_lines) IS DISTINCT FROM 'array'
       OR jsonb_array_length(_lines)=0
    THEN
        RAISE EXCEPTION
          'Invoice reservation requires captured lines';
    END IF;

    FOR ln IN
        SELECT value
        FROM jsonb_array_elements(_lines)
    LOOP

        line_id := nullif(
            ln->>'purchase_order_line_id',''
        )::uuid;

        stock_id := nullif(
            ln->>'stock_item_id',''
        )::uuid;

        qty := nullif(
            ln->>'quantity',''
        )::numeric;

        IF qty IS NULL
           OR qty<=0
           OR qty>100000000
           OR qty::text IN (
               'NaN','Infinity','-Infinity'
           )
        THEN
            RAISE EXCEPTION
              'Invalid supplier reservation quantity';
        END IF;

        IF line_id IS NULL THEN

            SELECT count(*)::integer
            INTO candidate_count
            FROM public.purchase_order_lines p
            WHERE p.organization_id=inv.organization_id
              AND p.order_id=inv.order_id
              AND p.stock_item_id IS NOT DISTINCT FROM stock_id
              AND (
                  stock_id IS NOT NULL
                  OR lower(btrim(p.description))=
                     lower(btrim(coalesce(
                         ln->>'description',''
                     )))
              );

            IF candidate_count<>1 THEN
                RAISE EXCEPTION
                  'Exact purchase order line required for reservation';
            END IF;

            SELECT p.id
            INTO line_id
            FROM public.purchase_order_lines p
            WHERE p.organization_id=inv.organization_id
              AND p.order_id=inv.order_id
              AND p.stock_item_id IS NOT DISTINCT FROM stock_id
              AND (
                  stock_id IS NOT NULL
                  OR lower(btrim(p.description))=
                     lower(btrim(coalesce(
                         ln->>'description',''
                     )))
              );

        END IF;

        IF line_id=ANY(seen) THEN
            RAISE EXCEPTION
              'Duplicate supplier reservation line';
        END IF;

        seen := array_append(seen,line_id);

        SELECT *
        INTO po_line
        FROM public.purchase_order_lines p
        WHERE p.id=line_id
          AND p.organization_id=inv.organization_id
          AND p.order_id=inv.order_id
        FOR UPDATE;

        IF po_line.id IS NULL
           OR po_line.stock_item_id
               IS DISTINCT FROM stock_id
        THEN
            RAISE EXCEPTION
              'Supplier reservation stock identity mismatch';
        END IF;

        INSERT INTO public.neo_supplier_capture_line_reservations(
            organization_id,
            submission_id,
            supplier_invoice_id,
            receipt_id,
            purchase_order_line_id,
            quantity
        )
        VALUES(
            inv.organization_id,
            NULL,
            inv.id,
            inv.receipt_id,
            line_id,
            qty
        );

    END LOOP;

    -- Confirm that recorded quantities equal the
    -- captured invoice quantities by stock identity.

    IF EXISTS (

        WITH captured AS (

            SELECT
                il.stock_item_id,
                sum(il.quantity) quantity
            FROM public.supplier_invoice_lines il
            WHERE il.supplier_invoice_id=inv.id
              AND il.organization_id=inv.organization_id
            GROUP BY il.stock_item_id

        ), reserved AS (

            SELECT
                p.stock_item_id,
                sum(r.quantity) quantity
            FROM public.neo_supplier_capture_line_reservations r
            JOIN public.purchase_order_lines p
              ON p.id=r.purchase_order_line_id
             AND p.organization_id=r.organization_id
            WHERE r.supplier_invoice_id=inv.id
              AND r.organization_id=inv.organization_id
            GROUP BY p.stock_item_id

        )

        SELECT 1
        FROM captured c
        WHERE c.quantity IS DISTINCT FROM (

            SELECT r.quantity
            FROM reserved r
            WHERE r.stock_item_id
                  IS NOT DISTINCT FROM c.stock_item_id

        )

    ) THEN
        RAISE EXCEPTION
          'Captured invoice and reservation quantities disagree';
    END IF;

    IF (
        SELECT coalesce(sum(il.quantity),0)
        FROM public.supplier_invoice_lines il
        WHERE il.supplier_invoice_id=inv.id
    ) IS DISTINCT FROM (
        SELECT coalesce(sum(r.quantity),0)
        FROM public.neo_supplier_capture_line_reservations r
        WHERE r.supplier_invoice_id=inv.id
    ) THEN
        RAISE EXCEPTION
          'Supplier reservation total quantity mismatch';
    END IF;

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_supplier_capture_reservations_record(uuid,jsonb)
FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.neo_supplier_invoice_capture(_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_org uuid := current_org_id();
  v_branch uuid := NULLIF(_payload->>'branch_id','')::uuid;
  v_supplier uuid := NULLIF(_payload->>'supplier_id','')::uuid;
  v_number text := btrim(COALESCE(_payload->>'invoice_number',''));
  v_id uuid; ln jsonb; i integer := 0;
  v_net numeric := 0; v_tax numeric := 0; v_total numeric := 0;
  v_q numeric; v_p numeric; v_lt numeric; v_ltax numeric;
BEGIN

  PERFORM public.neo_supplier_capture_order_boundary(

      v_org,

      nullif(_payload->>'branch_id','')::uuid,

      nullif(_payload->>'supplier_id','')::uuid,

      nullif(_payload->>'order_id','')::uuid,

      nullif(_payload->>'receipt_id','')::uuid,

      _payload->'lines'

  );


  IF v_org IS NULL THEN RAISE EXCEPTION 'No active organization'; END IF;
  IF NOT (has_permission('finance','edit') OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to capture supplier invoices';
  END IF;
  IF v_branch IS NULL OR NOT public.neo_branch_in_scope(v_branch) THEN
    RAISE EXCEPTION 'Property is required and must be in scope' USING ERRCODE='42501'; END IF;
  IF v_supplier IS NULL OR NOT EXISTS (SELECT 1 FROM public.suppliers s
      WHERE s.id=v_supplier AND s.organization_id=v_org AND s.active IS TRUE
        AND (s.branch_id IS NULL OR s.branch_id=v_branch)) THEN
    RAISE EXCEPTION 'Supplier is not active at this property' USING ERRCODE='22023'; END IF;
  IF _payload->>'order_id' IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.purchase_orders po WHERE po.id=(_payload->>'order_id')::uuid
      AND po.organization_id=v_org AND po.branch_id=v_branch AND po.supplier_id=v_supplier
      AND po.status NOT IN ('cancelled','voided')) THEN
    RAISE EXCEPTION 'Order does not match property and supplier' USING ERRCODE='22023'; END IF;
  IF _payload->>'receipt_id' IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.goods_receipts gr WHERE gr.id=(_payload->>'receipt_id')::uuid
      AND gr.organization_id=v_org AND gr.branch_id=v_branch AND gr.supplier_id=v_supplier
      AND gr.order_id IS NOT DISTINCT FROM NULLIF(_payload->>'order_id','')::uuid
      AND gr.status='posted') THEN
    RAISE EXCEPTION 'Receipt does not match a posted delivery for this order' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(_payload->'lines') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Invoice lines must be an array' USING ERRCODE='22023'; END IF;
  IF v_number = '' THEN RAISE EXCEPTION 'Supplier invoice number is required'; END IF;

  IF COALESCE((_payload->>'allow_duplicate')::boolean, false) = false
     AND EXISTS (SELECT 1 FROM supplier_invoices si
                  WHERE si.organization_id = v_org AND si.supplier_id = v_supplier
                    AND lower(btrim(si.invoice_number)) = lower(v_number)) THEN
    RAISE EXCEPTION 'Invoice % already captured for this supplier', v_number;
  END IF;

  INSERT INTO supplier_invoices (organization_id, branch_id, supplier_id, order_id, receipt_id,
    invoice_number, invoice_date, due_date, amount, tax_amount, status, match_status, notes, created_by)
  VALUES (v_org, v_branch, v_supplier,
    NULLIF(_payload->>'order_id','')::uuid,
    NULLIF(_payload->>'receipt_id','')::uuid,
    v_number,
    COALESCE(NULLIF(_payload->>'invoice_date','')::date, CURRENT_DATE),
    NULLIF(_payload->>'due_date','')::date,
    0, 0, 'draft', 'pending', NULLIF(_payload->>'notes',''), auth.uid())
  RETURNING id INTO v_id;

  FOR ln IN SELECT * FROM jsonb_array_elements(COALESCE(_payload->'lines','[]'::jsonb)) LOOP
    i := i + 1;
    v_q := COALESCE((ln->>'quantity')::numeric, 0);
    v_p := COALESCE((ln->>'unit_price')::numeric, 0);
    IF v_q <= 0 OR v_p < 0 OR v_q > 100000000 OR v_p > 100000000
      OR COALESCE((ln->>'discount_amount')::numeric,0) < 0
      OR COALESCE((ln->>'discount_amount')::numeric,0) > v_q*v_p
      OR COALESCE((ln->>'tax_amount')::numeric,0) < 0
      OR COALESCE((ln->>'tax_amount')::numeric,0) > v_q*v_p THEN
      RAISE EXCEPTION 'Invalid invoice quantity, price, discount or tax' USING ERRCODE='22023'; END IF;
    IF NULLIF(ln->>'stock_item_id','') IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.stock_items si WHERE si.id=(ln->>'stock_item_id')::uuid
        AND si.organization_id=v_org) THEN
      RAISE EXCEPTION 'Invoice item belongs to another organization' USING ERRCODE='42501'; END IF;
    v_lt := round(v_q * v_p - COALESCE((ln->>'discount_amount')::numeric,0), 2);
    v_ltax := round(COALESCE((ln->>'tax_amount')::numeric, 0), 2);
    INSERT INTO supplier_invoice_lines (organization_id, supplier_invoice_id, line_number, description,
      stock_item_id, expense_account_id, department_id, quantity, unit_price, tax_amount, net_amount, total_amount)
    VALUES (v_org, v_id, i, NULLIF(ln->>'description',''),
      NULLIF(ln->>'stock_item_id','')::uuid,
      NULLIF(ln->>'expense_account_id','')::uuid,
      NULLIF(ln->>'department_id','')::uuid,
      v_q, v_p, v_ltax, v_lt, v_lt + v_ltax);
    v_net := v_net + v_lt; v_tax := v_tax + v_ltax;
  END LOOP;

  IF i = 0 THEN RAISE EXCEPTION 'At least one invoice line is required'; END IF;
  v_total := round(v_net + v_tax, 2);

  UPDATE supplier_invoices SET amount = v_total, tax_amount = round(v_tax,2) WHERE id = v_id;


    PERFORM public.neo_supplier_capture_reservations_record(
        v_id,
        _payload->'lines'
    );
RETURN jsonb_build_object('ok', true, 'invoice_id', v_id, 'amount', v_total,
    'match', public.proc_three_way_match(v_id));
END $$;