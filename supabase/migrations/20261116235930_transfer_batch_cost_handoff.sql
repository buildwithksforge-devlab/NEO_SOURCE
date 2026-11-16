-- STAGED ONLY: preserve saved dispatch cost, batches and expiry on transfer receipt/cancellation.
-- Requires inventory_batch_cost_integrity; legacy untraceable transfers fail for explicit reconciliation.
BEGIN;
DO $column$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.stock_movements'::regclass AND attname='batch_allocations' AND atttypid='jsonb'::regtype AND NOT attisdropped) THEN
 RAISE EXCEPTION 'Install inventory batch allocation support first'; END IF;
END $column$;
DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
 WHERE p.oid=to_regprocedure('public.neo_stores_transfer_create(uuid,uuid,uuid,jsonb,text,uuid)') AND r.rolname NOT IN ('anon','authenticated')
 AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g')) IN ('c0bf30ff492ab4681108bfbf4c99db45','f28e327f7bf148d8badeebe06a9c0c45')) THEN
 RAISE EXCEPTION 'neo_stores_transfer_create differs from reviewed batch handoff source; nothing replaced'; END IF;
END $guard$;
DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
 WHERE p.oid=to_regprocedure('public.neo_stores_transfer_receive(uuid)') AND r.rolname NOT IN ('anon','authenticated')
 AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g')) IN ('87173768d65093625ced1b3a56e6f0e2','6efd03c1624d9a213cbaa9b50ee4488d')) THEN
 RAISE EXCEPTION 'neo_stores_transfer_receive differs from reviewed batch handoff source; nothing replaced'; END IF;
END $guard$;
DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
 WHERE p.oid=to_regprocedure('public.neo_stores_transfer_cancel(uuid,text)') AND r.rolname NOT IN ('anon','authenticated')
 AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g')) IN ('bbe415b646c0a3fbe7f8d99fd03ce395','c8167819335bc365a2b568e1d55551a3')) THEN
 RAISE EXCEPTION 'neo_stores_transfer_cancel differs from reviewed batch handoff source; nothing replaced'; END IF;
END $guard$;
CREATE TEMP TABLE neo_transfer_batch_acl ON COMMIT DROP AS SELECT oid,proowner,coalesce(proacl::text,'') acl FROM pg_proc
 WHERE oid IN ('public.neo_stores_transfer_create(uuid,uuid,uuid,jsonb,text,uuid)'::regprocedure,'public.neo_stores_transfer_receive(uuid)'::regprocedure,'public.neo_stores_transfer_cancel(uuid,text)'::regprocedure);
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
  v_qty_base numeric;
  v_unit text;
  v_line_id uuid;
  v_onhand numeric;
  v_count integer := 0;
BEGIN
  IF auth.uid() IS NULL OR v_org IS NULL THEN RAISE EXCEPTION 'No organisation context'; END IF;
  IF NOT coalesce(public.neo_can_transfer_stock(),false) THEN
    RAISE EXCEPTION 'Not permitted to transfer stock between stores';
  END IF;
  IF _branch IS NULL OR NOT coalesce(public.neo_branch_in_scope(_branch),false) THEN
    RAISE EXCEPTION 'Select a property you work at before transferring stock';
  END IF;
  IF _from IS NULL OR _to IS NULL THEN RAISE EXCEPTION 'Choose both a source and a destination store'; END IF;
  IF _from = _to THEN RAISE EXCEPTION 'The source and destination store must be different'; END IF;

  IF _attempt IS NULL THEN RAISE EXCEPTION 'A durable transfer attempt key is required'; END IF;
  IF nullif(btrim(_reason),'') IS NULL THEN RAISE EXCEPTION 'Give a reason for transferring stock'; END IF;
  IF _lines IS NULL OR jsonb_typeof(_lines) <> 'array' OR jsonb_array_length(_lines) = 0 THEN
    RAISE EXCEPTION 'Add at least one item to transfer';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_org::text || ':transfer:' || _attempt::text,0));
  -- replay: the same submission never posts twice
  IF _attempt IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.stock_transfers
     WHERE organization_id = v_org AND attempt_key = _attempt::text;
    IF v_existing.id IS NOT NULL THEN
      IF v_existing.branch_id IS DISTINCT FROM _branch OR v_existing.from_location_id IS DISTINCT FROM _from
        OR v_existing.to_location_id IS DISTINCT FROM _to OR v_existing.reason IS DISTINCT FROM btrim(_reason)
        OR (SELECT jsonb_agg(jsonb_build_array(l.stock_item_id,l.quantity,l.unit) ORDER BY l.stock_item_id,l.quantity,l.unit)
            FROM public.stock_transfer_lines l WHERE l.transfer_id=v_existing.id)
          IS DISTINCT FROM
           (SELECT jsonb_agg(jsonb_build_array((j->>'stock_item_id')::uuid,(j->>'quantity')::numeric,
             coalesce(nullif(j->>'unit',''),si.base_unit)) ORDER BY (j->>'stock_item_id')::uuid,(j->>'quantity')::numeric,coalesce(nullif(j->>'unit',''),si.base_unit))
            FROM jsonb_array_elements(_lines) j LEFT JOIN public.stock_items si ON si.id=(j->>'stock_item_id')::uuid) THEN
        RAISE EXCEPTION 'Transfer attempt belongs to different work; refresh the original transfer before retrying';
      END IF;
      RETURN jsonb_build_object('ok', true, 'replayed', true, 'transfer_id', v_existing.id,
                                'transfer_number', v_existing.transfer_number, 'status', v_existing.status);
    END IF;
  END IF;

  PERFORM 1 FROM public.stock_locations
   WHERE id = _from AND organization_id = v_org AND branch_id IS NOT DISTINCT FROM _branch AND active IS TRUE;
  IF NOT FOUND THEN RAISE EXCEPTION 'The source store does not belong to this property'; END IF;
  PERFORM 1 FROM public.stock_locations
   WHERE id = _to AND organization_id = v_org AND branch_id IS NOT DISTINCT FROM _branch AND active IS TRUE;
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
    IF v_qty::text IN ('NaN','Infinity','-Infinity') OR v_qty <= 0 THEN RAISE EXCEPTION 'Every transfer quantity must be greater than zero'; END IF;

    PERFORM 1 FROM public.stock_items
     WHERE id = v_item AND organization_id = v_org
       AND (branch_id IS NULL OR branch_id = _branch) AND active IS TRUE;
    IF NOT FOUND THEN RAISE EXCEPTION 'That item is not part of this property''s catalogue'; END IF;

    SELECT coalesce(quantity_on_hand, 0) INTO v_onhand
      FROM public.stock_levels WHERE stock_item_id = v_item AND location_id = _from FOR UPDATE;
    v_qty_base:=public.inventory_convert_strict(v_qty,coalesce(v_unit,(SELECT base_unit FROM public.stock_items WHERE id=v_item)),(SELECT base_unit FROM public.stock_items WHERE id=v_item));
    IF v_qty_base IS NULL OR v_qty_base<=0 OR v_qty_base::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Invalid transfer unit conversion'; END IF;
    IF coalesce(v_onhand, 0) < v_qty_base THEN
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

CREATE OR REPLACE FUNCTION public.neo_stores_transfer_receive(_transfer uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  v_org uuid := public.current_org_id();
  t public.stock_transfers;
  l record;
  dispatch record;
  allocation record;
  batch_record record;
  saved_allocations jsonb;
  base_quantity numeric;
  tracks_batches boolean;
  v_count integer := 0;
BEGIN
  IF auth.uid() IS NULL OR v_org IS NULL THEN RAISE EXCEPTION 'No organisation context'; END IF;
  IF NOT coalesce(public.neo_can_transfer_stock(),false) THEN
    RAISE EXCEPTION 'Not permitted to receive a store transfer';
  END IF;

  SELECT * INTO t FROM public.stock_transfers
   WHERE id = _transfer AND organization_id = v_org FOR UPDATE;
  IF t.id IS NULL THEN RAISE EXCEPTION 'Transfer not found'; END IF;
  IF NOT coalesce(public.neo_branch_in_scope(t.branch_id),false) THEN
    RAISE EXCEPTION 'Transfer is outside your property scope' USING ERRCODE='42501';
  END IF;
  IF t.status = 'completed' THEN
    RETURN jsonb_build_object('ok', true, 'transfer_id', _transfer, 'replayed', true, 'status', 'completed',
                              'transfer_number', t.transfer_number);
  END IF;
  IF t.status = 'cancelled' THEN RAISE EXCEPTION 'This transfer was cancelled'; END IF;
  IF t.status IS DISTINCT FROM 'in-transit' THEN RAISE EXCEPTION 'Only an in-transit transfer can be received'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.stock_transfer_lines WHERE transfer_id=_transfer) THEN
    RAISE EXCEPTION 'Transfer has no saved stock lines';
  END IF;

  PERFORM set_config('neo.system_posting', '1', true);

  FOR l IN SELECT * FROM public.stock_transfer_lines WHERE transfer_id = _transfer LOOP
    SELECT * INTO dispatch FROM public.stock_movements
      WHERE organization_id=v_org AND idempotency_key='transfer-out:'||_transfer::text||':'||l.id::text;
    base_quantity:=public.inventory_convert_strict(l.quantity,l.unit,(SELECT base_unit FROM public.stock_items WHERE id=l.stock_item_id));
    SELECT track_batches INTO tracks_batches FROM public.stock_items WHERE id=l.stock_item_id AND organization_id=v_org;
    IF dispatch.id IS NULL OR dispatch.stock_item_id IS DISTINCT FROM l.stock_item_id
      OR dispatch.location_id IS DISTINCT FROM t.from_location_id OR dispatch.branch_id IS DISTINCT FROM t.branch_id
      OR dispatch.reference_type IS DISTINCT FROM 'stock_transfer' OR dispatch.reference_id IS DISTINCT FROM _transfer
      OR dispatch.movement_type IS DISTINCT FROM 'transfer-out' OR dispatch.quantity IS DISTINCT FROM -base_quantity
      OR dispatch.unit_cost IS NULL OR dispatch.unit_cost<0 OR dispatch.unit_cost::text IN ('NaN','Infinity','-Infinity') THEN
      RAISE EXCEPTION 'Saved transfer dispatch quantity, source or cost needs reconciliation';
    END IF;
    saved_allocations:=coalesce(dispatch.batch_allocations,'[]'::jsonb);
    IF jsonb_typeof(saved_allocations) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Saved dispatch batches need reconciliation'; END IF;
    IF jsonb_array_length(saved_allocations)=0 THEN
      IF tracks_batches THEN RAISE EXCEPTION 'Saved dispatch has no batch allocations; reconcile before receipt or cancellation'; END IF;
      saved_allocations:=jsonb_build_array(jsonb_build_object('batch_id',null,'quantity',dispatch.quantity));
    END IF;
    IF (SELECT sum((part->>'quantity')::numeric) FROM jsonb_array_elements(saved_allocations) part) IS DISTINCT FROM dispatch.quantity
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(saved_allocations) part WHERE nullif(part->>'quantity','') IS NULL
        OR (part->>'quantity')::numeric>=0 OR ((part->>'quantity')::numeric)::text IN ('NaN','Infinity','-Infinity')) THEN
      RAISE EXCEPTION 'Saved dispatch batch quantities do not reconcile';
    END IF;
    FOR allocation IN SELECT value,ordinality FROM jsonb_array_elements(saved_allocations) WITH ORDINALITY LOOP
      IF nullif(allocation.value->>'batch_id','') IS NOT NULL THEN
        SELECT * INTO batch_record FROM public.stock_batches WHERE id=(allocation.value->>'batch_id')::uuid
          AND organization_id=v_org AND stock_item_id=l.stock_item_id AND location_id=t.from_location_id;
        IF batch_record.id IS NULL OR NOT (allocation.value ? 'batch_number' AND allocation.value ? 'expiry_date') THEN
          RAISE EXCEPTION 'Saved dispatch batch identity and expiry need reconciliation';
        END IF;
      ELSIF tracks_batches THEN RAISE EXCEPTION 'Tracked transfer has an unidentified source batch';
      END IF;
      PERFORM public.inventory_apply_movement(
        l.stock_item_id,t.to_location_id,-(allocation.value->>'quantity')::numeric,dispatch.unit,'transfer-in',dispatch.unit_cost,
        'stock_transfer',_transfer,t.reason,
        'transfer-in:'||_transfer::text||':'||l.id::text||':batch:'||allocation.ordinality::text,
        allocation.value->>'batch_number',nullif(allocation.value->>'expiry_date','')::date);
    END LOOP;
    UPDATE public.stock_transfer_lines SET received_quantity = l.quantity, updated_at = now() WHERE id = l.id;
    v_count := v_count + 1;
  END LOOP;

  PERFORM set_config('neo.system_posting', '0', true);

  UPDATE public.stock_transfers
     SET status = 'completed', received_at = now(), received_by = auth.uid(), updated_at = now()
   WHERE id = _transfer;

  RETURN jsonb_build_object('ok', true, 'transfer_id', _transfer, 'replayed', false, 'status', 'completed',
                            'transfer_number', t.transfer_number, 'lines', v_count);
END $function$;

CREATE OR REPLACE FUNCTION public.neo_stores_transfer_cancel(_transfer uuid, _reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  v_org uuid := public.current_org_id();
  t public.stock_transfers;
  l record;
  dispatch record;
  allocation record;
  batch_record record;
  saved_allocations jsonb;
  base_quantity numeric;
  tracks_batches boolean;
BEGIN
  IF auth.uid() IS NULL OR v_org IS NULL THEN RAISE EXCEPTION 'No organisation context'; END IF;
  IF NOT coalesce(public.neo_can_transfer_stock(),false) THEN
    RAISE EXCEPTION 'Not permitted to cancel a store transfer';
  END IF;
  IF coalesce(btrim(_reason), '') = '' THEN RAISE EXCEPTION 'Give a reason for cancelling'; END IF;

  SELECT * INTO t FROM public.stock_transfers
   WHERE id = _transfer AND organization_id = v_org FOR UPDATE;
  IF t.id IS NULL THEN RAISE EXCEPTION 'Transfer not found'; END IF;
  IF NOT coalesce(public.neo_branch_in_scope(t.branch_id),false) THEN
    RAISE EXCEPTION 'Transfer is outside your property scope' USING ERRCODE='42501';
  END IF;
  IF t.status = 'cancelled' THEN
    RETURN jsonb_build_object('ok', true, 'transfer_id', _transfer, 'replayed', true, 'status', 'cancelled');
  END IF;
  IF t.status = 'completed' THEN
    RAISE EXCEPTION 'This transfer has already been received — reverse it with a new transfer';
  END IF;

  PERFORM set_config('neo.system_posting', '1', true);
  IF t.status IS DISTINCT FROM 'in-transit' THEN RAISE EXCEPTION 'Only an in-transit transfer can be cancelled'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.stock_transfer_lines WHERE transfer_id=_transfer) THEN
    RAISE EXCEPTION 'Transfer has no saved stock lines';
  END IF;
  FOR l IN SELECT * FROM public.stock_transfer_lines WHERE transfer_id = _transfer LOOP
    SELECT * INTO dispatch FROM public.stock_movements
      WHERE organization_id=v_org AND idempotency_key='transfer-out:'||_transfer::text||':'||l.id::text;
    base_quantity:=public.inventory_convert_strict(l.quantity,l.unit,(SELECT base_unit FROM public.stock_items WHERE id=l.stock_item_id));
    SELECT track_batches INTO tracks_batches FROM public.stock_items WHERE id=l.stock_item_id AND organization_id=v_org;
    IF dispatch.id IS NULL OR dispatch.stock_item_id IS DISTINCT FROM l.stock_item_id
      OR dispatch.location_id IS DISTINCT FROM t.from_location_id OR dispatch.branch_id IS DISTINCT FROM t.branch_id
      OR dispatch.reference_type IS DISTINCT FROM 'stock_transfer' OR dispatch.reference_id IS DISTINCT FROM _transfer
      OR dispatch.movement_type IS DISTINCT FROM 'transfer-out' OR dispatch.quantity IS DISTINCT FROM -base_quantity
      OR dispatch.unit_cost IS NULL OR dispatch.unit_cost<0 OR dispatch.unit_cost::text IN ('NaN','Infinity','-Infinity') THEN
      RAISE EXCEPTION 'Saved transfer dispatch quantity, source or cost needs reconciliation';
    END IF;
    saved_allocations:=coalesce(dispatch.batch_allocations,'[]'::jsonb);
    IF jsonb_typeof(saved_allocations) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Saved dispatch batches need reconciliation'; END IF;
    IF jsonb_array_length(saved_allocations)=0 THEN
      IF tracks_batches THEN RAISE EXCEPTION 'Saved dispatch has no batch allocations; reconcile before receipt or cancellation'; END IF;
      saved_allocations:=jsonb_build_array(jsonb_build_object('batch_id',null,'quantity',dispatch.quantity));
    END IF;
    IF (SELECT sum((part->>'quantity')::numeric) FROM jsonb_array_elements(saved_allocations) part) IS DISTINCT FROM dispatch.quantity
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(saved_allocations) part WHERE nullif(part->>'quantity','') IS NULL
        OR (part->>'quantity')::numeric>=0 OR ((part->>'quantity')::numeric)::text IN ('NaN','Infinity','-Infinity')) THEN
      RAISE EXCEPTION 'Saved dispatch batch quantities do not reconcile';
    END IF;
    FOR allocation IN SELECT value,ordinality FROM jsonb_array_elements(saved_allocations) WITH ORDINALITY LOOP
      IF nullif(allocation.value->>'batch_id','') IS NOT NULL THEN
        SELECT * INTO batch_record FROM public.stock_batches WHERE id=(allocation.value->>'batch_id')::uuid
          AND organization_id=v_org AND stock_item_id=l.stock_item_id AND location_id=t.from_location_id;
        IF batch_record.id IS NULL OR NOT (allocation.value ? 'batch_number' AND allocation.value ? 'expiry_date') THEN
          RAISE EXCEPTION 'Saved dispatch batch identity and expiry need reconciliation';
        END IF;
      ELSIF tracks_batches THEN RAISE EXCEPTION 'Tracked transfer has an unidentified source batch';
      END IF;
      PERFORM public.inventory_apply_movement(
        l.stock_item_id,t.from_location_id,-(allocation.value->>'quantity')::numeric,dispatch.unit,'transfer-cancel',dispatch.unit_cost,
        'stock_transfer',_transfer,btrim(_reason),
        'transfer-cancel:'||_transfer::text||':'||l.id::text||':batch:'||allocation.ordinality::text,
        allocation.value->>'batch_number',nullif(allocation.value->>'expiry_date','')::date);
    END LOOP;
  END LOOP;
  PERFORM set_config('neo.system_posting', '0', true);

  UPDATE public.stock_transfers
     SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
         notes = coalesce(notes || ' | ', '') || btrim(_reason), updated_at = now()
   WHERE id = _transfer;

  RETURN jsonb_build_object('ok', true, 'transfer_id', _transfer, 'replayed', false, 'status', 'cancelled');
END $function$;
DO $verify$ BEGIN
 IF EXISTS(SELECT 1 FROM neo_transfer_batch_acl old LEFT JOIN pg_proc p ON p.oid=old.oid
 WHERE p.oid IS NULL OR p.proowner<>old.proowner OR coalesce(p.proacl::text,'')<>old.acl) THEN
 RAISE EXCEPTION 'Transfer batch handoff owner or grants changed'; END IF;
END $verify$;
COMMIT;
