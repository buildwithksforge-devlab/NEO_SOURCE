-- O06: Correct numeric linen discrepancy posting.
-- Preserve the existing laundry return and linen incident workflow.
-- No historical linen or guest laundry records modified.

CREATE OR REPLACE FUNCTION public.neo_laundry_batch_return(_batch uuid DEFAULT NULL, _lines jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := current_org_id();
  b record; l jsonb; li record;
  v_returned numeric; v_damaged numeric; v_missing numeric;
  v_incidents int := 0; v_guest_notes text := '';
BEGIN
  SELECT * INTO b FROM laundry_batches WHERE id = _batch AND organization_id = v_org FOR UPDATE;
  IF b IS NULL THEN RAISE EXCEPTION 'Unknown laundry batch'; END IF;
  IF NOT (has_exact_permission('laundry','batches','edit')
          OR is_org_admin()
          OR (b.attendant_id = auth.uid() AND has_exact_permission('laundry','my-work','edit'))) THEN
    RAISE EXCEPTION 'Not permitted to hand this batch back';
  END IF;

  FOR l IN SELECT * FROM jsonb_array_elements(COALESCE(_lines,'[]'::jsonb)) LOOP
    SELECT * INTO li FROM laundry_batch_items
      WHERE id = (l->>'id')::uuid AND batch_id = _batch AND organization_id = v_org FOR UPDATE;
    CONTINUE WHEN li IS NULL;

    v_returned := COALESCE((l->>'returned_quantity')::numeric, li.quantity);
    v_damaged := COALESCE((l->>'damaged_quantity')::numeric, 0);
    v_missing := GREATEST(li.quantity - v_returned - v_damaged, 0);

    IF v_returned + v_damaged > li.quantity THEN
      RAISE EXCEPTION 'More items returned than were handed over on this line';
    END IF;

    UPDATE laundry_batch_items
       SET returned_quantity = v_returned,
           damaged_quantity = v_damaged,
           missing_quantity = v_missing
     WHERE id = li.id;

    IF li.item_kind = 'guest' OR li.linen_item_id IS NULL THEN
      -- Guest garments never touch hotel linen stock; discrepancies belong to the guest order.
      IF li.guest_laundry_item_id IS NOT NULL THEN
        UPDATE guest_laundry_items
           SET counted_quantity = v_returned,
               condition_notes = COALESCE(NULLIF(l->>'notes',''), condition_notes)
         WHERE id = li.guest_laundry_item_id AND organization_id = v_org;
      END IF;
      IF (v_damaged + v_missing) > 0 THEN
        v_guest_notes := v_guest_notes || COALESCE(li.description,'Garment')
          || ': ' || v_damaged::text || ' damaged, ' || v_missing::text || ' missing. ';
        v_incidents := v_incidents + 1;
      END IF;
      CONTINUE;
    END IF;

    INSERT INTO linen_movements (
      organization_id, branch_id, linen_item_id, from_state, to_state,
      from_department_id, to_department_id, batch_id, quantity, received_quantity,
      discrepancy, performed_by, confirmed_by, confirmed_at
    ) VALUES (
      v_org, b.branch_id, li.linen_item_id, 'in-laundry', 'clean',
      NULL, b.source_department_id, _batch, li.quantity, v_returned,
      (v_damaged + v_missing), auth.uid(), auth.uid(), now()
    );

    IF v_damaged > 0 THEN
      INSERT INTO linen_incidents (
        organization_id, branch_id, linen_item_id, quantity, department_id,
        reason, condition, responsible_process, reported_by, status
      ) VALUES (
        v_org, b.branch_id, li.linen_item_id, v_damaged, b.source_department_id,
        COALESCE(l->>'notes','Damaged during laundry processing'), 'damaged', 'laundry', auth.uid(), 'reported'
      );
      v_incidents := v_incidents + 1;
    END IF;

    IF v_missing > 0 THEN
      INSERT INTO linen_incidents (
        organization_id, branch_id, linen_item_id, quantity, department_id,
        reason, condition, responsible_process, reported_by, status
      ) VALUES (
        v_org, b.branch_id, li.linen_item_id, v_missing, b.source_department_id,
        COALESCE(l->>'notes','Not returned from laundry'), 'missing', 'laundry', auth.uid(), 'reported'
      );
      v_incidents := v_incidents + 1;
    END IF;
  END LOOP;

  IF v_guest_notes <> '' AND b.guest_order_id IS NOT NULL THEN
    UPDATE guest_laundry_orders
       SET discrepancy_notes = concat_ws(' ', NULLIF(discrepancy_notes,''), v_guest_notes)
     WHERE id = b.guest_order_id AND organization_id = v_org;
  END IF;

  UPDATE laundry_batches
     SET status = 'completed', completed_at = now()
   WHERE id = _batch;

  RETURN jsonb_build_object('ok', true, 'incidents', v_incidents);
END;
$$;
