CREATE OR REPLACE FUNCTION public.neo_stores_count_submit_variance(_take uuid, _notes text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_org uuid := current_org_id();
  s record; l record;
  v_adj uuid; v_lines int := 0; v_value numeric := 0; v_number text;
  v_invalid int := 0; v_counted int := 0; v_total int := 0;
BEGIN
  IF NOT (has_permission('stores','edit') OR has_permission('inventory','stocktake.manage') OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to submit stock count variances';
  END IF;
  SELECT * INTO s FROM stock_takes WHERE id = _take AND organization_id = v_org FOR UPDATE;
  IF s IS NULL THEN RAISE EXCEPTION 'Stock take not found'; END IF;
  IF s.status IN ('closed','awaiting-approval') THEN
    RETURN jsonb_build_object('status', s.status, 'adjustment', NULL);
  END IF;

  SELECT count(*), count(*) FILTER (WHERE counted_quantity IS NOT NULL),
         count(*) FILTER (WHERE counted_quantity < 0)
    INTO v_total, v_counted, v_invalid
    FROM stock_take_lines WHERE stock_take_id = _take;

  IF v_invalid > 0 THEN
    RAISE EXCEPTION 'count_line_invalid: % line(s) hold a negative physical count.', v_invalid
      USING HINT = 'Correct those lines before closing the count.';
  END IF;

  IF v_total > 0 AND v_counted = 0 THEN
    RAISE EXCEPTION 'count_not_started: no quantity has been counted on this count yet.'
      USING HINT = 'Record at least one counted quantity, or abandon the count.';
  END IF;

  UPDATE stock_take_lines
     SET variance = counted_quantity - COALESCE(system_quantity, 0)
   WHERE stock_take_id = _take AND counted_quantity IS NOT NULL;

  SELECT count(*) INTO v_lines FROM stock_take_lines
   WHERE stock_take_id = _take AND counted_quantity IS NOT NULL AND variance <> 0;

  IF v_lines = 0 THEN
    UPDATE stock_takes
       SET status = 'closed', completed_at = now(), variance_value = 0,
           counted_by = COALESCE(counted_by, auth.uid())
     WHERE id = _take;
    RETURN jsonb_build_object('status','closed','adjustment',NULL,'lines',0,'counted',v_counted,'total',v_total);
  END IF;

  BEGIN
    SELECT next_document_number('stock-adjustment') INTO v_number;
  EXCEPTION WHEN OTHERS THEN
    v_number := 'ADJ-' || to_char(now(), 'YYYYMMDDHH24MISS');
  END;

  INSERT INTO stock_adjustments (organization_id, branch_id, adjustment_number, location_id, reason, status, notes, requested_by)
  VALUES (v_org, s.branch_id, COALESCE(v_number, 'ADJ-' || to_char(now(),'YYYYMMDDHH24MISS')), s.location_id,
          'count-variance', 'pending',
          COALESCE(_notes, 'Variance from stock count ' || COALESCE(s.reference, _take::text)), auth.uid())
  RETURNING id INTO v_adj;

  FOR l IN SELECT * FROM stock_take_lines
            WHERE stock_take_id = _take AND counted_quantity IS NOT NULL AND variance <> 0 LOOP
    INSERT INTO stock_adjustment_lines (organization_id, adjustment_id, stock_item_id, quantity, unit, unit_cost, reason)
    VALUES (v_org, v_adj, l.stock_item_id, l.variance, l.unit, l.unit_cost,
            'Count variance: counted ' || l.counted_quantity || ' against system ' || COALESCE(l.system_quantity,0));
    v_value := v_value + abs(l.variance * COALESCE(NULLIF(l.unit_cost,0),0));
  END LOOP;

  UPDATE stock_adjustments SET total_value = v_value WHERE id = v_adj;
  UPDATE stock_takes SET status = 'awaiting-approval', completed_at = now(), variance_value = v_value,
                         counted_by = COALESCE(counted_by, auth.uid())
   WHERE id = _take;

  RETURN jsonb_build_object('status','awaiting-approval','adjustment',v_adj,'lines',v_lines,'value',v_value,
                            'counted',v_counted,'total',v_total);
END $$;