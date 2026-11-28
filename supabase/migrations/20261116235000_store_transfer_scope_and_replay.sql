-- STAGED ONLY: protect future transfer actions and replay; no historical stock rows changed.
BEGIN;
DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
 WHERE p.oid=to_regprocedure('public.neo_stores_transfer_create(uuid,uuid,uuid,jsonb,text,uuid)') AND r.rolname NOT IN ('anon','authenticated')
 AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g')) IN ('933c1d149a696d2cbf31471c7aa84efe','c0bf30ff492ab4681108bfbf4c99db45')) THEN
 RAISE EXCEPTION 'neo_stores_transfer_create differs from reviewed source; nothing replaced'; END IF;
END $guard$;
DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
 WHERE p.oid=to_regprocedure('public.neo_stores_transfer_receive(uuid)') AND r.rolname NOT IN ('anon','authenticated')
 AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g')) IN ('68238a027dfc8d6917f52049a06e59ba','87173768d65093625ced1b3a56e6f0e2')) THEN
 RAISE EXCEPTION 'neo_stores_transfer_receive differs from reviewed source; nothing replaced'; END IF;
END $guard$;
DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
 WHERE p.oid=to_regprocedure('public.neo_stores_transfer_cancel(uuid,text)') AND r.rolname NOT IN ('anon','authenticated')
 AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g')) IN ('832182ec5816f619378a68b721c539e9','bbe415b646c0a3fbe7f8d99fd03ce395')) THEN
 RAISE EXCEPTION 'neo_stores_transfer_cancel differs from reviewed source; nothing replaced'; END IF;
END $guard$;
CREATE TEMP TABLE neo_transfer_repair_acl ON COMMIT DROP AS
 SELECT oid,proowner,coalesce(proacl::text,'') acl FROM pg_proc
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

  RETURN jsonb_build_object('ok', true, 'transfer_id', _transfer, 'replayed', false, 'status', 'cancelled');
END $function$;
DO $verify$ BEGIN
 IF EXISTS(SELECT 1 FROM neo_transfer_repair_acl old LEFT JOIN pg_proc p ON p.oid=old.oid
 WHERE p.oid IS NULL OR p.proowner<>old.proowner OR coalesce(p.proacl::text,'')<>old.acl) THEN
 RAISE EXCEPTION 'Transfer owner or grants changed'; END IF;
END $verify$;
COMMIT;
