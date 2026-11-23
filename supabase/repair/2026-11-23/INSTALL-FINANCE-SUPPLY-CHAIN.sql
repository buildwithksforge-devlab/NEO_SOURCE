-- Run in the existing NEØ project's Lovable SQL editor. Safe to rerun for this release.
-- All four migrations succeed together or the transaction rolls back.
BEGIN;

-- 20261123100000_delete_unused_sales_tax_profiles
CREATE OR REPLACE FUNCTION public.neo_sales_tax_guard_profile_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF OLD.active OR OLD.workspace_default THEN
    RAISE EXCEPTION 'Archive the sales tax profile before deleting it.' USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.pos_order_items i
    WHERE i.organization_id=OLD.organization_id AND i.sales_tax_snapshot->>'profile_id'=OLD.id::text
  ) THEN
    RAISE EXCEPTION 'This profile appears on saved sales. Keep it archived to preserve that history.' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_sales_tax_guard_profile_delete() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS sales_tax_profile_guard_delete ON public.sales_tax_profiles;
CREATE TRIGGER sales_tax_profile_guard_delete BEFORE DELETE ON public.sales_tax_profiles
FOR EACH ROW EXECUTE FUNCTION public.neo_sales_tax_guard_profile_delete();

GRANT DELETE ON public.sales_tax_profiles TO authenticated;
DROP POLICY IF EXISTS sales_tax_profile_delete ON public.sales_tax_profiles;
CREATE POLICY sales_tax_profile_delete ON public.sales_tax_profiles FOR DELETE TO authenticated
USING (organization_id=public.current_org_id() AND public.is_org_admin() AND NOT active);

-- 20261123101500_pos_split_tender_shared_headroom
CREATE INDEX IF NOT EXISTS cash_requests_pos_pending_order_idx
ON public.cash_payment_requests (organization_id, source_record_id)
WHERE source_module='pos' AND status='pending';

CREATE OR REPLACE FUNCTION public.neo_pos_guard_new_collection()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  order_id_to_check uuid;
  order_row public.pos_orders;
  converting_request_id uuid;
  reserved numeric;
BEGIN
  IF TG_TABLE_NAME = 'cash_payment_requests' THEN
    IF NEW.source_module IS DISTINCT FROM 'pos' OR NEW.status IS DISTINCT FROM 'pending' THEN
      RETURN NEW;
    END IF;
    order_id_to_check := NEW.source_record_id;
  ELSE
    IF NEW.status NOT IN ('confirmed', 'initiated', 'pending') THEN
      RETURN NEW;
    END IF;
    order_id_to_check := NEW.order_id;
  END IF;

  -- Every collection writer shares the order lock, including direct inserts.
  SELECT * INTO order_row FROM public.pos_orders o
  WHERE o.id=order_id_to_check AND o.organization_id=NEW.organization_id
  FOR UPDATE;
  IF NOT FOUND OR order_row.branch_id IS DISTINCT FROM NEW.branch_id
      OR order_row.currency IS DISTINCT FROM NEW.currency THEN
    RAISE EXCEPTION 'Collection property or currency does not match the bill.' USING ERRCODE='23514';
  END IF;
  IF NEW.amount IS NULL OR NEW.amount::text IN ('NaN','Infinity','-Infinity')
      OR NEW.amount<=0 OR NEW.amount<>round(NEW.amount,2)
      OR order_row.grand_total IS NULL OR order_row.grand_total::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'Collection requires a finite amount and a valid bill total.' USING ERRCODE='23514';
  END IF;

  IF TG_TABLE_NAME = 'pos_payments' AND NEW.status='confirmed' AND NEW.method='cash' THEN
    -- Cashier confirmation converts its own reservation into a payment row.
    SELECT r.id INTO converting_request_id FROM public.cash_payment_requests r
    WHERE r.organization_id=NEW.organization_id AND r.source_module='pos'
      AND r.source_record_id=order_id_to_check AND r.status='pending'
      AND r.branch_id IS NOT DISTINCT FROM NEW.branch_id AND r.currency=NEW.currency
      AND r.amount=NEW.amount AND r.method=NEW.method AND r.assigned_shift_id=NEW.shift_id
      AND (r.assigned_cashier_id IS NULL OR r.assigned_cashier_id=NEW.cashier_id)
      AND NEW.idempotency_key='cash-request:'||r.id::text;
  END IF;

  SELECT coalesce((
      SELECT sum(p.amount) FROM public.pos_payments p
      WHERE p.organization_id=NEW.organization_id AND p.order_id=order_id_to_check
        AND p.status IN ('confirmed','initiated','pending')
    ),0) + CASE WHEN converting_request_id IS NOT NULL THEN 0 ELSE coalesce((
      SELECT sum(r.amount) FROM public.cash_payment_requests r
      WHERE r.organization_id=NEW.organization_id AND r.source_module='pos'
        AND r.source_record_id=order_id_to_check AND r.status='pending'
    ),0) END INTO reserved;

  -- Conversion does not create a new reservation. Legacy orders may have
  -- duplicate pending cash requests; settling one may proceed up to the
  -- remaining confirmed/provider balance while the others are reconciled.

  IF reserved::text IN ('NaN','Infinity','-Infinity') OR reserved<0 THEN
    RAISE EXCEPTION 'Saved collection amounts need reconciliation before taking another payment.' USING ERRCODE='23514';
  END IF;
  IF NEW.amount > round(order_row.grand_total-reserved,2) THEN
    RAISE EXCEPTION 'Only % remains available after confirmed payments and requests awaiting confirmation.',
      greatest(round(order_row.grand_total-reserved,2),0) USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_pos_guard_new_collection() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS neo_pos_reserve_cash_request ON public.cash_payment_requests;
CREATE TRIGGER neo_pos_reserve_cash_request BEFORE INSERT ON public.cash_payment_requests
FOR EACH ROW EXECUTE FUNCTION public.neo_pos_guard_new_collection();
DROP TRIGGER IF EXISTS neo_pos_reserve_payment ON public.pos_payments;
CREATE TRIGGER neo_pos_reserve_payment BEFORE INSERT ON public.pos_payments
FOR EACH ROW EXECUTE FUNCTION public.neo_pos_guard_new_collection();

-- 20261123103000_procurement_recommended_quote_lpo_prices
CREATE OR REPLACE FUNCTION public.neo_procurement_order_from_request(_request uuid, _supplier uuid, _expected date, _attempt uuid, _location uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _r record; _order uuid; _number text;
        _prior jsonb; _lines integer := 0; _subtotal numeric := 0; _unlinked text;
        _quote public.supplier_quotations; _quote_count integer; _quote_lines integer;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'no_organisation' USING ERRCODE='42501'; END IF;
  IF _attempt IS NULL THEN RAISE EXCEPTION 'attempt_key_required' USING ERRCODE='22023'; END IF;

  SELECT result INTO _prior FROM public.procurement_attempts
   WHERE organization_id=_org AND action='order.create' AND attempt_key=_attempt;
  IF _prior IS NOT NULL THEN RETURN _prior || jsonb_build_object('replayed', true); END IF;

  IF NOT (public.has_permission('procurement','lpos.create') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE='42501';
  END IF;

  SELECT * INTO _r FROM public.purchase_requests WHERE id=_request AND organization_id=_org FOR UPDATE;
  IF _r IS NULL THEN RAISE EXCEPTION 'request_not_found' USING ERRCODE='22023'; END IF;
  IF NOT public.neo_branch_in_scope(_r.branch_id) THEN RAISE EXCEPTION 'branch_out_of_scope' USING ERRCODE='42501'; END IF;
  IF _r.status <> 'approved' THEN RAISE EXCEPTION 'request_not_approved' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.suppliers s WHERE s.id=_supplier AND s.organization_id=_org) THEN
    RAISE EXCEPTION 'supplier_not_approved' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.purchase_orders p
              WHERE p.request_id=_request AND p.status NOT IN ('cancelled','voided')) THEN
    RAISE EXCEPTION 'request_already_ordered' USING ERRCODE='23505';
  END IF;

  -- Lock the selected quotation while its pricing is copied into the draft.
  SELECT count(*) INTO _quote_count FROM public.supplier_quotations q
   WHERE q.organization_id=_org AND q.request_id=_request AND q.selected;
  IF _quote_count > 1 THEN
    RAISE EXCEPTION 'Resolve the multiple recommended quotations before creating this LPO' USING ERRCODE='23514';
  END IF;
  IF _quote_count = 1 THEN
    SELECT * INTO STRICT _quote FROM public.supplier_quotations q
     WHERE q.organization_id=_org AND q.request_id=_request AND q.selected FOR UPDATE;
    IF _quote.supplier_id IS DISTINCT FROM _supplier OR _quote.branch_id IS DISTINCT FROM _r.branch_id
       OR (_quote.valid_until IS NOT NULL AND _quote.valid_until < (now() AT TIME ZONE 'Africa/Nairobi')::date) THEN
      RAISE EXCEPTION 'Choose the recommended supplier and a current quotation for this property' USING ERRCODE='23514';
    END IF;
    LOCK TABLE public.supplier_quotation_lines IN SHARE MODE;
    SELECT count(*) INTO _quote_lines FROM public.supplier_quotation_lines WHERE quotation_id=_quote.id;
    IF _quote_lines = 0 THEN
      -- Older staff-entered quotations contain only a total.
      IF _quote.total_amount IS DISTINCT FROM (
        SELECT round(sum(quantity*coalesce(estimated_unit_price,0)),2)
        FROM public.purchase_request_lines WHERE request_id=_request AND organization_id=_org
      ) THEN
        RAISE EXCEPTION 'The recommended quotation total differs from the approved request. Record the quoted line prices before creating this LPO' USING ERRCODE='23514';
      END IF;
    ELSIF EXISTS (
      SELECT 1 FROM public.purchase_request_lines l
      WHERE l.request_id=_request AND l.organization_id=_org AND (
        SELECT count(*) FROM public.supplier_quotation_lines q
        WHERE q.organization_id=_org AND q.quotation_id=_quote.id AND q.request_line_id=l.id
          AND q.stock_item_id IS NOT DISTINCT FROM l.stock_item_id
          AND q.quantity=l.quantity AND q.unit IS NOT DISTINCT FROM l.unit
          AND q.tax_rate=0 AND q.unit_price>=0 AND q.unit_price::text NOT IN ('NaN','Infinity','-Infinity')
      )<>1
    ) OR _quote_lines
          <> (SELECT count(*) FROM public.purchase_request_lines WHERE request_id=_request AND organization_id=_org)
      OR _quote.total_amount IS DISTINCT FROM (
        SELECT round(sum(quantity*unit_price),2) FROM public.supplier_quotation_lines
        WHERE quotation_id=_quote.id AND organization_id=_org
      ) THEN
      RAISE EXCEPTION 'The recommended quotation needs matching line quantities, units, prices and total before it can become an LPO' USING ERRCODE='23514';
    END IF;
  END IF;

  -- Goods that must land in a store need a catalogue item, otherwise the
  -- delivery can never be received into the stock ledger.
  IF _location IS NOT NULL THEN
    SELECT string_agg(COALESCE(l.description,'Unnamed item'), ', ') INTO _unlinked
      FROM public.purchase_request_lines l
     WHERE l.request_id=_request AND l.organization_id=_org AND l.stock_item_id IS NULL;
    IF _unlinked IS NOT NULL THEN
      RAISE EXCEPTION 'Link % to a catalogue stock item before raising a store delivery order', _unlinked
        USING ERRCODE='22023';
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(_request::text, 42));
  _number := public.next_document_number('purchase_order','LPO', _r.branch_id);

  INSERT INTO public.purchase_orders (organization_id, branch_id, department_id, supplier_id, request_id,
    order_number, status, expected_date, deliver_to_location_id, currency, created_by, prepared_by, quotation_id)
  VALUES (_org, _r.branch_id, _r.department_id, _supplier, _request, _number, 'draft', _expected,
          _location, coalesce(_quote.currency,'KES'), auth.uid(), auth.uid(), _quote.id)
  RETURNING id INTO _order;

  INSERT INTO public.purchase_order_lines (organization_id, order_id, stock_item_id, description,
    quantity, unit, unit_price, line_total)
  SELECT _org, _order, l.stock_item_id, l.description, l.quantity, l.unit,
         coalesce(q.unit_price,l.estimated_unit_price,0), l.quantity * coalesce(q.unit_price,l.estimated_unit_price,0)
    FROM public.purchase_request_lines l
    LEFT JOIN public.supplier_quotation_lines q ON q.quotation_id=_quote.id AND q.request_line_id=l.id AND q.organization_id=_org
    WHERE l.request_id=_request AND l.organization_id=_org;

  SELECT count(*), COALESCE(sum(line_total),0) INTO _lines, _subtotal
    FROM public.purchase_order_lines WHERE order_id=_order;
  UPDATE public.purchase_orders SET subtotal=_subtotal, total_amount=_subtotal WHERE id=_order;
  UPDATE public.purchase_requests SET status='ordered', updated_at=now() WHERE id=_request;

  _prior := jsonb_build_object('ok',true,'order_id',_order,'order_number',_number,
                               'lines',_lines,'subtotal',_subtotal,'status','draft');
  INSERT INTO public.procurement_attempts (organization_id, action, attempt_key, record_id, result)
  VALUES (_org,'order.create',_attempt,_order,_prior);
  RETURN _prior;
END $function$;

-- 20261123104500_partner_rfq_quotes
-- Use the same per-line currency rounding for the quote and draft order.
DO $rounding$
DECLARE definition text;
BEGIN
  definition := pg_get_functiondef('public.neo_procurement_order_from_request(uuid,uuid,date,uuid,uuid)'::regprocedure);
  IF strpos(definition,'SELECT round(sum(quantity*unit_price),2) FROM public.supplier_quotation_lines')=0
    OR strpos(definition,'l.quantity * coalesce(q.unit_price,l.estimated_unit_price,0)')=0 THEN
    RAISE EXCEPTION 'Install the recommended quote LPO pricing migration before supplier RFQs';
  END IF;
  definition := replace(definition,'SELECT round(sum(quantity*unit_price),2) FROM public.supplier_quotation_lines',
    'SELECT sum(round(quantity*unit_price,2)) FROM public.supplier_quotation_lines');
  definition := replace(definition,'l.quantity * coalesce(q.unit_price,l.estimated_unit_price,0)',
    'round(l.quantity * coalesce(q.unit_price,l.estimated_unit_price,0),2)');
  EXECUTE definition;
END;
$rounding$;

CREATE OR REPLACE FUNCTION public.neo_partner_rfq_quotes(
  _branch uuid, _relationship uuid, _rfq uuid DEFAULT NULL,
  _prices jsonb DEFAULT NULL, _valid_until date DEFAULT NULL, _notes text DEFAULT NULL,
  _previous uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  org uuid;
  supplier uuid;
  currency_code text;
  request_id_to_quote uuid;
  saved_id uuid;
  active_quote public.supplier_quotations;
  line_count integer;
  total numeric;
BEGIN
  SELECT b.organization_id,a.supplier_id,coalesce(b.currency,'KES')
  INTO org,supplier,currency_code
  FROM public.branches b
  JOIN public.neo_access_relationships a ON a.organization_id=b.organization_id
    AND (a.branch_id IS NULL OR a.branch_id=b.id)
  JOIN public.suppliers v ON v.id=a.supplier_id AND v.organization_id=b.organization_id
  WHERE b.id=_branch AND b.active AND a.id=_relationship AND a.auth_user_id=auth.uid()
    AND a.door='partner' AND a.status='active' AND a.relationship_type='supplier';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Supplier access is unavailable for this property' USING ERRCODE='42501';
  END IF;

  IF _rfq IS NULL THEN
    RETURN coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id',r.id,'number',r.rfq_number,'title',r.title,'closes_at',r.closes_at,
        'currency',currency_code,'quote_id',q.id,'total',q.total_amount,
        'valid_until',q.valid_until,'notes',q.notes,
        'can_quote',r.status='issued' AND (r.closes_at IS NULL OR r.closes_at>now())
          AND p.status IN ('submitted','pending_approval','under-review','approved') AND NOT coalesce(q.selected,false),
        'lines',(SELECT jsonb_agg(jsonb_build_object('id',l.id,'description',coalesce(l.description,'Requested item'),
          'quantity',l.quantity,'unit',l.unit,'price',ql.unit_price) ORDER BY l.created_at,l.id)
          FROM public.purchase_request_lines l LEFT JOIN public.supplier_quotation_lines ql
          ON ql.quotation_id=q.id AND ql.organization_id=org AND ql.request_line_id=l.id
          WHERE l.request_id=p.id AND l.organization_id=org)
      ) ORDER BY r.issued_at DESC NULLS LAST,r.id)
      FROM public.rfq_suppliers i
      JOIN public.rfqs r ON r.id=i.rfq_id AND r.organization_id=org AND r.branch_id=_branch
      JOIN public.purchase_requests p ON p.id=r.request_id AND p.organization_id=org AND p.branch_id=_branch
      LEFT JOIN LATERAL (
        SELECT sq.* FROM public.supplier_quotations sq WHERE sq.organization_id=org
          AND sq.rfq_id=r.id AND sq.supplier_id=supplier AND sq.status<>'superseded'
        ORDER BY sq.created_at DESC,sq.id LIMIT 1
      ) q ON true
      WHERE i.organization_id=org AND i.supplier_id=supplier AND i.dispatch_state IN ('sent','marked-sent')
        AND r.status<>'draft'
    ),'[]'::jsonb);
  END IF;

  SELECT p.id INTO request_id_to_quote
  FROM public.rfqs r
  JOIN public.purchase_requests p ON p.id=r.request_id AND p.organization_id=org AND p.branch_id=_branch
  JOIN public.rfq_suppliers i ON i.rfq_id=r.id AND i.organization_id=org AND i.supplier_id=supplier
  WHERE r.id=_rfq AND r.organization_id=org AND r.branch_id=_branch AND r.status='issued'
    AND (r.closes_at IS NULL OR r.closes_at>now()) AND p.status IN ('submitted','pending_approval','under-review','approved')
    AND i.dispatch_state IN ('sent','marked-sent')
  FOR UPDATE OF p,r,i;
  IF NOT FOUND THEN RAISE EXCEPTION 'This invitation is closed or unavailable' USING ERRCODE='42501'; END IF;

  SELECT * INTO active_quote FROM public.supplier_quotations q
  WHERE q.organization_id=org AND q.rfq_id=_rfq AND q.supplier_id=supplier AND q.status<>'superseded'
  ORDER BY q.created_at DESC,q.id LIMIT 1 FOR UPDATE;
  IF active_quote.id IS DISTINCT FROM _previous OR coalesce(active_quote.selected,false) THEN
    RAISE EXCEPTION 'The quotation changed or was selected. Refresh before revising it.' USING ERRCODE='23514';
  END IF;
  IF jsonb_typeof(_prices) IS DISTINCT FROM 'object' OR length(coalesce(_notes,''))>2000
    OR _valid_until IS NULL OR _valid_until<(now() AT TIME ZONE 'Africa/Nairobi')::date THEN
    RAISE EXCEPTION 'Enter line prices and a current validity date.' USING ERRCODE='22023';
  END IF;
  SELECT count(*),sum(round(l.quantity*(_prices->>l.id::text)::numeric,2)) INTO line_count,total
  FROM public.purchase_request_lines l WHERE l.organization_id=org AND l.request_id=request_id_to_quote
    AND l.quantity>0 AND l.quantity::text NOT IN ('NaN','Infinity','-Infinity')
    AND (_prices->>l.id::text) ~ '^[0-9]{1,12}(\.[0-9]{1,2})?$';
  IF line_count=0 OR total<=0 OR line_count<>(SELECT count(*) FROM jsonb_object_keys(_prices))
    OR line_count<>(SELECT count(*) FROM public.purchase_request_lines l WHERE l.organization_id=org AND l.request_id=request_id_to_quote) THEN
    RAISE EXCEPTION 'Give a valid price for every requested line.' USING ERRCODE='22023';
  END IF;

  IF active_quote.id IS NOT NULL THEN
    UPDATE public.supplier_quotations SET status='superseded' WHERE id=active_quote.id;
  END IF;
  INSERT INTO public.supplier_quotations(organization_id,branch_id,supplier_id,request_id,rfq_id,
    quotation_number,status,valid_until,total_amount,currency,notes)
  VALUES(org,_branch,supplier,request_id_to_quote,_rfq,'QT-'||gen_random_uuid()::text,
    'received',_valid_until,total,currency_code,nullif(btrim(_notes),''))
  RETURNING id INTO saved_id;
  INSERT INTO public.supplier_quotation_lines(organization_id,quotation_id,request_line_id,stock_item_id,
    description,quantity,unit,unit_price)
  SELECT org,saved_id,l.id,l.stock_item_id,l.description,l.quantity,l.unit,(_prices->>l.id::text)::numeric
  FROM public.purchase_request_lines l WHERE l.organization_id=org AND l.request_id=request_id_to_quote;
  UPDATE public.rfq_suppliers SET responded_at=now() WHERE rfq_id=_rfq AND supplier_id=supplier AND organization_id=org;
  RETURN jsonb_build_object('id',saved_id,'total',total,'currency',currency_code);
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_partner_rfq_quotes(uuid,uuid,uuid,jsonb,date,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_partner_rfq_quotes(uuid,uuid,uuid,jsonb,date,text,uuid) TO authenticated;
NOTIFY pgrst,'reload schema';

COMMIT;
