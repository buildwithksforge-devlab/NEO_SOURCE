CREATE OR REPLACE FUNCTION public.neo_finance_eligible_sources(
  _branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL)
RETURNS TABLE (source_type text, source_id uuid, reference text, source_status text,
               amount numeric, occurred_on date, branch_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH scope AS (SELECT public.current_org_id() org)
  SELECT 'pos_order', o.id, o.order_number, o.status, o.grand_total,
         coalesce(o.closed_at, o.created_at)::date, o.branch_id
    FROM public.pos_orders o, scope s
   WHERE o.organization_id = s.org AND o.status IN ('closed','paid','settled','completed')
  UNION ALL
  SELECT 'folio_charge', f.id, coalesce(f.reference, f.description), f.status,
         coalesce(f.net_amount,0) + coalesce(f.tax_amount,0) + coalesce(f.service_charge_amount,0),
         coalesce(f.operational_date, f.posting_date::date), f.branch_id
    FROM public.folio_lines f, scope s
   WHERE f.organization_id = s.org AND f.status = 'posted'
     AND coalesce(f.line_type,'charge') <> 'payment'
  UNION ALL
  SELECT 'folio_payment', p.id, p.receipt_number, p.status, p.amount,
         coalesce(p.paid_at, p.created_at)::date, p.branch_id
    FROM public.payments p, scope s
   WHERE p.organization_id = s.org
     AND p.status IN ('confirmed','completed','paid','succeeded','captured')
  UNION ALL
  SELECT 'event_deposit', e.id, e.event_reference, e.status, e.deposit_paid,
         coalesce(e.confirmed_at::date, e.event_date), e.branch_id
    FROM public.event_bookings e, scope s
   WHERE e.organization_id = s.org AND coalesce(e.deposit_paid,0) > 0
     AND e.status <> 'cancelled'
  UNION ALL
  SELECT 'event_invoice', i.id, i.invoice_number, i.status, i.total, i.issue_date, i.branch_id
    FROM public.invoices i, scope s
   WHERE i.organization_id = s.org
     AND i.status IN ('issued','sent','partially_paid','paid','overdue')
  UNION ALL
  SELECT 'event_earned', e.id, e.event_reference, e.status, e.total_amount, e.event_date, e.branch_id
    FROM public.event_bookings e, scope s
   WHERE e.organization_id = s.org AND e.status IN ('completed','closed')
  UNION ALL
  SELECT 'event_cancellation', e.id, e.event_reference, e.status,
         greatest(coalesce(e.cancellation_fee,0), coalesce(e.deposit_paid,0)),
         coalesce(e.cancelled_at::date, e.event_date), e.branch_id
    FROM public.event_bookings e, scope s
   WHERE e.organization_id = s.org AND e.status = 'cancelled'
     AND (coalesce(e.cancellation_fee,0) > 0 OR coalesce(e.deposit_paid,0) > 0)
  UNION ALL
  SELECT 'delivery_order', d.id, d.order_number, d.order_status, d.grand_total,
         coalesce(d.delivered_at, d.created_at)::date, d.branch_id
    FROM public.delivery_orders d, scope s
   WHERE d.organization_id = s.org AND d.order_status IN ('delivered','completed')
  UNION ALL
  SELECT 'laundry_order', l.id, l.laundry_number, l.status, l.total,
         coalesce(l.delivered_at, l.created_at)::date, l.branch_id
    FROM public.guest_laundry_orders l, scope s
   WHERE l.organization_id = s.org AND l.status IN ('delivered','completed','closed')
  UNION ALL
  SELECT 'supplier_invoice', v.id, v.invoice_number, v.status, v.amount, v.invoice_date, v.branch_id
    FROM public.supplier_invoices v, scope s
   WHERE v.organization_id = s.org AND v.approved_at IS NOT NULL
     AND v.status IN ('approved','matched','partially_paid','paid')
  UNION ALL
  SELECT 'supplier_payment', sp.id, sp.payment_number, sp.status, sp.amount, sp.paid_on, sp.branch_id
    FROM public.supplier_payments sp, scope s
   WHERE sp.organization_id = s.org AND sp.status IN ('paid','completed','settled');
$$;
REVOKE ALL ON FUNCTION public.neo_finance_eligible_sources(uuid,date,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_finance_eligible_sources(uuid,date,date) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_finance_backfill(
  _branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL,
  _dry_run boolean DEFAULT false)
RETURNS TABLE (module text, eligible integer, posted integer, skipped_ineligible integer,
               failed integer, duplicate_prevented integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE org uuid := public.current_org_id(); item record; res jsonb;
        acc jsonb := '{}'::jsonb; k text; cur jsonb;
BEGIN
  IF org IS NULL THEN RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501'; END IF;
  IF NOT (public.is_org_admin() OR public.has_permission('finance','approve')) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  FOR item IN
    SELECT * FROM public.neo_finance_eligible_sources(_branch, _from, _to) e
     WHERE (_branch IS NULL OR e.branch_id = _branch)
       AND (_from IS NULL OR e.occurred_on >= _from)
       AND (_to IS NULL OR e.occurred_on <= _to)
     ORDER BY e.occurred_on
  LOOP
    k := item.source_type;
    cur := coalesce(acc->k, jsonb_build_object('eligible',0,'posted',0,'skipped',0,'failed',0,'dup',0));
    cur := jsonb_set(cur, '{eligible}', to_jsonb((cur->>'eligible')::int + 1));

    IF _dry_run THEN
      acc := jsonb_set(acc, ARRAY[k], cur); CONTINUE;
    END IF;

    res := public.neo_finance_post_txn(item.source_type, item.source_id, true);
    IF coalesce((res->>'duplicate_prevented')::boolean, false) THEN
      cur := jsonb_set(cur, '{dup}', to_jsonb((cur->>'dup')::int + 1));
    ELSIF coalesce((res->>'ok')::boolean, false) THEN
      cur := jsonb_set(cur, '{posted}', to_jsonb((cur->>'posted')::int + 1));
    ELSIF res->>'reason' = 'failed' THEN
      cur := jsonb_set(cur, '{failed}', to_jsonb((cur->>'failed')::int + 1));
    ELSE
      cur := jsonb_set(cur, '{skipped}', to_jsonb((cur->>'skipped')::int + 1));
    END IF;
    acc := jsonb_set(acc, ARRAY[k], cur);
  END LOOP;

  RETURN QUERY
  SELECT e.key, (e.value->>'eligible')::int, (e.value->>'posted')::int,
         (e.value->>'skipped')::int, (e.value->>'failed')::int, (e.value->>'dup')::int
    FROM jsonb_each(acc) e ORDER BY e.key;
END $$;
REVOKE ALL ON FUNCTION public.neo_finance_backfill(uuid,date,date,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_finance_backfill(uuid,date,date,boolean) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_autopost_txn()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_TABLE_NAME = 'pos_orders' THEN
    IF NEW.status IN ('closed','paid','settled','completed')
       AND NEW.status IS DISTINCT FROM OLD.status THEN
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
    IF NEW.status IN ('delivered','completed','closed')
       AND NEW.status IS DISTINCT FROM OLD.status THEN
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
END $$;
REVOKE ALL ON FUNCTION public.neo_autopost_txn() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_autopost_txn() TO service_role;

DROP TRIGGER IF EXISTS pos_orders_autopost_txn ON public.pos_orders;
CREATE TRIGGER pos_orders_autopost_txn AFTER UPDATE ON public.pos_orders
  FOR EACH ROW EXECUTE FUNCTION public.neo_autopost_txn();

DROP TRIGGER IF EXISTS folio_lines_autopost_txn ON public.folio_lines;
CREATE TRIGGER folio_lines_autopost_txn AFTER INSERT OR UPDATE ON public.folio_lines
  FOR EACH ROW EXECUTE FUNCTION public.neo_autopost_txn();

DROP TRIGGER IF EXISTS payments_autopost_txn ON public.payments;
CREATE TRIGGER payments_autopost_txn AFTER INSERT OR UPDATE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.neo_autopost_txn();

DROP TRIGGER IF EXISTS invoices_autopost_txn ON public.invoices;
CREATE TRIGGER invoices_autopost_txn AFTER INSERT OR UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.neo_autopost_txn();

DROP TRIGGER IF EXISTS event_bookings_autopost_txn ON public.event_bookings;
CREATE TRIGGER event_bookings_autopost_txn AFTER UPDATE ON public.event_bookings
  FOR EACH ROW EXECUTE FUNCTION public.neo_autopost_txn();

DROP TRIGGER IF EXISTS delivery_orders_autopost_txn ON public.delivery_orders;
CREATE TRIGGER delivery_orders_autopost_txn AFTER UPDATE ON public.delivery_orders
  FOR EACH ROW EXECUTE FUNCTION public.neo_autopost_txn();

DROP TRIGGER IF EXISTS guest_laundry_autopost_txn ON public.guest_laundry_orders;
CREATE TRIGGER guest_laundry_autopost_txn AFTER UPDATE ON public.guest_laundry_orders
  FOR EACH ROW EXECUTE FUNCTION public.neo_autopost_txn();

DROP TRIGGER IF EXISTS supplier_invoices_autopost_txn ON public.supplier_invoices;
CREATE TRIGGER supplier_invoices_autopost_txn AFTER INSERT OR UPDATE ON public.supplier_invoices
  FOR EACH ROW EXECUTE FUNCTION public.neo_autopost_txn();

DROP TRIGGER IF EXISTS supplier_payments_autopost_txn ON public.supplier_payments;
CREATE TRIGGER supplier_payments_autopost_txn AFTER INSERT OR UPDATE ON public.supplier_payments
  FOR EACH ROW EXECUTE FUNCTION public.neo_autopost_txn();