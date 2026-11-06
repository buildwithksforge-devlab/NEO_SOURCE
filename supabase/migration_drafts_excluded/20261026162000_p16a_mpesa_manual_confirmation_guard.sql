-- NEO P1.6A - MANUAL M-PESA CONFIRMATION GUARD
-- LOCAL DRAFT - NOT DEPLOYED
--
-- Requires structured merchant-verification evidence
-- before authorized manual confirmation of M-PESA payments.
--
-- This does not independently authenticate a Safaricom transaction.
CREATE OR REPLACE FUNCTION public.pos_confirm_manual_payment(_payment_id uuid, _note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE _org uuid := public.current_org_id(); _p public.pos_payments; _bal numeric;
BEGIN
  IF NOT public.has_permission('pos','payments','manual-confirm') THEN
    RAISE EXCEPTION 'Not permitted to confirm payments manually';
  END IF;
  IF coalesce(btrim(_note),'') = '' THEN
    RAISE EXCEPTION 'A verification note is required for a manually confirmed payment';
  END IF;

  SELECT * INTO _p FROM public.pos_payments
   WHERE id = _payment_id AND organization_id = _org FOR UPDATE;
  IF _p.id IS NULL THEN RAISE EXCEPTION 'Payment not found'; END IF;
  IF NOT public.neo_branch_in_scope(_p.branch_id) THEN
    RAISE EXCEPTION 'That payment belongs to a property outside your access';
  END IF;
  IF _p.status = 'confirmed' THEN
    RETURN jsonb_build_object('payment_id', _p.id, 'status', 'confirmed', 'duplicate', true)
        || public.pos_reconcile_settlement_internal(_p.order_id);
  END IF;
  IF _p.status NOT IN ('initiated','pending') THEN
    RAISE EXCEPTION 'Payment is % and cannot be confirmed', _p.status;
  END IF;
     IF coalesce(btrim(_p.external_reference),'') = '' THEN
     RAISE EXCEPTION 'This attempt has no provider reference, so it cannot be confirmed manually';
   END IF;

   -- Manual M-PESA confirmation requires merchant-side verification evidence.
   -- A customer-entered receipt code alone is not evidence of payment.
   IF lower(coalesce(_p.method,'')) IN ('mpesa','mobile','mobile_money') THEN
     IF btrim(coalesce(_note,'')) !~*
        '^MERCHANT VERIFIED[[:space:]]*\|[[:space:]]*TILL:[[:space:]]*[^|]+[[:space:]]*\|[[:space:]]*AMOUNT:[[:space:]]*[0-9]+(\.[0-9]{1,2})?[[:space:]]*\|[[:space:]]*CODE:[[:space:]]*[A-Z0-9]+'
     THEN
       RAISE EXCEPTION
         'M-PESA manual confirmation requires merchant verification: MERCHANT VERIFIED | TILL: ... | AMOUNT: ... | CODE: ...';
     END IF;
   END IF;

  SELECT round(coalesce(o.grand_total,0)
              - coalesce((SELECT sum(amount) FROM public.pos_payments x
                           WHERE x.order_id = _p.order_id AND x.status='confirmed'),0), 2)
    INTO _bal FROM public.pos_orders o WHERE o.id = _p.order_id;
  IF _p.amount > _bal + 0.005 THEN
    RAISE EXCEPTION 'Confirming % would exceed the outstanding balance of %', _p.amount, greatest(_bal,0);
  END IF;

  UPDATE public.pos_payments
     SET status = 'confirmed', provider_status = 'manual-confirmed', paid_at = now(),
         verified_by = auth.uid(), verification_note = btrim(_note)
   WHERE id = _payment_id;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, action, module, record_id, new_value)
  VALUES (_org, _p.branch_id, auth.uid(), 'pos.payment.manual_confirm', 'pos', _p.order_id,
          jsonb_build_object('paymentId', _p.id, 'amount', _p.amount, 'method', _p.method,
                             'reference', _p.external_reference, 'note', btrim(_note)));

  RETURN jsonb_build_object('payment_id', _p.id, 'status', 'confirmed', 'duplicate', false)
      || public.pos_reconcile_settlement_internal(_p.order_id);
END $$;


REVOKE ALL ON FUNCTION public.pos_confirm_manual_payment(uuid,text)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.pos_confirm_manual_payment(uuid,text)
TO authenticated, service_role;
