-- 1. Autopost trigger: one posting path per record.
CREATE OR REPLACE FUNCTION public.neo_autopost_txn()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_TABLE_NAME = 'pos_orders' THEN
    -- Folio-routed orders are recognised on the folio charge, not twice.
    IF NEW.status IN ('closed','paid','settled','completed')
       AND NEW.status IS DISTINCT FROM OLD.status
       AND NEW.folio_id IS NULL THEN
      PERFORM public.neo_finance_post_txn('pos_order', NEW.id, true);
    END IF;

  ELSIF TG_TABLE_NAME = 'folio_lines' THEN
    IF NEW.status = 'posted' AND coalesce(NEW.line_type,'charge') <> 'payment'
       AND (TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status) THEN
      PERFORM public.neo_finance_post_txn('folio_charge', NEW.id, true);
    END IF;

  ELSIF TG_TABLE_NAME = 'payments' THEN
    IF NEW.status IN ('confirmed','completed','paid','succeeded','captured')
       AND (TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status) THEN
      PERFORM public.neo_finance_post_txn('folio_payment', NEW.id, true);
    END IF;

  ELSIF TG_TABLE_NAME = 'invoices' THEN
    IF NEW.status IN ('issued','sent','partially_paid','paid','overdue')
       AND (TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status) THEN
      PERFORM public.neo_finance_post_txn('event_invoice', NEW.id, true);
    END IF;

  ELSIF TG_TABLE_NAME = 'event_bookings' THEN
    IF coalesce(NEW.deposit_paid,0) > coalesce(OLD.deposit_paid,0) THEN
      PERFORM public.neo_finance_post_txn('event_deposit', NEW.id, true);
    END IF;
    IF NEW.status IN ('completed','closed') AND NEW.status IS DISTINCT FROM OLD.status THEN
      PERFORM public.neo_finance_post_txn('event_earned', NEW.id, true);
    END IF;
    IF NEW.status = 'cancelled' AND NEW.status IS DISTINCT FROM OLD.status THEN
      PERFORM public.neo_finance_post_txn('event_cancellation', NEW.id, true);
    END IF;

  ELSIF TG_TABLE_NAME = 'delivery_orders' THEN
    IF NEW.order_status IN ('delivered','completed')
       AND NEW.order_status IS DISTINCT FROM OLD.order_status THEN
      PERFORM public.neo_finance_post_txn('delivery_order', NEW.id, true);
    END IF;

  ELSIF TG_TABLE_NAME = 'guest_laundry_orders' THEN
    -- Priced, non-folio orders only: folio-routed laundry is recognised on the
    -- folio charge, and an uncounted (zero value) order is not revenue at all.
    IF NEW.status IN ('delivered','completed','closed')
       AND NEW.status IS DISTINCT FROM OLD.status
       AND NEW.folio_id IS NULL
       AND coalesce(NEW.total,0) > 0 THEN
      PERFORM public.neo_finance_post_txn('laundry_order', NEW.id, true);
    END IF;

  ELSIF TG_TABLE_NAME = 'supplier_invoices' THEN
    IF NEW.approved_at IS NOT NULL AND NEW.status IN ('approved','matched','partially_paid','paid')
       AND (TG_OP = 'INSERT' OR OLD.approved_at IS NULL OR NEW.status IS DISTINCT FROM OLD.status) THEN
      PERFORM public.neo_finance_post_txn('supplier_invoice', NEW.id, true);
    END IF;

  ELSIF TG_TABLE_NAME = 'supplier_payments' THEN
    IF NEW.status IN ('paid','completed','settled')
       AND (TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status) THEN
      PERFORM public.neo_finance_post_txn('supplier_payment', NEW.id, true);
    END IF;
  END IF;
  RETURN NEW;
END $function$;

-- 2. Supervised retry / disposition for a posting receipt.
CREATE OR REPLACE FUNCTION public.neo_posting_receipt_action(
  _receipt uuid, _action text, _reason text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  org uuid := public.current_org_id();
  r public.finance_posting_receipts;
  res jsonb;
  who text;
BEGIN
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.is_org_admin() OR public.has_permission('finance','approve')) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO r FROM public.finance_posting_receipts
   WHERE id = _receipt AND organization_id = org FOR UPDATE;
  IF r.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF r.status = 'posted' THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_posted');
  END IF;

  SELECT coalesce(full_name, email, '') INTO who FROM public.profiles WHERE id = auth.uid();

  IF _action = 'retry' THEN
    IF r.source_module IN ('pos','laundry','events','delivery') THEN
      res := public.neo_finance_post_source(r.source_module, r.source_id, true);
    ELSE
      res := public.neo_finance_post_txn(r.source_module, r.source_id, true);
    END IF;

    INSERT INTO public.audit_logs
      (organization_id, branch_id, user_id, user_name, action, module, record_id, new_value, reason)
    VALUES (org, r.branch_id, auth.uid(), coalesce(who,''), 'finance.posting.retry', 'finance',
            r.id::text, coalesce(res,'{}'::jsonb), _reason);
    RETURN coalesce(res,'{}'::jsonb) || jsonb_build_object('receipt_id', r.id, 'action', 'retry');

  ELSIF _action = 'resolve' THEN
    IF coalesce(btrim(_reason),'') = '' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'reason_required');
    END IF;
    UPDATE public.finance_posting_receipts
       SET status = 'resolved', last_error = NULL,
           detail = 'Closed without posting: ' || _reason, updated_at = now()
     WHERE id = r.id;

    INSERT INTO public.audit_logs
      (organization_id, branch_id, user_id, user_name, action, module, record_id,
       previous_value, new_value, reason)
    VALUES (org, r.branch_id, auth.uid(), coalesce(who,''), 'finance.posting.resolved', 'finance',
            r.id::text,
            jsonb_build_object('status', r.status, 'last_error', r.last_error),
            jsonb_build_object('status', 'resolved'), _reason);
    RETURN jsonb_build_object('ok', true, 'receipt_id', r.id, 'action', 'resolve', 'status', 'resolved');
  END IF;

  RETURN jsonb_build_object('ok', false, 'reason', 'unknown_action');
END $function$;

REVOKE ALL ON FUNCTION public.neo_posting_receipt_action(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_posting_receipt_action(uuid, text, text) TO authenticated;