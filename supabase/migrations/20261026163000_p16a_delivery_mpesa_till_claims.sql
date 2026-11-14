-- ============================================================
-- NEØ P1.6A - DELIVERY M-PESA TILL PAYMENT CLAIMS
-- LOCAL DRAFT - NOT DEPLOYED
--
-- Customer-submitted codes are UNVERIFIED payment claims.
-- This migration does NOT post payments, journals or invoices.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.delivery_mpesa_till_claims (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    delivery_order_id uuid NOT NULL
        REFERENCES public.delivery_orders(id),
    receipt_code text NOT NULL,
    status text NOT NULL DEFAULT 'submitted'
        CHECK (status IN ('submitted', 'merchant_verified', 'rejected')),
    submitted_by uuid NOT NULL,
    submitted_at timestamptz NOT NULL DEFAULT now(),
    reviewed_by uuid,
    reviewed_at timestamptz,
    review_note text,

    CONSTRAINT delivery_mpesa_till_receipt_uq
        UNIQUE (organization_id, receipt_code),

    CONSTRAINT delivery_mpesa_till_order_receipt_uq
        UNIQUE (delivery_order_id, receipt_code),

    CONSTRAINT delivery_mpesa_till_receipt_format
        CHECK (receipt_code ~ '^[A-Z0-9]{10,12}$')
);

CREATE INDEX IF NOT EXISTS delivery_mpesa_till_claims_queue_idx
ON public.delivery_mpesa_till_claims (
    organization_id,
    branch_id,
    status,
    submitted_at
);

ALTER TABLE public.delivery_mpesa_till_claims
ENABLE ROW LEVEL SECURITY;

-- Direct client table access is deliberately not granted.
-- Customers submit claims only through the ownership-checked RPC.
REVOKE ALL ON public.delivery_mpesa_till_claims
FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.neo_delivery_mpesa_till_claim_submit(
    _order uuid,
    _receipt text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
    d public.delivery_orders;
    v_code text;
    v_claim uuid;
    v_existing public.delivery_mpesa_till_claims;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING ERRCODE = '42501';
    END IF;

    v_code := upper(
        regexp_replace(
            coalesce(_receipt, ''),
            '[^A-Za-z0-9]',
            '',
            'g'
        )
    );

    IF v_code !~ '^[A-Z0-9]{10,12}$' THEN
        RETURN jsonb_build_object(
            'ok', false,
            'reason', 'invalid_receipt',
            'detail', 'Enter a valid M-PESA transaction code.'
        );
    END IF;

    SELECT *
      INTO d
      FROM public.delivery_orders
     WHERE id = _order
     FOR UPDATE;

    IF d.id IS NULL
       OR d.organization_id IS DISTINCT FROM public.current_org_id()
       OR public.customer_owns_delivery(d.id) IS NOT TRUE
    THEN
        RETURN jsonb_build_object(
            'ok', false,
            'reason', 'order_not_found'
        );
    END IF;

    IF lower(coalesce(d.payment_method, '')) <> 'mpesa' THEN
        RETURN jsonb_build_object(
            'ok', false,
            'reason', 'wrong_payment_method'
        );
    END IF;

    IF lower(coalesce(d.payment_status, '')) IN
        ('paid', 'settled', 'completed', 'refunded', 'voided')
    THEN
        RETURN jsonb_build_object(
            'ok', false,
            'reason', 'payment_not_required'
        );
    END IF;

    IF lower(coalesce(d.order_status, '')) IN
        ('cancelled', 'rejected', 'failed')
    THEN
        RETURN jsonb_build_object(
            'ok', false,
            'reason', 'order_closed'
        );
    END IF;

    SELECT *
      INTO v_existing
      FROM public.delivery_mpesa_till_claims
     WHERE organization_id = d.organization_id
       AND receipt_code = v_code
     LIMIT 1;

    IF v_existing.id IS NOT NULL THEN
        IF v_existing.delivery_order_id = d.id THEN
            RETURN jsonb_build_object(
                'ok', true,
                'already_submitted', true,
                'claim_id', v_existing.id,
                'status', v_existing.status
            );
        END IF;

        RETURN jsonb_build_object(
            'ok', false,
            'reason', 'receipt_already_submitted',
            'detail', 'This reference has already been submitted.'
        );
    END IF;

    INSERT INTO public.delivery_mpesa_till_claims (
        organization_id,
        branch_id,
        delivery_order_id,
        receipt_code,
        submitted_by
    )
    VALUES (
        d.organization_id,
        d.branch_id,
        d.id,
        v_code,
        auth.uid()
    )
    RETURNING id INTO v_claim;

    RETURN jsonb_build_object(
        'ok', true,
        'claim_id', v_claim,
        'status', 'submitted',
        'payment_verified', false,
        'detail',
        'Your M-PESA reference has been submitted for hotel verification.'
    );

EXCEPTION
    WHEN unique_violation THEN
        RETURN jsonb_build_object(
            'ok', false,
            'reason', 'receipt_already_submitted',
            'detail', 'This transaction reference is already registered.'
        );
END;
$function$;

REVOKE ALL ON FUNCTION
    public.neo_delivery_mpesa_till_claim_submit(uuid, text)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
    public.neo_delivery_mpesa_till_claim_submit(uuid, text)
TO authenticated;

-- Finance-only review queue.
-- Reading a claim is not payment verification.

CREATE OR REPLACE FUNCTION public.neo_delivery_mpesa_till_claim_queue()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
    v_org uuid := public.current_org_id();
    v_result jsonb;
BEGIN
    IF v_org IS NULL
       OR NOT (
           public.is_org_admin_for(v_org)
           OR public.has_permission('finance', 'approve')
           OR public.has_permission('pos', 'payments', 'manual-confirm')
       )
    THEN
        RAISE EXCEPTION 'Finance payment review permission required'
            USING ERRCODE = '42501';
    END IF;

    SELECT coalesce(
        jsonb_agg(
            jsonb_build_object(
                'claim_id', c.id,
                'delivery_order_id', c.delivery_order_id,
                'order_number', d.order_number,
                'receipt_code', c.receipt_code,
                'order_total', d.grand_total,
                'payment_status', d.payment_status,
                'claim_status', c.status,
                'submitted_at', c.submitted_at,
                'branch_id', c.branch_id
            )
            ORDER BY c.submitted_at DESC
        ),
        '[]'::jsonb
    )
    INTO v_result
    FROM public.delivery_mpesa_till_claims c
    JOIN public.delivery_orders d
      ON d.id = c.delivery_order_id
     AND d.organization_id = c.organization_id
    WHERE c.organization_id = v_org
      AND c.status = 'submitted'
      AND public.neo_branch_in_scope(c.branch_id);

    RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION
    public.neo_delivery_mpesa_till_claim_queue()
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
    public.neo_delivery_mpesa_till_claim_queue()
TO authenticated;
