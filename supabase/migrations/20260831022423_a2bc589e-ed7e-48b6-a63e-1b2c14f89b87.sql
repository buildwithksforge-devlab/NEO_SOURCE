
-- 1. Deposit policies -------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.deposit_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  name text NOT NULL,
  basis text NOT NULL DEFAULT 'percentage',
  value numeric NOT NULL DEFAULT 0,
  minimum_amount numeric NOT NULL DEFAULT 0,
  reason text NOT NULL DEFAULT 'Standard pre-arrival deposit',
  priority integer NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deposit_policies_basis_chk CHECK (basis IN ('percentage','flat','nights'))
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.deposit_policies TO authenticated;
GRANT ALL ON public.deposit_policies TO service_role;
ALTER TABLE public.deposit_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "deposit_policies_read" ON public.deposit_policies;
CREATE POLICY "deposit_policies_read" ON public.deposit_policies
  FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "deposit_policies_write" ON public.deposit_policies;
CREATE POLICY "deposit_policies_write" ON public.deposit_policies
  FOR ALL TO authenticated
  USING (organization_id = public.current_org_id()
         AND (public.is_org_admin_for(organization_id)
              OR public.has_permission('finance','configuration.manage')
              OR public.has_permission('pms','reservations.edit')))
  WITH CHECK (organization_id = public.current_org_id()
         AND (public.is_org_admin_for(organization_id)
              OR public.has_permission('finance','configuration.manage')
              OR public.has_permission('pms','reservations.edit')));

DROP TRIGGER IF EXISTS deposit_policies_touch ON public.deposit_policies;
CREATE TRIGGER deposit_policies_touch BEFORE UPDATE ON public.deposit_policies
  FOR EACH ROW EXECUTE FUNCTION public.fin_touch_updated_at();

CREATE INDEX IF NOT EXISTS deposit_policies_org_branch_idx
  ON public.deposit_policies (organization_id, branch_id, active, priority);

-- 2. Policy resolution ------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_deposit_policy_for(_reservation uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id();
        _res public.reservations; _pol public.deposit_policies; _amount numeric := 0; _base numeric;
BEGIN
  SELECT * INTO _res FROM public.reservations WHERE id=_reservation AND organization_id=_org;
  IF _res.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'Reservation not found'); END IF;

  SELECT * INTO _pol FROM public.deposit_policies p
   WHERE p.organization_id=_org AND p.active
     AND (p.branch_id IS NULL OR p.branch_id = _res.branch_id)
   ORDER BY (p.branch_id IS NOT NULL) DESC, p.priority ASC, p.created_at ASC
   LIMIT 1;

  IF _pol.id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'policy_id', NULL, 'amount', 0,
      'reason', 'No deposit policy is configured for this property.');
  END IF;

  _base := COALESCE(NULLIF(_res.total_amount,0), COALESCE(_res.nightly_rate,0) * GREATEST(COALESCE(_res.nights,1),1));

  _amount := CASE _pol.basis
    WHEN 'percentage' THEN _base * COALESCE(_pol.value,0) / 100.0
    WHEN 'flat' THEN COALESCE(_pol.value,0)
    WHEN 'nights' THEN COALESCE(_res.nightly_rate,0) * COALESCE(_pol.value,0)
    ELSE 0 END;
  _amount := GREATEST(round(COALESCE(_amount,0), 2), COALESCE(_pol.minimum_amount,0));

  RETURN jsonb_build_object(
    'ok', true, 'policy_id', _pol.id, 'policy_name', _pol.name,
    'basis', _pol.basis, 'value', _pol.value, 'minimum_amount', _pol.minimum_amount,
    'amount', _amount, 'reason', _pol.reason);
END $function$;

REVOKE ALL ON FUNCTION public.neo_deposit_policy_for(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_deposit_policy_for(uuid) TO authenticated;

-- 3. Deposit position now honours the policy --------------------------------
CREATE OR REPLACE FUNCTION public.neo_reservation_deposit_position(_reservation uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _res public.reservations;
  _held numeric := 0; _applied numeric := 0; _required numeric := 0;
  _waiver text := NULL; _override uuid; _policy jsonb; _policy_amount numeric := 0;
  _source text := 'reservation';
BEGIN
  SELECT * INTO _res FROM public.reservations WHERE id=_reservation AND organization_id=_org;
  IF _res.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'Reservation not found'); END IF;

  SELECT COALESCE(sum(amount) FILTER (WHERE status='held'),0),
         COALESCE(sum(amount) FILTER (WHERE status='applied'),0)
    INTO _held, _applied
  FROM public.reservation_deposits WHERE reservation_id=_reservation;

  _policy := public.neo_deposit_policy_for(_reservation);
  _policy_amount := COALESCE((_policy->>'amount')::numeric, 0);
  _required := COALESCE(_res.deposit_required, 0);
  IF _required <= 0 AND _policy_amount > 0 THEN
    _required := _policy_amount;
    _source := 'policy';
  END IF;

  IF _res.corporate_account_id IS NOT NULL THEN _waiver := 'corporate-credit'; END IF;

  SELECT id INTO _override FROM public.checkin_deposit_overrides
   WHERE reservation_id=_reservation AND consumed_at IS NULL
   ORDER BY created_at DESC LIMIT 1;

  RETURN jsonb_build_object(
    'ok', true,
    'reservation_id', _reservation,
    'currency', 'KES',
    'required', _required,
    'required_source', _source,
    'policy_id', _policy->>'policy_id',
    'policy_name', _policy->>'policy_name',
    'policy_reason', _policy->>'reason',
    'policy_amount', _policy_amount,
    'held', _held,
    'applied', _applied,
    'paid', _held + _applied,
    'outstanding', GREATEST(_required - (_held + _applied), 0),
    'waiver', _waiver,
    'override_id', _override,
    'may_check_in', (_required - (_held + _applied)) <= 0.009 OR _waiver IS NOT NULL OR _override IS NOT NULL
  );
END $function$;

-- 4. AP line-level matching --------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_ap_match_lines(_invoice uuid)
RETURNS TABLE(
  line_id uuid, line_number integer, description text, stock_item_id uuid,
  ordered_quantity numeric, accepted_quantity numeric, received_quantity numeric,
  other_invoiced_quantity numeric, claimable_quantity numeric, invoiced_quantity numeric,
  order_unit_price numeric, invoiced_unit_price numeric,
  quantity_variance numeric, price_variance numeric,
  line_total numeric, match_state text, detail text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); inv record; pol public.procurement_matching_policies;
BEGIN
  IF _org IS NULL OR NOT (public.is_org_admin() OR public.has_permission('finance','ap.view')
      OR public.has_permission('finance','view') OR public.can_read_general_ledger()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO inv FROM public.supplier_invoices WHERE id=_invoice AND organization_id=_org;
  IF inv.id IS NULL THEN RETURN; END IF;
  pol := public.neo_matching_policy(_org, inv.branch_id);

  RETURN QUERY
  WITH lines AS (
    SELECT il.id, il.line_number, COALESCE(NULLIF(il.description,''), si.name, 'Item') AS description,
           il.stock_item_id, il.quantity, il.unit_price, il.total_amount
      FROM public.supplier_invoice_lines il
      LEFT JOIN public.stock_items si ON si.id = il.stock_item_id
     WHERE il.supplier_invoice_id = _invoice
  ), enriched AS (
    SELECT l.*,
      COALESCE((SELECT sum(pl.quantity) FROM public.purchase_order_lines pl
                 WHERE pl.order_id = inv.order_id
                   AND (pl.stock_item_id = l.stock_item_id
                        OR (l.stock_item_id IS NULL AND lower(COALESCE(pl.description,'')) = lower(l.description)))),0) AS ordered,
      COALESCE((SELECT sum(pl.accepted_quantity) FROM public.purchase_order_lines pl
                 WHERE pl.order_id = inv.order_id
                   AND (pl.stock_item_id = l.stock_item_id
                        OR (l.stock_item_id IS NULL AND lower(COALESCE(pl.description,'')) = lower(l.description)))),0) AS accepted,
      COALESCE((SELECT max(pl.unit_price) FROM public.purchase_order_lines pl
                 WHERE pl.order_id = inv.order_id
                   AND (pl.stock_item_id = l.stock_item_id
                        OR (l.stock_item_id IS NULL AND lower(COALESCE(pl.description,'')) = lower(l.description)))),0) AS po_price,
      COALESCE((SELECT sum(grl.quantity_received) FROM public.goods_receipt_lines grl
                 JOIN public.goods_receipts gr ON gr.id = grl.receipt_id
                WHERE gr.organization_id = _org AND gr.order_id = inv.order_id
                  AND grl.stock_item_id = l.stock_item_id),0) AS received,
      COALESCE((SELECT sum(ol.quantity) FROM public.supplier_invoice_lines ol
                 JOIN public.supplier_invoices oi ON oi.id = ol.supplier_invoice_id
                WHERE oi.organization_id = _org AND oi.order_id = inv.order_id AND oi.id <> _invoice
                  AND COALESCE(oi.status,'') NOT IN ('cancelled','void','rejected')
                  AND (ol.stock_item_id = l.stock_item_id
                       OR (l.stock_item_id IS NULL AND lower(COALESCE(ol.description,'')) = lower(l.description)))),0) AS other_invoiced
    FROM lines l
  )
  SELECT e.id, e.line_number, e.description, e.stock_item_id,
         e.ordered, e.accepted, e.received, e.other_invoiced,
         GREATEST((CASE WHEN pol.match_mode = 'two-way' THEN e.ordered ELSE e.accepted END)
                  * (1 + COALESCE(pol.quantity_tolerance_pct,0)/100.0) - e.other_invoiced, 0) AS claimable,
         e.quantity, e.po_price, e.unit_price,
         e.quantity - GREATEST((CASE WHEN pol.match_mode = 'two-way' THEN e.ordered ELSE e.accepted END)
                  * (1 + COALESCE(pol.quantity_tolerance_pct,0)/100.0) - e.other_invoiced, 0),
         CASE WHEN e.po_price > 0 THEN e.unit_price - e.po_price ELSE 0 END,
         COALESCE(e.total_amount, e.quantity * e.unit_price),
         CASE
           WHEN inv.order_id IS NULL THEN 'exception'
           WHEN e.ordered = 0 THEN 'exception'
           WHEN e.quantity > GREATEST((CASE WHEN pol.match_mode = 'two-way' THEN e.ordered ELSE e.accepted END)
                  * (1 + COALESCE(pol.quantity_tolerance_pct,0)/100.0) - e.other_invoiced, 0) + 0.0001 THEN 'exception'
           WHEN e.po_price > 0 AND e.unit_price > e.po_price
                + GREATEST(e.po_price * COALESCE(pol.price_tolerance_pct,0)/100.0, COALESCE(pol.price_tolerance_amount,0)) THEN 'exception'
           WHEN e.po_price > 0 AND abs(e.unit_price - e.po_price) > 0.009 THEN 'variance'
           WHEN pol.match_mode = 'three-way' AND e.accepted < e.ordered THEN 'variance'
           ELSE 'matched'
         END,
         CASE
           WHEN inv.order_id IS NULL THEN 'Invoice is not linked to a purchase order'
           WHEN e.ordered = 0 THEN 'Invoiced but not on the purchase order'
           WHEN e.quantity > GREATEST((CASE WHEN pol.match_mode = 'two-way' THEN e.ordered ELSE e.accepted END)
                  * (1 + COALESCE(pol.quantity_tolerance_pct,0)/100.0) - e.other_invoiced, 0) + 0.0001
             THEN format('Invoiced %s but only %s claimable', e.quantity, round(GREATEST((CASE WHEN pol.match_mode='two-way' THEN e.ordered ELSE e.accepted END)*(1+COALESCE(pol.quantity_tolerance_pct,0)/100.0)-e.other_invoiced,0),3))
           WHEN e.po_price > 0 AND abs(e.unit_price - e.po_price) > 0.009
             THEN format('Order price %s vs invoiced %s', e.po_price, e.unit_price)
           WHEN pol.match_mode = 'three-way' AND e.accepted < e.ordered
             THEN format('Ordered %s, accepted %s', e.ordered, e.accepted)
           ELSE 'Purchase order, receipt and invoice agree'
         END
    FROM enriched e
   ORDER BY e.line_number NULLS LAST, e.description;
END $function$;

REVOKE ALL ON FUNCTION public.neo_ap_match_lines(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_ap_match_lines(uuid) TO authenticated;

-- 5. AP journal register ------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_ap_journal_register(
  _branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL,
  _match_status text DEFAULT NULL, _limit integer DEFAULT 300)
RETURNS TABLE(
  invoice_id uuid, invoice_number text, invoice_date date, due_date date,
  supplier_id uuid, supplier_name text, branch_id uuid, property text,
  order_id uuid, order_number text, receipt_id uuid, grn_number text,
  amount numeric, tax_amount numeric, paid_amount numeric, variance numeric,
  status text, match_status text, exception_count integer, critical_count integer,
  line_count integer, journal_id uuid, journal_number text, journal_status text,
  accounting_date date, total_debit numeric, total_credit numeric, balanced boolean,
  posted_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id();
BEGIN
  IF _org IS NULL OR NOT (public.is_org_admin() OR public.has_permission('finance','ap.view')
      OR public.has_permission('finance','view') OR public.can_read_general_ledger()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT si.id, si.invoice_number, si.invoice_date, si.due_date,
         si.supplier_id, s.name, si.branch_id, b.name,
         si.order_id, po.order_number, si.receipt_id, gr.grn_number,
         COALESCE(si.amount,0), COALESCE(si.tax_amount,0), COALESCE(si.paid_amount,0), COALESCE(si.variance,0),
         si.status, COALESCE(si.match_status,'unmatched'),
         (SELECT count(*)::int FROM public.supplier_invoice_discrepancies d
           WHERE d.supplier_invoice_id = si.id AND d.resolved = false),
         (SELECT count(*)::int FROM public.supplier_invoice_discrepancies d
           WHERE d.supplier_invoice_id = si.id AND d.resolved = false AND d.severity = 'critical'),
         (SELECT count(*)::int FROM public.supplier_invoice_lines il WHERE il.supplier_invoice_id = si.id),
         j.id, j.journal_number, j.status, j.accounting_date,
         COALESCE(j.total_debit,0), COALESCE(j.total_credit,0),
         CASE WHEN j.id IS NULL THEN false
              ELSE abs(COALESCE(j.total_debit,0) - COALESCE(j.total_credit,0)) < 0.01 END,
         j.posted_at
    FROM public.supplier_invoices si
    LEFT JOIN public.suppliers s ON s.id = si.supplier_id
    LEFT JOIN public.branches b ON b.id = si.branch_id
    LEFT JOIN public.purchase_orders po ON po.id = si.order_id
    LEFT JOIN public.goods_receipts gr ON gr.id = si.receipt_id
    LEFT JOIN public.journal_entries j ON j.id = si.journal_id
   WHERE si.organization_id = _org
     AND (_branch IS NULL OR si.branch_id = _branch)
     AND (_from IS NULL OR si.invoice_date >= _from)
     AND (_to IS NULL OR si.invoice_date <= _to)
     AND (_match_status IS NULL OR COALESCE(si.match_status,'unmatched') = _match_status)
   ORDER BY si.invoice_date DESC NULLS LAST, si.created_at DESC
   LIMIT greatest(1, least(coalesce(_limit,300), 1000));
END $function$;

REVOKE ALL ON FUNCTION public.neo_ap_journal_register(uuid,date,date,text,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_ap_journal_register(uuid,date,date,text,integer) TO authenticated;

-- 6. Deposit reconciliation ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_deposit_reconciliation(
  _branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL, _limit integer DEFAULT 300)
RETURNS TABLE(
  deposit_id uuid, reservation_id uuid, confirmation_number text,
  guest_name text, branch_id uuid, property text,
  arrival_date date, departure_date date, reservation_status text,
  amount numeric, currency text, method text, reference text, deposit_status text,
  received_at timestamptz, required_amount numeric, paid_amount numeric, outstanding_amount numeric,
  applied_folio_id uuid, applied_at timestamptz,
  posting_status text, posting_receipt_id uuid, posting_error text,
  journal_id uuid, journal_number text, journal_debit numeric, journal_credit numeric,
  journal_status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id();
BEGIN
  IF _org IS NULL OR NOT (public.is_org_admin() OR public.has_permission('finance','view')
      OR public.can_read_guest_ledger() OR public.has_permission('pms','reservations.view')) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT d.id, d.reservation_id, r.confirmation_number,
         COALESCE(c.full_name, 'Guest'), d.branch_id, b.name,
         r.arrival_date, r.departure_date, r.status,
         COALESCE(d.amount,0), COALESCE(d.currency,'KES'), d.method, d.reference, d.status,
         d.received_at,
         COALESCE(r.deposit_required,0),
         COALESCE((SELECT sum(x.amount) FROM public.reservation_deposits x
                    WHERE x.reservation_id = d.reservation_id AND x.status IN ('held','applied')),0),
         GREATEST(COALESCE(r.deposit_required,0)
                  - COALESCE((SELECT sum(x.amount) FROM public.reservation_deposits x
                               WHERE x.reservation_id = d.reservation_id AND x.status IN ('held','applied')),0), 0),
         d.applied_folio_id, d.applied_at,
         pr.status, pr.id, pr.last_error,
         j.id, j.journal_number, COALESCE(j.total_debit,0), COALESCE(j.total_credit,0), j.status
    FROM public.reservation_deposits d
    LEFT JOIN public.reservations r ON r.id = d.reservation_id
    LEFT JOIN public.customers c ON c.id = d.customer_id
    LEFT JOIN public.branches b ON b.id = d.branch_id
    LEFT JOIN LATERAL (
      SELECT x.* FROM public.finance_posting_receipts x
       WHERE x.organization_id = _org AND x.source_id = d.id
       ORDER BY x.created_at DESC LIMIT 1) pr ON true
    LEFT JOIN public.journal_entries j ON j.id = pr.journal_id
   WHERE d.organization_id = _org
     AND (_branch IS NULL OR d.branch_id = _branch)
     AND (_from IS NULL OR d.received_at::date >= _from)
     AND (_to IS NULL OR d.received_at::date <= _to)
   ORDER BY d.received_at DESC NULLS LAST
   LIMIT greatest(1, least(coalesce(_limit,300), 1000));
END $function$;

REVOKE ALL ON FUNCTION public.neo_deposit_reconciliation(uuid,date,date,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_deposit_reconciliation(uuid,date,date,integer) TO authenticated;

-- 7. Held matching blocks payable creation -------------------------------------
CREATE OR REPLACE FUNCTION public.neo_block_payable_when_held()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE _match text; _num text;
BEGIN
  IF NEW.supplier_invoice_id IS NULL THEN RETURN NEW; END IF;
  SELECT COALESCE(match_status,'unmatched'), invoice_number INTO _match, _num
    FROM public.supplier_invoices WHERE id = NEW.supplier_invoice_id;
  IF _match = 'held' THEN
    RAISE EXCEPTION 'Payable blocked — invoice % is held on three-way matching. Resolve the exceptions or accept the invoice with authority first.', COALESCE(_num,'');
  END IF;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS payment_schedules_block_held ON public.payment_schedules;
CREATE TRIGGER payment_schedules_block_held BEFORE INSERT ON public.payment_schedules
  FOR EACH ROW EXECUTE FUNCTION public.neo_block_payable_when_held();

DROP TRIGGER IF EXISTS supplier_payments_block_held ON public.supplier_payments;
CREATE TRIGGER supplier_payments_block_held BEFORE INSERT ON public.supplier_payments
  FOR EACH ROW EXECUTE FUNCTION public.neo_block_payable_when_held();
