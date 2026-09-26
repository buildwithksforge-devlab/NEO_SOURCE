-- ===========================================================================
-- L-TRANSFER-01 : store transfer as its own inventory transaction type
-- L-SHORT-01    : one stock-need lifecycle with lineage and deduplication
-- Additive only: no drops, no data loss.
-- ===========================================================================

ALTER TABLE public.stock_transfers
  ADD COLUMN IF NOT EXISTS attempt_key text,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by uuid;

CREATE UNIQUE INDEX IF NOT EXISTS stock_transfers_attempt_uidx
  ON public.stock_transfers (organization_id, attempt_key)
  WHERE attempt_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS stock_transfers_status_idx
  ON public.stock_transfers (organization_id, branch_id, status, created_at DESC);

ALTER TABLE public.department_stock_needs
  ADD COLUMN IF NOT EXISTS stock_item_id uuid REFERENCES public.stock_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS fulfilled_quantity numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS purchase_request_id uuid REFERENCES public.purchase_requests(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'reported',
  ADD COLUMN IF NOT EXISTS issued_from_location_id uuid REFERENCES public.stock_locations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS department_stock_needs_open_idx
  ON public.department_stock_needs (organization_id, branch_id, status, created_at DESC);

-- ---------------------------------------------------------------------------
-- helper: may this person move stock between stores?
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_can_transfer_stock()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $function$
  SELECT public.has_permission('inventory','transfers.manage')
      OR public.has_permission('inventory','stock.manage')
      OR public.has_permission('stores','issues','edit')
      OR public.is_org_admin();
$function$;

-- ---------------------------------------------------------------------------
-- create a transfer and send it: source is deducted, destination waits
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_stores_transfer_create(
  _branch uuid,
  _from uuid,
  _to uuid,
  _lines jsonb,
  _reason text DEFAULT NULL,
  _attempt uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  v_org uuid := public.current_org_id();
  v_existing public.stock_transfers;
  v_transfer uuid;
  v_number text;
  v_line jsonb;
  v_item uuid;
  v_qty numeric;
  v_unit text;
  v_line_id uuid;
  v_onhand numeric;
  v_count integer := 0;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No organisation context'; END IF;
  IF NOT public.neo_can_transfer_stock() THEN
    RAISE EXCEPTION 'Not permitted to transfer stock between stores';
  END IF;
  IF _branch IS NULL OR NOT (_branch = ANY (public.current_branch_ids())) THEN
    RAISE EXCEPTION 'Select a property you work at before transferring stock';
  END IF;
  IF _from IS NULL OR _to IS NULL THEN RAISE EXCEPTION 'Choose both a source and a destination store'; END IF;
  IF _from = _to THEN RAISE EXCEPTION 'The source and destination store must be different'; END IF;

  -- replay: the same submission never posts twice
  IF _attempt IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.stock_transfers
     WHERE organization_id = v_org AND attempt_key = _attempt::text;
    IF v_existing.id IS NOT NULL THEN
      RETURN jsonb_build_object('ok', true, 'replayed', true, 'transfer_id', v_existing.id,
                                'transfer_number', v_existing.transfer_number, 'status', v_existing.status);
    END IF;
  END IF;

  PERFORM 1 FROM public.stock_locations
   WHERE id = _from AND organization_id = v_org AND branch_id IS NOT DISTINCT FROM _branch;
  IF NOT FOUND THEN RAISE EXCEPTION 'The source store does not belong to this property'; END IF;
  PERFORM 1 FROM public.stock_locations
   WHERE id = _to AND organization_id = v_org AND branch_id IS NOT DISTINCT FROM _branch;
  IF NOT FOUND THEN RAISE EXCEPTION 'The destination store does not belong to this property'; END IF;

  IF _lines IS NULL OR jsonb_array_length(_lines) = 0 THEN
    RAISE EXCEPTION 'Add at least one item to transfer';
  END IF;

  SELECT public.next_document_number('stock-transfer') INTO v_number;

  INSERT INTO public.stock_transfers (
    organization_id, branch_id, transfer_number, from_location_id, to_location_id,
    status, reason, requested_by, dispatched_by, dispatched_at, attempt_key
  ) VALUES (
    v_org, _branch, v_number, _from, _to, 'in-transit', nullif(btrim(coalesce(_reason,'')), ''),
    auth.uid(), auth.uid(), now(), _attempt::text
  ) RETURNING id INTO v_transfer;

  PERFORM set_config('neo.system_posting', '1', true);

  FOR v_line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    v_item := nullif(v_line->>'stock_item_id','')::uuid;
    v_qty  := coalesce((v_line->>'quantity')::numeric, 0);
    v_unit := nullif(v_line->>'unit','');

    IF v_item IS NULL THEN RAISE EXCEPTION 'Every transfer line needs a stock item'; END IF;
    IF v_qty <= 0 THEN RAISE EXCEPTION 'Every transfer quantity must be greater than zero'; END IF;

    PERFORM 1 FROM public.stock_items
     WHERE id = v_item AND organization_id = v_org
       AND (branch_id IS NULL OR branch_id = _branch);
    IF NOT FOUND THEN RAISE EXCEPTION 'That item is not part of this property''s catalogue'; END IF;

    SELECT coalesce(quantity_on_hand, 0) INTO v_onhand
      FROM public.stock_levels WHERE stock_item_id = v_item AND location_id = _from;
    IF coalesce(v_onhand, 0) < v_qty THEN
      RAISE EXCEPTION 'The source store holds only % of the % requested', coalesce(v_onhand,0), v_qty;
    END IF;

    INSERT INTO public.stock_transfer_lines (organization_id, transfer_id, stock_item_id, quantity, unit)
    VALUES (v_org, v_transfer, v_item, v_qty,
            coalesce(v_unit, (SELECT base_unit FROM public.stock_items WHERE id = v_item)))
    RETURNING id INTO v_line_id;

    PERFORM public.inventory_apply_movement(
      v_item, _from, -v_qty, v_unit, 'transfer-out', NULL,
      'stock_transfer', v_transfer, nullif(btrim(coalesce(_reason,'')), ''),
      'transfer-out:' || v_transfer::text || ':' || v_line_id::text, NULL, NULL);

    v_count := v_count + 1;
  END LOOP;

  PERFORM set_config('neo.system_posting', '0', true);

  RETURN jsonb_build_object('ok', true, 'replayed', false, 'transfer_id', v_transfer,
                            'transfer_number', v_number, 'status', 'in-transit', 'lines', v_count);
END $function$;

-- ---------------------------------------------------------------------------
-- destination acknowledges receipt: the stock arrives, exactly once
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_stores_transfer_receive(_transfer uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  v_org uuid := public.current_org_id();
  t public.stock_transfers;
  l record;
  v_count integer := 0;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No organisation context'; END IF;
  IF NOT public.neo_can_transfer_stock() THEN
    RAISE EXCEPTION 'Not permitted to receive a store transfer';
  END IF;

  SELECT * INTO t FROM public.stock_transfers
   WHERE id = _transfer AND organization_id = v_org FOR UPDATE;
  IF t.id IS NULL THEN RAISE EXCEPTION 'Transfer not found'; END IF;
  IF t.status = 'completed' THEN
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'status', 'completed',
                              'transfer_number', t.transfer_number);
  END IF;
  IF t.status = 'cancelled' THEN RAISE EXCEPTION 'This transfer was cancelled'; END IF;

  PERFORM set_config('neo.system_posting', '1', true);

  FOR l IN SELECT * FROM public.stock_transfer_lines WHERE transfer_id = _transfer LOOP
    PERFORM public.inventory_apply_movement(
      l.stock_item_id, t.to_location_id, l.quantity, l.unit, 'transfer-in', NULL,
      'stock_transfer', _transfer, t.reason,
      'transfer-in:' || _transfer::text || ':' || l.id::text, NULL, NULL);
    UPDATE public.stock_transfer_lines SET received_quantity = l.quantity, updated_at = now() WHERE id = l.id;
    v_count := v_count + 1;
  END LOOP;

  PERFORM set_config('neo.system_posting', '0', true);

  UPDATE public.stock_transfers
     SET status = 'completed', received_at = now(), received_by = auth.uid(), updated_at = now()
   WHERE id = _transfer;

  RETURN jsonb_build_object('ok', true, 'replayed', false, 'status', 'completed',
                            'transfer_number', t.transfer_number, 'lines', v_count);
END $function$;

-- ---------------------------------------------------------------------------
-- cancel a transfer still in transit: the stock returns to the source
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_stores_transfer_cancel(_transfer uuid, _reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  v_org uuid := public.current_org_id();
  t public.stock_transfers;
  l record;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No organisation context'; END IF;
  IF NOT public.neo_can_transfer_stock() THEN
    RAISE EXCEPTION 'Not permitted to cancel a store transfer';
  END IF;
  IF coalesce(btrim(_reason), '') = '' THEN RAISE EXCEPTION 'Give a reason for cancelling'; END IF;

  SELECT * INTO t FROM public.stock_transfers
   WHERE id = _transfer AND organization_id = v_org FOR UPDATE;
  IF t.id IS NULL THEN RAISE EXCEPTION 'Transfer not found'; END IF;
  IF t.status = 'cancelled' THEN
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'status', 'cancelled');
  END IF;
  IF t.status = 'completed' THEN
    RAISE EXCEPTION 'This transfer has already been received — reverse it with a new transfer';
  END IF;

  PERFORM set_config('neo.system_posting', '1', true);
  FOR l IN SELECT * FROM public.stock_transfer_lines WHERE transfer_id = _transfer LOOP
    PERFORM public.inventory_apply_movement(
      l.stock_item_id, t.from_location_id, l.quantity, l.unit, 'transfer-cancel', NULL,
      'stock_transfer', _transfer, btrim(_reason),
      'transfer-cancel:' || _transfer::text || ':' || l.id::text, NULL, NULL);
  END LOOP;
  PERFORM set_config('neo.system_posting', '0', true);

  UPDATE public.stock_transfers
     SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
         notes = coalesce(notes || ' | ', '') || btrim(_reason), updated_at = now()
   WHERE id = _transfer;

  RETURN jsonb_build_object('ok', true, 'replayed', false, 'status', 'cancelled');
END $function$;

-- ---------------------------------------------------------------------------
-- stock need: issue what the store actually holds (all or part of it)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_stock_need_fulfil(
  _need uuid,
  _location uuid,
  _quantity numeric,
  _attempt uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  v_org uuid := public.current_org_id();
  n public.department_stock_needs;
  v_onhand numeric;
  v_outstanding numeric;
  v_key text;
  v_status text;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No organisation context'; END IF;
  IF NOT public.neo_can_transfer_stock() THEN
    RAISE EXCEPTION 'Not permitted to issue stock against a need';
  END IF;

  SELECT * INTO n FROM public.department_stock_needs
   WHERE id = _need AND organization_id = v_org FOR UPDATE;
  IF n.id IS NULL THEN RAISE EXCEPTION 'Stock need not found'; END IF;
  IF n.stock_item_id IS NULL THEN
    RAISE EXCEPTION 'Link this need to a stock item before issuing against it';
  END IF;
  IF coalesce(_quantity, 0) <= 0 THEN RAISE EXCEPTION 'Enter the quantity being issued'; END IF;

  v_outstanding := n.quantity - coalesce(n.fulfilled_quantity, 0);
  IF v_outstanding <= 0 THEN
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'status', n.status);
  END IF;
  IF _quantity > v_outstanding THEN
    RAISE EXCEPTION 'Only % remain outstanding on this need', v_outstanding;
  END IF;

  PERFORM 1 FROM public.stock_locations
   WHERE id = _location AND organization_id = v_org
     AND branch_id IS NOT DISTINCT FROM n.branch_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'That store does not belong to the requesting property'; END IF;

  SELECT coalesce(quantity_on_hand, 0) INTO v_onhand
    FROM public.stock_levels WHERE stock_item_id = n.stock_item_id AND location_id = _location;
  IF coalesce(v_onhand, 0) < _quantity THEN
    RAISE EXCEPTION 'The store holds only % — issue that, then route the shortfall to Procurement', coalesce(v_onhand,0);
  END IF;

  v_key := 'need-issue:' || _need::text || ':' || coalesce(_attempt::text, md5(_quantity::text || _location::text));
  IF EXISTS (SELECT 1 FROM public.stock_movements
              WHERE organization_id = v_org AND idempotency_key = v_key) THEN
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'status', n.status);
  END IF;

  PERFORM set_config('neo.system_posting', '1', true);
  PERFORM public.inventory_apply_movement(
    n.stock_item_id, _location, -_quantity, n.unit, 'issue', NULL,
    'department_stock_need', _need, 'Issued against reported need', v_key, NULL, NULL);
  PERFORM set_config('neo.system_posting', '0', true);

  v_status := CASE WHEN coalesce(n.fulfilled_quantity,0) + _quantity >= n.quantity
                   THEN 'fulfilled' ELSE 'partially-fulfilled' END;

  UPDATE public.department_stock_needs
     SET fulfilled_quantity = coalesce(fulfilled_quantity, 0) + _quantity,
         issued_from_location_id = _location,
         status = v_status,
         reviewed_by = auth.uid(),
         reviewed_at = now(),
         updated_at = now()
   WHERE id = _need;

  RETURN jsonb_build_object('ok', true, 'replayed', false, 'status', v_status,
                            'issued', _quantity,
                            'outstanding', n.quantity - coalesce(n.fulfilled_quantity,0) - _quantity);
END $function$;

-- ---------------------------------------------------------------------------
-- stock need: route whatever is left to Procurement, once
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_stock_need_to_procurement(_need uuid, _notes text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  v_org uuid := public.current_org_id();
  n public.department_stock_needs;
  v_ref text;
  v_existing uuid;
  v_req uuid;
  v_number text;
  v_outstanding numeric;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No organisation context'; END IF;
  IF NOT (public.has_permission('procurement','requests.create')
          OR public.has_permission('procurement','create')
          OR public.has_permission('stores','create')
          OR public.neo_can_transfer_stock()) THEN
    RAISE EXCEPTION 'Not permitted to route a shortage to Procurement';
  END IF;

  SELECT * INTO n FROM public.department_stock_needs
   WHERE id = _need AND organization_id = v_org FOR UPDATE;
  IF n.id IS NULL THEN RAISE EXCEPTION 'Stock need not found'; END IF;
  IF n.branch_id IS NULL THEN RAISE EXCEPTION 'This need has no property — it cannot be purchased against'; END IF;

  v_outstanding := greatest(n.quantity - coalesce(n.fulfilled_quantity, 0), 0);
  IF v_outstanding <= 0 THEN RAISE EXCEPTION 'This need has already been issued in full'; END IF;

  v_ref := 'need:' || _need::text;

  SELECT pr.id INTO v_existing FROM public.purchase_requests pr
   WHERE pr.organization_id = v_org
     AND pr.branch_id IS NOT DISTINCT FROM n.branch_id
     AND pr.source_reference = v_ref
     AND pr.status IN ('draft','submitted','pending','pending-approval')
   LIMIT 1;

  IF v_existing IS NOT NULL THEN
    UPDATE public.department_stock_needs
       SET purchase_request_id = v_existing, status = 'with-procurement', updated_at = now()
     WHERE id = _need;
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'request_id', v_existing,
      'request_number', (SELECT request_number FROM public.purchase_requests WHERE id = v_existing));
  END IF;

  SELECT public.next_document_number('purchase-request') INTO v_number;

  BEGIN
    INSERT INTO public.purchase_requests
      (organization_id, branch_id, department_id, request_number, title, justification,
       source, source_reference, status, priority, requested_by)
    VALUES (v_org, n.branch_id, n.department_id, v_number,
            'Department need — ' || n.item,
            coalesce(nullif(btrim(coalesce(_notes,'')), ''), n.notes,
                     'Reported by the department; not available in stores.'),
            'department-stock-need', v_ref, 'draft', coalesce(n.priority,'normal'), auth.uid())
    RETURNING id INTO v_req;

    INSERT INTO public.purchase_request_lines
      (organization_id, request_id, stock_item_id, description, quantity, unit, estimated_unit_price)
    VALUES (v_org, v_req, n.stock_item_id, n.item, v_outstanding, coalesce(n.unit,'unit'), 0);
  EXCEPTION WHEN unique_violation THEN
    SELECT pr.id INTO v_existing FROM public.purchase_requests pr
     WHERE pr.organization_id = v_org
       AND pr.branch_id IS NOT DISTINCT FROM n.branch_id
       AND pr.source_reference = v_ref
       AND pr.status IN ('draft','submitted','pending','pending-approval')
     LIMIT 1;
    UPDATE public.department_stock_needs
       SET purchase_request_id = v_existing, status = 'with-procurement', updated_at = now()
     WHERE id = _need;
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'request_id', v_existing);
  END;

  UPDATE public.department_stock_needs
     SET purchase_request_id = v_req, status = 'with-procurement',
         reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now()
   WHERE id = _need;

  RETURN jsonb_build_object('ok', true, 'duplicate', false, 'request_id', v_req,
                            'request_number', v_number, 'quantity', v_outstanding);
END $function$;

REVOKE ALL ON FUNCTION public.neo_can_transfer_stock() FROM anon;
REVOKE ALL ON FUNCTION public.neo_stores_transfer_create(uuid,uuid,uuid,jsonb,text,uuid) FROM anon;
REVOKE ALL ON FUNCTION public.neo_stores_transfer_receive(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.neo_stores_transfer_cancel(uuid,text) FROM anon;
REVOKE ALL ON FUNCTION public.neo_stock_need_fulfil(uuid,uuid,numeric,uuid) FROM anon;
REVOKE ALL ON FUNCTION public.neo_stock_need_to_procurement(uuid,text) FROM anon;

GRANT EXECUTE ON FUNCTION public.neo_can_transfer_stock() TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_stores_transfer_create(uuid,uuid,uuid,jsonb,text,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_stores_transfer_receive(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_stores_transfer_cancel(uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_stock_need_fulfil(uuid,uuid,numeric,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_stock_need_to_procurement(uuid,text) TO authenticated;
