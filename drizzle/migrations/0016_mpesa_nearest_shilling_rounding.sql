-- ---------------------------------------------------------------- new fields
ALTER TABLE public.pos_orders ADD COLUMN IF NOT EXISTS rounding_adjustment numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE public.pos_orders ADD CONSTRAINT pos_orders_rounding_adjustment_chk CHECK (rounding_adjustment > -1 AND rounding_adjustment < 1);
COMMENT ON COLUMN public.pos_orders.rounding_adjustment IS 'Whole-shilling M-Pesa rounding carried by the bill (nearest shilling). Set only by the M-Pesa payment routines.';

ALTER TABLE public.delivery_orders ADD COLUMN IF NOT EXISTS rounding_adjustment numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE public.delivery_orders ADD CONSTRAINT delivery_orders_rounding_adjustment_chk CHECK (rounding_adjustment > -1 AND rounding_adjustment < 1);
COMMENT ON COLUMN public.delivery_orders.rounding_adjustment IS 'Mirror of the linked bill''s M-Pesa rounding; included in grand_total.';

ALTER TABLE public.mpesa_transactions ADD COLUMN IF NOT EXISTS rounding_adjustment numeric(14,2);
ALTER TABLE public.mpesa_transactions ADD COLUMN IF NOT EXISTS rounding_released boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.mpesa_transactions.rounding_adjustment IS 'Rounding this attempt added to its bill (whole charge minus balance with cents).';
COMMENT ON COLUMN public.mpesa_transactions.rounding_released IS 'True while the rounding has been taken back off the bill because the attempt did not succeed.';

-- ---------------------------------------------------------------- rounding rule
CREATE OR REPLACE FUNCTION public.neo_mpesa_whole_amount(_due numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  -- Nearest shilling: under 50 cents rounds down, 50 cents or more rounds up.
  SELECT CASE WHEN _due IS NULL THEN NULL ELSE round(round(_due, 2), 0) END
$$;

-- ---------------------------------------------------------------- only the payment routines may set rounding
CREATE OR REPLACE FUNCTION public.neo_rounding_adjustment_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND coalesce(NEW.rounding_adjustment, 0) <> 0)
     OR (TG_OP = 'UPDATE' AND NEW.rounding_adjustment IS DISTINCT FROM OLD.rounding_adjustment) THEN
    IF coalesce(current_setting('neo.mpesa_rounding', true), 'off') <> 'on'
       OR current_user IN ('anon', 'authenticated') THEN
      RAISE EXCEPTION 'Bill rounding is set only by the M-Pesa payment steps' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER neo_pos_rounding_guard_trg
  BEFORE INSERT OR UPDATE OF rounding_adjustment ON public.pos_orders
  FOR EACH ROW EXECUTE FUNCTION public.neo_rounding_adjustment_guard();
CREATE TRIGGER neo_delivery_rounding_guard_trg
  BEFORE INSERT OR UPDATE OF rounding_adjustment ON public.delivery_orders
  FOR EACH ROW EXECUTE FUNCTION public.neo_rounding_adjustment_guard();

-- ---------------------------------------------------------------- private worker that moves rounding on a bill
CREATE OR REPLACE FUNCTION neo_private.pos_set_rounding(_order uuid, _delta numeric)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE _o public.pos_orders;
BEGIN
  IF _delta IS NULL OR _delta = 0 THEN RETURN; END IF;
  SELECT * INTO _o FROM public.pos_orders WHERE id = _order FOR UPDATE;
  IF _o.id IS NULL THEN RAISE EXCEPTION 'Bill not found'; END IF;
  PERFORM set_config('neo.mpesa_rounding', 'on', true);
  UPDATE public.pos_orders
     SET rounding_adjustment = rounding_adjustment + _delta, updated_at = now()
   WHERE id = _order;
  UPDATE public.delivery_orders
     SET rounding_adjustment = rounding_adjustment + _delta,
         grand_total = grand_total + _delta,
         updated_at = now()
   WHERE pos_order_id = _order AND organization_id = _o.organization_id;
  PERFORM set_config('neo.mpesa_rounding', 'off', true);
  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, user_name, action, module, record_id,
                                 previous_value, new_value, reason)
  VALUES (_o.organization_id, _o.branch_id, auth.uid(), '', 'restaurant.order.mpesa_rounding', 'restaurant', _order::text,
          jsonb_build_object('rounding_adjustment', _o.rounding_adjustment, 'grand_total', _o.grand_total),
          jsonb_build_object('rounding_adjustment', _o.rounding_adjustment + _delta, 'change', _delta),
          'M-Pesa takes whole shillings; bill rounded to the nearest shilling');
END $$;
REVOKE EXECUTE ON FUNCTION neo_private.pos_set_rounding(uuid, numeric) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- bill totals include the rounding
CREATE OR REPLACE FUNCTION public.tg_pos_order_totals_authoritative()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _sub numeric(14,2);
  _tax numeric(14,2);
  _net numeric(14,2);
  _pct numeric;
  _svc numeric(14,2);
  _disc numeric(14,2);
  _delivery public.delivery_orders;
BEGIN
  SELECT COALESCE(sum(line_total),0), COALESCE(sum(tax_amount),0)
    INTO _sub, _tax
  FROM public.pos_order_items
  WHERE order_id = NEW.id AND COALESCE(status,'draft') NOT IN ('cancelled','voided');

  IF EXISTS (SELECT 1 FROM public.pos_order_items WHERE order_id = NEW.id) THEN
    _disc := COALESCE(NEW.discount_total, 0);
    NEW.subtotal := _sub;
    _net := GREATEST(0, _sub - _disc);

    IF _disc > 0 AND _sub > 0 THEN
      NEW.tax_total := ROUND(_tax * (_net / _sub), 2);
    ELSE
      NEW.tax_total := _tax;
    END IF;

    SELECT COALESCE((s.settings->>'serviceChargePercent')::numeric, 0)
      INTO _pct
    FROM public.pos_settings s
    WHERE s.organization_id = NEW.organization_id
      AND (s.branch_id = NEW.branch_id OR s.branch_id IS NULL)
    ORDER BY (s.branch_id IS NULL)
    LIMIT 1;

    _svc := ROUND(_net * COALESCE(_pct,0) / 100.0, 2);
    NEW.service_charge_total := _svc;
    SELECT * INTO _delivery FROM public.delivery_orders d
      WHERE d.pos_order_id=NEW.id AND d.organization_id=NEW.organization_id AND d.source_cart_id IS NOT NULL;
    IF _delivery.id IS NOT NULL THEN
      IF _delivery.branch_id IS DISTINCT FROM NEW.branch_id OR _delivery.currency IS DISTINCT FROM NEW.currency
        OR _delivery.delivery_fee<0 OR _delivery.tip_amount<0
        OR _delivery.delivery_fee::text IN ('NaN','Infinity','-Infinity')
        OR _delivery.tip_amount::text IN ('NaN','Infinity','-Infinity') THEN
        RAISE EXCEPTION 'Linked guest order property, currency, fee or tip is invalid';
      END IF;
      -- Retain the service amount agreed at checkout, rather than applying later settings changes.
      NEW.service_charge_total:=_delivery.service_charge_total;
      NEW.grand_total:=_net+NEW.service_charge_total+_delivery.delivery_fee+_delivery.tip_amount
                       +COALESCE(NEW.rounding_adjustment,0);
    ELSE
      NEW.grand_total := _net + _svc + COALESCE(NEW.rounding_adjustment,0);
    END IF;
  ELSE
    NEW.subtotal := 0;
    NEW.tax_total := 0;
    NEW.service_charge_total := 0;
    NEW.grand_total := 0;
    NEW.discount_total := 0;
  END IF;
  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------- saved checkout totals: allow only M-Pesa rounding
CREATE OR REPLACE FUNCTION public.neo_guest_order_cart_binding_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF TG_OP='UPDATE' AND OLD.source_cart_id IS NOT NULL AND
    (jsonb_build_array(NEW.organization_id,NEW.branch_id,NEW.pos_order_id,NEW.customer_id,NEW.currency,NEW.fulfilment_type,
       NEW.subtotal,NEW.discount_total,NEW.tax_total,NEW.service_charge_total,NEW.delivery_fee,NEW.tip_amount)) IS DISTINCT FROM
    (jsonb_build_array(OLD.organization_id,OLD.branch_id,OLD.pos_order_id,OLD.customer_id,OLD.currency,OLD.fulfilment_type,
       OLD.subtotal,OLD.discount_total,OLD.tax_total,OLD.service_charge_total,OLD.delivery_fee,OLD.tip_amount)) THEN
  RAISE EXCEPTION 'Saved checkout financial details cannot be rewritten; use the authorised correction/refund workflow';
 END IF;
 IF TG_OP='UPDATE' AND OLD.source_cart_id IS NOT NULL AND NEW.grand_total IS DISTINCT FROM OLD.grand_total THEN
  -- The only permitted total change is the M-Pesa whole-shilling rounding, applied by the payment steps.
  IF coalesce(current_setting('neo.mpesa_rounding', true), 'off') <> 'on'
     OR current_user IN ('anon', 'authenticated')
     OR (NEW.grand_total - OLD.grand_total) IS DISTINCT FROM
        (coalesce(NEW.rounding_adjustment, 0) - coalesce(OLD.rounding_adjustment, 0)) THEN
   RAISE EXCEPTION 'Saved checkout financial details cannot be rewritten; use the authorised correction/refund workflow';
  END IF;
 END IF;
 IF TG_OP='UPDATE' AND OLD.source_cart_id IS NOT NULL AND NEW.source_cart_id IS DISTINCT FROM OLD.source_cart_id THEN
  RAISE EXCEPTION 'A saved order cart link cannot be changed';
 END IF;
 IF NEW.source_cart_id IS NOT NULL AND (TG_OP='INSERT' OR NEW.source_cart_id IS DISTINCT FROM OLD.source_cart_id) THEN
  IF current_user NOT IN (SELECT pg_get_userbyid(proowner) FROM pg_proc
    WHERE oid IN ('public.delivery_place_order(uuid,text)'::regprocedure,'public.neo_guest_place_room_service(uuid,text)'::regprocedure)) THEN
   RAISE EXCEPTION 'Saved cart links are assigned by checkout only' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.carts c JOIN public.pos_orders p ON p.id=NEW.pos_order_id
    WHERE c.id=NEW.source_cart_id AND c.organization_id=NEW.organization_id AND c.customer_id=NEW.customer_id
      AND c.branch_id IS NOT DISTINCT FROM NEW.branch_id AND c.status='active'
      AND p.organization_id=c.organization_id AND p.branch_id IS NOT DISTINCT FROM c.branch_id AND p.customer_id=c.customer_id) THEN
   RAISE EXCEPTION 'Saved cart, production order and guest links do not agree';
  END IF;
 END IF;
 RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------- targeted edits to the live payment routines
CREATE OR REPLACE FUNCTION neo_private.patch_once(_def text, _old text, _new text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE n int;
BEGIN
  n := (length(_def) - length(replace(_def, _old, ''))) / greatest(length(_old), 1);
  IF n <> 1 THEN RAISE EXCEPTION 'Patch anchor found % times: %', n, left(_old, 90); END IF;
  RETURN replace(_def, _old, _new);
END $$;
REVOKE EXECUTE ON FUNCTION neo_private.patch_once(text, text, text) FROM PUBLIC, anon, authenticated;

DO $m$
DECLARE d text;
BEGIN
  -- Staff "Charge to M-Pesa" and guest folio collections
  d := pg_get_functiondef('public.neo_mpesa_collection_start(text,uuid,text,numeric,text,uuid)'::regprocedure);
  d := neo_private.patch_once(d,
$p$  _result jsonb; _provider_ref text; _pending numeric; _env text; _code text;$p$,
$p$  _result jsonb; _provider_ref text; _pending numeric; _env text; _code text;
  _gt numeric; _confirmed numeric; _active numeric; _due numeric; _whole numeric; _round numeric := 0;$p$);
  d := neo_private.patch_once(d,
$p$  IF _source_module = 'guest_folio' THEN _amount := coalesce(_amount, _balance); END IF;
  IF _amount IS NULL OR _amount <= 0 OR _amount > 9007199254740991 OR _amount <> trunc(_amount) THEN
    RAISE EXCEPTION 'Enter a whole KES amount for M-Pesa';
  END IF;$p$,
$p$  IF _source_module = 'guest_folio' AND _amount IS NULL THEN
    -- Folio collections are whole-shilling part payments; any cents stay on the folio for the front desk.
    _amount := trunc(greatest(coalesce(_balance, 0), 0));
  END IF;
  IF _source_module = 'pos_order' AND _amount IS NOT NULL THEN
    -- M-Pesa takes whole shillings. A full-balance charge with cents is rounded to the
    -- nearest shilling and the bill carries the difference as a recorded rounding amount.
    SELECT grand_total INTO _gt FROM public.pos_orders WHERE id = _source_record;
    SELECT coalesce(sum(amount) FILTER (WHERE status = 'confirmed'), 0),
           coalesce(sum(amount) FILTER (WHERE status IN ('initiated','pending')), 0)
      INTO _confirmed, _active FROM public.pos_payments WHERE order_id = _source_record;
    _due := round(coalesce(_gt, 0) - _confirmed - _active, 2);
    IF _due > 0 AND _due <> trunc(_due)
       AND (abs(_amount - _due) < 0.005 OR _amount = public.neo_mpesa_whole_amount(_due)) THEN
      _whole := public.neo_mpesa_whole_amount(_due);
      IF _whole <= 0 THEN
        RAISE EXCEPTION 'The balance is under KES 0.50, which M-Pesa cannot collect. Settle it another way.';
      END IF;
      _round := _whole - _due;
      _amount := _whole;
    END IF;
  END IF;
  IF _amount IS NULL OR _amount <= 0 OR _amount > 9007199254740991 OR _amount <> trunc(_amount) THEN
    RAISE EXCEPTION 'M-Pesa takes whole shillings. Charge the full balance (rounded to the nearest shilling) or enter a whole amount for a part payment.';
  END IF;$p$);
  d := neo_private.patch_once(d,
$p$    _table := 'pos_payments';
    _result := public.pos_record_payment_attempt($p$,
$p$    _table := 'pos_payments';
    IF _round <> 0 THEN PERFORM neo_private.pos_set_rounding(_source_record, _round); END IF;
    _result := public.pos_record_payment_attempt($p$);
  d := neo_private.patch_once(d,
$p$  IF _txn IS NULL THEN RAISE EXCEPTION 'Transaction creation was not confirmed'; END IF;
  RETURN jsonb_build_object('transaction_id', _txn, 'organization_id', _org,
    'amount', _amount, 'account_reference', _reference, 'reused', false);
END $function$$p$,
$p$  IF _txn IS NULL THEN RAISE EXCEPTION 'Transaction creation was not confirmed'; END IF;
  IF _round <> 0 THEN
    UPDATE public.mpesa_transactions SET rounding_adjustment = _round WHERE id = _txn;
  END IF;
  RETURN jsonb_build_object('transaction_id', _txn, 'organization_id', _org,
    'amount', _amount, 'account_reference', _reference, 'reused', false,
    'rounding', _round, 'bill_balance', _due);
END $function$$p$);
  EXECUTE d;

  -- Guest delivery orders paid by M-Pesa
  d := pg_get_functiondef('public.neo_delivery_guest_mpesa_start(uuid,text)'::regprocedure);
  d := neo_private.patch_once(d,
$p$  _code text;
BEGIN$p$,
$p$  _code text;
  _bill_due numeric;
  _round numeric := 0;
BEGIN$p$);
  d := neo_private.patch_once(d,
$p$  IF _due<>trunc(_due) OR _due>9007199254740991 THEN
    RAISE EXCEPTION 'M-Pesa requires a whole KES amount. No payment attempt or prompt was created; choose another method for this balance.';
  END IF;$p$,
$p$  IF _due <> trunc(_due) THEN
    -- M-Pesa takes whole shillings: charge the nearest shilling and record the difference on the bill.
    _bill_due := _due;
    _due := public.neo_mpesa_whole_amount(_bill_due);
    IF _due <= 0 THEN
      RAISE EXCEPTION 'The balance is under KES 0.50, which M-Pesa cannot collect. Choose another way to pay it.';
    END IF;
    _round := _due - _bill_due;
    PERFORM neo_private.pos_set_rounding(_o.id, _round);
  END IF;
  IF _due > 9007199254740991 THEN
    RAISE EXCEPTION 'This amount is too large for M-Pesa.';
  END IF;$p$);
  d := neo_private.patch_once(d,
$p$    msisdn, amount, account_reference, description, environment, short_code, status, created_by)
  VALUES (_d.organization_id, _d.branch_id, 'pos_order', _o.id, 'pos_payments', _payment,
          _digits, _due, coalesce(_d.order_number, _o.order_number), 'Delivery order',
          coalesce(_env, 'sandbox'), _code, 'initiated', auth.uid())$p$,
$p$    msisdn, amount, account_reference, description, environment, short_code, status, created_by,
    rounding_adjustment)
  VALUES (_d.organization_id, _d.branch_id, 'pos_order', _o.id, 'pos_payments', _payment,
          _digits, _due, coalesce(_d.order_number, _o.order_number), 'Delivery order',
          coalesce(_env, 'sandbox'), _code, 'initiated', auth.uid(),
          nullif(_round, 0))$p$);
  d := neo_private.patch_once(d,
$p$    'amount', _due,
$p$,
$p$    'amount', _due,
    'rounding', _round,
$p$);
  EXECUTE d;

  -- Provider results: take rounding back off on failure, put it back on a late success
  d := pg_get_functiondef('public.neo_mpesa_apply_result(uuid,integer,text,text,text,jsonb,text)'::regprocedure);
  d := neo_private.patch_once(d,
$p$       RETURNING order_id INTO _p.order_id;
      IF _p.order_id IS NOT NULL THEN PERFORM public.pos_reconcile_settlement_internal(_p.order_id); END IF;$p$,
$p$       RETURNING order_id INTO _p.order_id;
      IF _p.order_id IS NOT NULL AND coalesce(_t.rounding_adjustment, 0) <> 0 AND NOT _t.rounding_released THEN
        -- The prompt did not go through: take the M-Pesa rounding back off the bill.
        PERFORM neo_private.pos_set_rounding(_p.order_id, -_t.rounding_adjustment);
        UPDATE public.mpesa_transactions SET rounding_released = true WHERE id = _t.id;
      END IF;
      IF _p.order_id IS NOT NULL THEN PERFORM public.pos_reconcile_settlement_internal(_p.order_id); END IF;$p$);
  d := neo_private.patch_once(d,
$p$    IF _p.status IN ('initiated', 'pending','failed') THEN
      UPDATE public.pos_payments$p$,
$p$    IF _p.status IN ('initiated', 'pending','failed') THEN
      IF coalesce(_t.rounding_adjustment, 0) <> 0 AND _t.rounding_released THEN
        -- A late confirmation after a failure: put the rounding back so the bill matches the money received.
        PERFORM neo_private.pos_set_rounding(_p.order_id, _t.rounding_adjustment);
        UPDATE public.mpesa_transactions SET rounding_released = false WHERE id = _t.id;
      END IF;
      UPDATE public.pos_payments$p$);
  EXECUTE d;

  -- Finance: the sale amount carries the rounding (booked with the sale revenue)
  d := pg_get_functiondef('public.neo_finance_post_txn(text,uuid,boolean)'::regprocedure);
  d := neo_private.patch_once(d,
$p$    amount := greatest(coalesce(o.grand_total,0),
                       coalesce(o.subtotal,0) - coalesce(o.discount_total,0));$p$,
$p$    amount := greatest(coalesce(o.grand_total,0),
                       coalesce(o.subtotal,0) - coalesce(o.discount_total,0) + coalesce(o.rounding_adjustment,0));$p$);
  EXECUTE d;
END $m$;

DROP FUNCTION neo_private.patch_once(text, text, text);