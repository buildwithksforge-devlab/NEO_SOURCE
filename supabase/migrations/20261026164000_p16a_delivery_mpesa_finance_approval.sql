-- ============================================================
-- NEO P1.6A - FINANCE APPROVAL FOR DELIVERY M-PESA TILL
-- LOCAL IMPLEMENTATION - NOT DEPLOYED
--
-- Finance must independently confirm merchant receipt.
-- A customer's submitted code is never proof of payment.
--
-- Approval and payment posting occur in one transaction.
-- ============================================================

CREATE OR REPLACE FUNCTION
public.neo_delivery_mpesa_till_claim_approve(
    _claim uuid,
    _verified_amount numeric,
    _merchant_till text,
    _verification_note text,
    _receiving_account uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$

DECLARE
    v_org uuid := public.current_org_id();

    v_claim public.delivery_mpesa_till_claims;
    v_order public.delivery_orders;

    v_result jsonb;
    v_verified_amount numeric;
    v_invoice_balance numeric;

BEGIN

    -- --------------------------------------------------------
    -- 1. FINANCE AUTHORIZATION
    -- --------------------------------------------------------

    IF auth.uid() IS NULL OR v_org IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
        USING ERRCODE = '42501';
    END IF;

    IF NOT (
        public.is_org_admin_for(v_org)
        OR public.has_permission('finance', 'approve')
    ) THEN

        RAISE EXCEPTION
        'Only authorized Finance personnel can approve M-PESA payments'
        USING ERRCODE = '42501';

    END IF;


    -- --------------------------------------------------------
    -- 2. REQUIRE INDEPENDENT VERIFICATION DETAILS
    -- --------------------------------------------------------

    IF coalesce(btrim(_merchant_till), '') = '' THEN
        RAISE EXCEPTION
        'Merchant Till number is required';
    END IF;

    IF coalesce(btrim(_verification_note), '') = '' THEN
        RAISE EXCEPTION
        'Merchant-side verification evidence is required';
    END IF;

    IF _receiving_account IS NULL THEN
        RAISE EXCEPTION
        'Select the account that received the M-PESA payment';
    END IF;

    IF _verified_amount IS NULL
       OR _verified_amount <= 0
       OR round(_verified_amount, 2) <> _verified_amount
    THEN
        RAISE EXCEPTION
        'A positive verified amount with at most two decimal places is required';
    END IF;

    v_verified_amount := _verified_amount;


    -- --------------------------------------------------------
    -- 3. LOCK CLAIM
    -- --------------------------------------------------------

    SELECT *
    INTO v_claim
    FROM public.delivery_mpesa_till_claims
    WHERE id = _claim
      AND organization_id = v_org
    FOR UPDATE;

    IF v_claim.id IS NULL THEN
        RAISE EXCEPTION 'Payment claim not found';
    END IF;

    IF NOT public.neo_branch_in_scope(v_claim.branch_id) THEN
        RAISE EXCEPTION 'Claim belongs to a property outside your access'
        USING ERRCODE = '42501';
    END IF;

    IF v_claim.status = 'merchant_verified' THEN
        RETURN jsonb_build_object(
            'ok', true,
            'already_verified', true,
            'claim_id', v_claim.id
        );
    END IF;

    IF v_claim.status <> 'submitted' THEN
        RAISE EXCEPTION
        'Only submitted claims can be approved';
    END IF;


    -- --------------------------------------------------------
    -- 4. LOCK DELIVERY ORDER
    -- --------------------------------------------------------

    SELECT *
    INTO v_order
    FROM public.delivery_orders
    WHERE id = v_claim.delivery_order_id
      AND organization_id = v_org
      AND branch_id = v_claim.branch_id
    FOR UPDATE;

    IF v_order.id IS NULL THEN
        RAISE EXCEPTION 'Delivery order not found';
    END IF;

    IF lower(coalesce(v_order.payment_method, '')) <> 'mpesa' THEN
        RAISE EXCEPTION 'Delivery order is not an M-PESA order';
    END IF;

    IF lower(coalesce(v_order.payment_status, '')) IN (
        'paid',
        'settled',
        'completed',
        'refunded',
        'voided'
    ) THEN
        RAISE EXCEPTION
        'Order is already paid or cannot accept payment';
    END IF;

    IF lower(coalesce(v_order.order_status, '')) IN (
        'cancelled',
        'rejected',
        'failed'
    ) THEN
        RAISE EXCEPTION 'Delivery order is closed';
    END IF;


    -- --------------------------------------------------------
    -- 5. MATCH THE VERIFIED AMOUNT
    -- --------------------------------------------------------

    -- Require the invoice to exist before accepting payment.
    -- This prevents recording money against an unbilled delivery.

    -- Match the established neo_delivery_record_payment()
    -- invoice relationship exactly.

    SELECT round(coalesce(i.balance, 0)::numeric, 2)
    INTO v_invoice_balance
    FROM public.invoices i
    WHERE i.organization_id = v_org
      AND i.notes LIKE
          '%delivery-order:' || v_order.id::text || '%'
    ORDER BY i.created_at
    LIMIT 1
    FOR UPDATE;

    IF v_invoice_balance IS NULL THEN
        RAISE EXCEPTION
        'Delivery invoice must be raised before payment approval';
    END IF;

    IF v_invoice_balance <= 0 THEN
        RAISE EXCEPTION
        'Delivery invoice is already settled';
    END IF;

    -- Pilot rule: one manual Till claim settles the currently
    -- outstanding invoice balance.

    IF round(v_verified_amount, 2) <> v_invoice_balance THEN
        RAISE EXCEPTION
        'Verified amount does not match the outstanding invoice balance';
    END IF;


    -- --------------------------------------------------------
    -- 6. STOP REUSE OF AN EXISTING PAYMENT REFERENCE
    -- --------------------------------------------------------

    -- Serialize verification of the same receipt code within
    -- the current database transaction. Other payment entry
    -- points still require their own uniqueness enforcement.

    PERFORM pg_advisory_xact_lock(
        hashtextextended(
            'neo:mpesa:' || v_org::text || ':' || v_claim.receipt_code,
            0
        )
    );

    -- Check existing records after acquiring the lock.
    -- The claim table also has a unique organization/receipt key.

    IF EXISTS (
        SELECT 1
        FROM public.payments p
        WHERE p.organization_id = v_org
          AND upper(btrim(coalesce(p.external_reference, '')))
              = v_claim.receipt_code
    ) THEN
        RAISE EXCEPTION
        'This M-PESA reference already exists in payment records';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.pos_payments p
        WHERE p.organization_id = v_org
          AND upper(btrim(coalesce(p.external_reference, '')))
              = v_claim.receipt_code
    ) THEN
        RAISE EXCEPTION
        'This M-PESA reference already exists in POS payments';
    END IF;


    -- --------------------------------------------------------
    -- 7. POST THROUGH THE EXISTING DELIVERY ACCOUNTING RPC
    -- --------------------------------------------------------

    -- This function is responsible for:
    --   receipt creation
    --   invoice balance
    --   accounting journal
    --   delivery payment status
    --
    -- Do not reproduce that accounting logic here.

    v_result := public.neo_delivery_record_payment(
        v_order.id,
        v_verified_amount,
        'mpesa',
        'payment',
        v_claim.receipt_code,
        concat(
            'Manual Till merchant verification. Till: ',
            btrim(_merchant_till),
            '. Evidence: ',
            btrim(_verification_note)
        ),
        _receiving_account
    );

    IF v_result IS NULL
       OR v_result->>'ok' IS DISTINCT FROM 'true'
    THEN
        RAISE EXCEPTION
        'Delivery payment posting did not return confirmed success';
    END IF;


    -- --------------------------------------------------------
    -- 8. MARK CLAIM VERIFIED ONLY AFTER SUCCESSFUL POSTING
    -- --------------------------------------------------------

    UPDATE public.delivery_mpesa_till_claims
    SET status = 'merchant_verified',
        reviewed_by = auth.uid(),
        reviewed_at = now(),
        review_note = concat(
            'Merchant Till: ',
            btrim(_merchant_till),
            '. Verified amount: ',
            v_verified_amount,
            '. Evidence: ',
            btrim(_verification_note)
        )
    WHERE id = v_claim.id;


    RETURN jsonb_build_object(
        'ok', true,
        'claim_id', v_claim.id,
        'delivery_order_id', v_order.id,
        'receipt_code', v_claim.receipt_code,
        'verified_amount', v_verified_amount,
        'status', 'merchant_verified',
        'payment_result', v_result
    );

END;

$function$;


REVOKE ALL ON FUNCTION
public.neo_delivery_mpesa_till_claim_approve(
    uuid,
    numeric,
    text,
    text,
    uuid
)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
public.neo_delivery_mpesa_till_claim_approve(
    uuid,
    numeric,
    text,
    text,
    uuid
)
TO authenticated;


