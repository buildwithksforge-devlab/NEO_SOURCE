
-- 1. Storekeeper returns a department requisition with a reason
CREATE OR REPLACE FUNCTION public.neo_stores_requisition_reject(_requisition uuid, _reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_org uuid := current_org_id(); v_req record;
BEGIN
  IF _reason IS NULL OR btrim(_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required when returning a requisition';
  END IF;
  IF NOT (has_permission('stores','approve') OR has_permission('stores','edit') OR is_org_admin()) THEN
    RAISE EXCEPTION 'Only Stores may return a department requisition';
  END IF;
  SELECT * INTO v_req FROM internal_requisitions WHERE id = _requisition AND organization_id = v_org FOR UPDATE;
  IF v_req IS NULL THEN RAISE EXCEPTION 'Unknown requisition'; END IF;
  IF v_req.status IN ('issued','received','closed','cancelled','rejected') THEN
    RAISE EXCEPTION 'This requisition can no longer be returned';
  END IF;
  UPDATE internal_requisitions
     SET status = 'rejected',
         store_reviewed_by = auth.uid(),
         store_reviewed_at = now(),
         shortage_notes = _reason
   WHERE id = _requisition;
  RETURN jsonb_build_object('ok', true, 'status', 'rejected');
END;
$$;
REVOKE ALL ON FUNCTION public.neo_stores_requisition_reject(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_stores_requisition_reject(uuid, text) TO authenticated;

-- 2. Controlled variance: a count raises an adjustment for approval, never posts itself
CREATE OR REPLACE FUNCTION public.neo_stores_count_submit_variance(_take uuid, _notes text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := current_org_id();
  s record; l record;
  v_adj uuid; v_lines int := 0; v_value numeric := 0; v_number text;
BEGIN
  IF NOT (has_permission('stores','edit') OR has_permission('inventory','stocktake.manage') OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to submit stock count variances';
  END IF;
  SELECT * INTO s FROM stock_takes WHERE id = _take AND organization_id = v_org FOR UPDATE;
  IF s IS NULL THEN RAISE EXCEPTION 'Stock take not found'; END IF;
  IF s.status IN ('closed','awaiting-approval') THEN
    RETURN jsonb_build_object('status', s.status, 'adjustment', NULL);
  END IF;

  UPDATE stock_take_lines
     SET variance = counted_quantity - system_quantity
   WHERE stock_take_id = _take AND counted_quantity IS NOT NULL;

  SELECT count(*) INTO v_lines FROM stock_take_lines
   WHERE stock_take_id = _take AND counted_quantity IS NOT NULL AND counted_quantity <> system_quantity;

  IF v_lines = 0 THEN
    UPDATE stock_takes SET status = 'closed', completed_at = now(), variance_value = 0 WHERE id = _take;
    RETURN jsonb_build_object('status','closed','adjustment',NULL,'lines',0);
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
            WHERE stock_take_id = _take AND counted_quantity IS NOT NULL AND counted_quantity <> system_quantity LOOP
    INSERT INTO stock_adjustment_lines (organization_id, adjustment_id, stock_item_id, quantity, unit, unit_cost, reason)
    VALUES (v_org, v_adj, l.stock_item_id, l.counted_quantity - l.system_quantity, l.unit, l.unit_cost,
            'Count variance');
    v_value := v_value + abs((l.counted_quantity - l.system_quantity) * COALESCE(NULLIF(l.unit_cost,0),0));
  END LOOP;

  UPDATE stock_adjustments SET total_value = v_value WHERE id = v_adj;
  UPDATE stock_takes SET status = 'awaiting-approval', completed_at = now(), variance_value = v_value,
                         counted_by = COALESCE(counted_by, auth.uid())
   WHERE id = _take;

  RETURN jsonb_build_object('status','awaiting-approval','adjustment',v_adj,'lines',v_lines,'value',v_value);
END;
$$;
REVOKE ALL ON FUNCTION public.neo_stores_count_submit_variance(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_stores_count_submit_variance(uuid, text) TO authenticated;

-- 3. No self-approval of stock adjustments
CREATE OR REPLACE FUNCTION public.neo_stores_no_self_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'posted' AND OLD.status <> 'posted'
     AND NEW.requested_by IS NOT NULL
     AND NEW.approved_by IS NOT NULL
     AND NEW.approved_by = NEW.requested_by
     AND NOT is_org_admin() THEN
    RAISE EXCEPTION 'A stock adjustment cannot be approved by the person who raised it';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS neo_stores_no_self_approval_trg ON public.stock_adjustments;
CREATE TRIGGER neo_stores_no_self_approval_trg
BEFORE UPDATE ON public.stock_adjustments
FOR EACH ROW EXECUTE FUNCTION public.neo_stores_no_self_approval();

-- 4. Department feature templates
DELETE FROM public.role_feature_templates WHERE role_key IN ('storekeeper','receiving-clerk') AND module = 'stores';

INSERT INTO public.role_feature_templates (role_key, module, feature, action)
SELECT 'storekeeper', 'stores', f, a
FROM unnest(ARRAY['overview','issues','requisitions','counts','transfers','tasks','approvals','reports','reconciliation','valuation']) f
CROSS JOIN unnest(ARRAY['view','create','edit','export','print']) a
ON CONFLICT DO NOTHING;

INSERT INTO public.role_feature_templates (role_key, module, feature, action)
VALUES ('storekeeper','stores','approvals','approve'),
       ('storekeeper','stores','counts','approve'),
       ('storekeeper','stores','requisitions','approve')
ON CONFLICT DO NOTHING;

INSERT INTO public.role_feature_templates (role_key, module, feature, action)
VALUES ('receiving-clerk','stores','overview','view'),
       ('receiving-clerk','stores','tasks','view'),
       ('receiving-clerk','stores','tasks','edit')
ON CONFLICT DO NOTHING;
