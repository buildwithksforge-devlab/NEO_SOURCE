-- ===========================================================================
-- NEØ Stores ↔ Procurement production integration (additive, reversible)
-- ===========================================================================

-- 1. Feature-level capability catalogue -------------------------------------
INSERT INTO public.permissions (module, feature, action, label)
SELECT m.module, m.feature, a.action,
       initcap(replace(m.feature,'-',' '))||' — '||a.action
FROM (VALUES
  ('procurement','requests'),
  ('procurement','receiving'),
  ('procurement','suppliers'),
  ('stores','issues'),
  ('stores','reconciliation')
) AS m(module, feature)
CROSS JOIN (VALUES ('view'),('create'),('edit'),('approve'),('reject'),
                   ('export'),('print'),('delete'),('override'),('void'),('refund')) AS a(action)
WHERE NOT EXISTS (
  SELECT 1 FROM public.permissions p
  WHERE p.module = m.module AND p.feature = m.feature AND p.action = a.action
);

-- 2. Role separation: purchasing authority vs custody authority -------------
DELETE FROM public.role_feature_templates
 WHERE role_key IN ('procurement-manager','procurement-officer','storekeeper','receiving-clerk')
   AND module IN ('procurement','stores');

INSERT INTO public.role_feature_templates (role_key, module, feature, action)
SELECT t.role_key, t.module, t.feature, a.action
FROM (VALUES
  ('procurement-manager','procurement','overview','view,export,print'),
  ('procurement-manager','procurement','requests','view,create,edit,approve,reject,export,print'),
  ('procurement-manager','procurement','lpos','view,create,edit,approve,reject,export,print'),
  ('procurement-manager','procurement','suppliers','view,create,edit,export,print'),
  ('procurement-manager','stores','overview','view,export'),
  ('procurement-manager','stores','reconciliation','view,export'),
  ('procurement-officer','procurement','overview','view'),
  ('procurement-officer','procurement','requests','view,create,edit'),
  ('procurement-officer','procurement','lpos','view,create,edit'),
  ('procurement-officer','procurement','suppliers','view,create,edit'),
  ('storekeeper','stores','overview','view,create,edit,export,print'),
  ('storekeeper','stores','issues','view,create,edit,export,print'),
  ('storekeeper','stores','reconciliation','view,export'),
  ('storekeeper','procurement','overview','view'),
  ('storekeeper','procurement','requests','view,create'),
  ('storekeeper','procurement','receiving','view,create,edit,export,print'),
  ('receiving-clerk','stores','overview','view'),
  ('receiving-clerk','procurement','receiving','view,create,edit')
) AS t(role_key, module, feature, actions)
CROSS JOIN LATERAL unnest(string_to_array(t.actions, ',')) AS a(action)
WHERE EXISTS (SELECT 1 FROM public.permissions p
               WHERE p.module = t.module AND p.feature = t.feature AND p.action = a.action)
ON CONFLICT DO NOTHING;

INSERT INTO public.role_feature_templates (role_key, module, feature, action)
SELECT 'storekeeper','kitchen','stores', a.action
FROM (VALUES ('view'),('create'),('edit'),('approve'),('export'),('print')) a(action)
WHERE EXISTS (SELECT 1 FROM public.permissions p WHERE p.module='kitchen' AND p.feature='stores' AND p.action=a.action)
  AND NOT EXISTS (SELECT 1 FROM public.role_feature_templates ft
                   WHERE ft.role_key='storekeeper' AND ft.module='kitchen' AND ft.feature='stores' AND ft.action=a.action);

-- 3. Per-submission idempotency for procurement/stores write paths ----------
CREATE TABLE IF NOT EXISTS public.procurement_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  action text NOT NULL,
  attempt_key uuid NOT NULL,
  record_id uuid,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, action, attempt_key)
);

GRANT SELECT, INSERT ON public.procurement_attempts TO authenticated;
GRANT ALL ON public.procurement_attempts TO service_role;
ALTER TABLE public.procurement_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS procurement_attempts_org_read ON public.procurement_attempts;
CREATE POLICY procurement_attempts_org_read ON public.procurement_attempts
  FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS procurement_attempts_org_write ON public.procurement_attempts;
CREATE POLICY procurement_attempts_org_write ON public.procurement_attempts
  FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id() AND created_by = auth.uid());

-- 4. Requisition lifecycle --------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_procurement_request_submit(_request uuid, _attempt uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE _org uuid := public.current_org_id(); _r record; _prior jsonb;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'no_organisation' USING ERRCODE='42501'; END IF;
  IF _attempt IS NULL THEN RAISE EXCEPTION 'attempt_key_required' USING ERRCODE='22023'; END IF;

  SELECT result INTO _prior FROM public.procurement_attempts
   WHERE organization_id=_org AND action='request.submit' AND attempt_key=_attempt;
  IF _prior IS NOT NULL THEN RETURN _prior || jsonb_build_object('replayed', true); END IF;

  SELECT * INTO _r FROM public.purchase_requests WHERE id=_request AND organization_id=_org;
  IF _r IS NULL THEN RAISE EXCEPTION 'request_not_found' USING ERRCODE='22023'; END IF;
  IF NOT public.neo_branch_in_scope(_r.branch_id) THEN RAISE EXCEPTION 'branch_out_of_scope' USING ERRCODE='42501'; END IF;
  IF NOT (public.has_permission('procurement','requests.create')
          OR public.has_permission('stores','requisition.create')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE='42501';
  END IF;
  IF _r.status NOT IN ('draft','rejected') THEN
    RAISE EXCEPTION 'request_not_submittable' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.purchase_request_lines WHERE request_id=_request) THEN
    RAISE EXCEPTION 'request_has_no_lines' USING ERRCODE='22023';
  END IF;

  UPDATE public.purchase_requests
     SET status='pending_approval', updated_at=now(),
         request_number = COALESCE(request_number, public.next_document_number('purchase_request','PR', branch_id))
   WHERE id=_request;

  SELECT jsonb_build_object('ok',true,'request_id',_request,'status','pending_approval',
                            'request_number', request_number)
    INTO _prior FROM public.purchase_requests WHERE id=_request;

  INSERT INTO public.procurement_attempts (organization_id, action, attempt_key, record_id, result)
  VALUES (_org,'request.submit',_attempt,_request,_prior);
  RETURN _prior;
END $fn$;

CREATE OR REPLACE FUNCTION public.neo_procurement_request_decide(_request uuid, _decision text, _reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE _org uuid := public.current_org_id(); _r record; _status text;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'no_organisation' USING ERRCODE='42501'; END IF;
  IF lower(coalesce(_decision,'')) NOT IN ('approve','reject') THEN
    RAISE EXCEPTION 'invalid_decision' USING ERRCODE='22023';
  END IF;
  SELECT * INTO _r FROM public.purchase_requests WHERE id=_request AND organization_id=_org FOR UPDATE;
  IF _r IS NULL THEN RAISE EXCEPTION 'request_not_found' USING ERRCODE='22023'; END IF;
  IF NOT public.neo_branch_in_scope(_r.branch_id) THEN RAISE EXCEPTION 'branch_out_of_scope' USING ERRCODE='42501'; END IF;
  IF NOT (public.has_permission('procurement','requests.approve') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE='42501';
  END IF;
  IF _r.requested_by = auth.uid() AND NOT public.is_org_admin() THEN
    RAISE EXCEPTION 'self_approval_refused' USING ERRCODE='42501';
  END IF;
  IF _r.status <> 'pending_approval' THEN RAISE EXCEPTION 'request_not_pending' USING ERRCODE='22023'; END IF;
  IF lower(_decision)='reject' AND nullif(btrim(coalesce(_reason,'')),'') IS NULL THEN
    RAISE EXCEPTION 'reason_required' USING ERRCODE='22023';
  END IF;

  _status := CASE WHEN lower(_decision)='approve' THEN 'approved' ELSE 'rejected' END;
  UPDATE public.purchase_requests
     SET status=_status, approved_by=auth.uid(), approved_at=now(),
         justification = COALESCE(justification,'') ||
           CASE WHEN _reason IS NULL THEN '' ELSE E'\n['||_status||'] '||_reason END,
         updated_at=now()
   WHERE id=_request;

  INSERT INTO public.audit_logs (organization_id, branch_id, module, action, record_id, user_id, reason, new_value)
  VALUES (_org, _r.branch_id, 'procurement', 'request.'||_status, _request::text, auth.uid(), _reason,
          jsonb_build_object('status', _status));

  RETURN jsonb_build_object('ok',true,'request_id',_request,'status',_status);
END $fn$;

-- 5. Requisition → LPO ------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_procurement_order_from_request(
  _request uuid, _supplier uuid, _expected date, _attempt uuid, _location uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE _org uuid := public.current_org_id(); _r record; _order uuid; _number text;
        _prior jsonb; _lines integer := 0; _subtotal numeric := 0;
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

  PERFORM pg_advisory_xact_lock(hashtextextended(_request::text, 42));
  _number := public.next_document_number('purchase_order','LPO', _r.branch_id);

  INSERT INTO public.purchase_orders (organization_id, branch_id, department_id, supplier_id, request_id,
    order_number, status, expected_date, deliver_to_location_id, currency, created_by, prepared_by)
  VALUES (_org, _r.branch_id, _r.department_id, _supplier, _request, _number, 'draft', _expected,
          _location, 'KES', auth.uid(), auth.uid())
  RETURNING id INTO _order;

  INSERT INTO public.purchase_order_lines (organization_id, order_id, stock_item_id, description,
    quantity, unit, unit_price, line_total)
  SELECT _org, _order, l.stock_item_id, l.description, l.quantity, l.unit,
         COALESCE(l.estimated_unit_price,0), l.quantity * COALESCE(l.estimated_unit_price,0)
    FROM public.purchase_request_lines l WHERE l.request_id=_request;

  SELECT count(*), COALESCE(sum(line_total),0) INTO _lines, _subtotal
    FROM public.purchase_order_lines WHERE order_id=_order;
  UPDATE public.purchase_orders SET subtotal=_subtotal, total_amount=_subtotal WHERE id=_order;
  UPDATE public.purchase_requests SET status='ordered', updated_at=now() WHERE id=_request;

  _prior := jsonb_build_object('ok',true,'order_id',_order,'order_number',_number,
                               'lines',_lines,'subtotal',_subtotal,'status','draft');
  INSERT INTO public.procurement_attempts (organization_id, action, attempt_key, record_id, result)
  VALUES (_org,'order.create',_attempt,_order,_prior);
  RETURN _prior;
END $fn$;

CREATE OR REPLACE FUNCTION public.neo_procurement_order_approve(_order uuid, _reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE _org uuid := public.current_org_id(); _p record;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'no_organisation' USING ERRCODE='42501'; END IF;
  SELECT * INTO _p FROM public.purchase_orders WHERE id=_order AND organization_id=_org FOR UPDATE;
  IF _p IS NULL THEN RAISE EXCEPTION 'order_not_found' USING ERRCODE='22023'; END IF;
  IF NOT public.neo_branch_in_scope(_p.branch_id) THEN RAISE EXCEPTION 'branch_out_of_scope' USING ERRCODE='42501'; END IF;
  IF NOT (public.has_permission('procurement','lpos.approve') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE='42501';
  END IF;
  IF _p.status NOT IN ('draft','pending_approval','pending-approval') THEN
    RAISE EXCEPTION 'order_not_approvable' USING ERRCODE='22023';
  END IF;

  UPDATE public.purchase_orders
     SET status='approved', approved_by=auth.uid(), approved_at=now(), updated_at=now()
   WHERE id=_order;

  INSERT INTO public.audit_logs (organization_id, branch_id, module, action, record_id, user_id, reason, new_value)
  VALUES (_org, _p.branch_id, 'procurement', 'order.approved', _order::text, auth.uid(), _reason,
          jsonb_build_object('status','approved','order_number',_p.order_number));

  RETURN jsonb_build_object('ok',true,'order_id',_order,'status','approved');
END $fn$;

-- 6. Receiving: partial receipts, over-receipt authority, exactly-once stock -
CREATE OR REPLACE FUNCTION public.neo_grn_guard_over_receipt()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE _ordered numeric; _already numeric;
BEGIN
  IF NEW.order_line_id IS NULL THEN RETURN NEW; END IF;

  SELECT coalesce(l.quantity, 0) - coalesce(l.cancelled_quantity, 0)
    INTO _ordered FROM public.purchase_order_lines l WHERE l.id = NEW.order_line_id;
  IF _ordered IS NULL THEN RETURN NEW; END IF;

  SELECT coalesce(sum(coalesce(g.quantity_received, 0)), 0) INTO _already
    FROM public.goods_receipt_lines g
   WHERE g.order_line_id = NEW.order_line_id
     AND g.id <> coalesce(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid);

  IF _already + coalesce(NEW.quantity_received, 0) > _ordered + 0.0001 THEN
    IF nullif(btrim(coalesce(NEW.over_receipt_reason,'')),'') IS NULL THEN
      RAISE EXCEPTION 'over_receipt_refused: % ordered, % already received, % now. Record an authorised over-receipt reason to proceed.',
        _ordered, _already, coalesce(NEW.quantity_received, 0) USING ERRCODE = '23514';
    END IF;
    IF NOT (public.has_permission('procurement','receiving.override') OR public.is_org_admin()) THEN
      RAISE EXCEPTION 'over_receipt_not_authorised' USING ERRCODE = '42501';
    END IF;
    IF NEW.over_receipt_authorised_by IS NULL THEN
      NEW.over_receipt_authorised_by := auth.uid();
    END IF;
    INSERT INTO public.audit_logs (organization_id, module, action, record_id, user_id, reason, new_value)
    VALUES (NEW.organization_id, 'procurement', 'receipt.over_receipt', NEW.id::text, auth.uid(),
            NEW.over_receipt_reason,
            jsonb_build_object('ordered', _ordered, 'already_received', _already,
                               'now_received', coalesce(NEW.quantity_received,0)));
  END IF;

  RETURN NEW;
END $fn$;

CREATE OR REPLACE FUNCTION public.neo_stores_receive_goods(
  _order uuid, _location uuid, _lines jsonb, _attempt uuid,
  _notes text DEFAULT NULL, _over_receipt_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE _org uuid := public.current_org_id(); _p record; _line jsonb; _pl record;
        _grn uuid; _number text; _prior jsonb; _count integer := 0;
        _qty numeric; _outstanding numeric; _post jsonb; _partial boolean := false;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'no_organisation' USING ERRCODE='42501'; END IF;
  IF _attempt IS NULL THEN RAISE EXCEPTION 'attempt_key_required' USING ERRCODE='22023'; END IF;

  SELECT result INTO _prior FROM public.procurement_attempts
   WHERE organization_id=_org AND action='goods.receive' AND attempt_key=_attempt;
  IF _prior IS NOT NULL THEN RETURN _prior || jsonb_build_object('replayed', true); END IF;

  IF NOT (public.has_permission('procurement','receiving.manage')
          OR public.has_permission('procurement','receiving.create')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE='42501';
  END IF;

  SELECT * INTO _p FROM public.purchase_orders WHERE id=_order AND organization_id=_org;
  IF _p IS NULL THEN RAISE EXCEPTION 'order_not_found' USING ERRCODE='22023'; END IF;
  IF NOT public.neo_branch_in_scope(_p.branch_id) THEN RAISE EXCEPTION 'branch_out_of_scope' USING ERRCODE='42501'; END IF;
  IF _p.status NOT IN ('approved','sent','partially-received','partially_received') THEN
    RAISE EXCEPTION 'order_not_receivable' USING ERRCODE='22023';
  END IF;
  IF _location IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.stock_locations sl WHERE sl.id=_location AND sl.organization_id=_org AND sl.active) THEN
    RAISE EXCEPTION 'store_location_required' USING ERRCODE='22023';
  END IF;
  IF _lines IS NULL OR jsonb_array_length(_lines) = 0 THEN
    RAISE EXCEPTION 'no_receipt_lines' USING ERRCODE='22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('grn:'||_order::text, 7));

  _number := public.next_document_number('goods_receipt','GRN', _p.branch_id);
  INSERT INTO public.goods_receipts (organization_id, branch_id, order_id, supplier_id, location_id,
    grn_number, status, received_at, received_by, notes)
  VALUES (_org, _p.branch_id, _order, _p.supplier_id, _location, _number, 'received', now(), auth.uid(), _notes)
  RETURNING id INTO _grn;

  FOR _line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    SELECT * INTO _pl FROM public.purchase_order_lines
     WHERE id = (_line->>'order_line_id')::uuid AND order_id = _order;
    IF _pl IS NULL THEN RAISE EXCEPTION 'order_line_not_on_order' USING ERRCODE='22023'; END IF;

    _qty := COALESCE((_line->>'quantity_received')::numeric, 0);
    IF _qty <= 0 THEN CONTINUE; END IF;

    _outstanding := COALESCE(_pl.quantity,0) - COALESCE(_pl.cancelled_quantity,0) - COALESCE(_pl.received_quantity,0);
    IF _qty > _outstanding + 0.0001 AND nullif(btrim(coalesce(_over_receipt_reason,'')),'') IS NULL THEN
      RAISE EXCEPTION 'over_receipt_refused: % outstanding on this line, % offered', _outstanding, _qty
        USING ERRCODE='23514';
    END IF;

    INSERT INTO public.goods_receipt_lines (organization_id, receipt_id, order_line_id, stock_item_id,
      quantity_ordered, quantity_previously_received, quantity_received, quantity_rejected, quantity_damaged,
      quantity_accepted, unit, unit_price, batch_number, expiry_date, location_id, notes,
      over_receipt_reason)
    VALUES (_org, _grn, _pl.id, _pl.stock_item_id, _pl.quantity, COALESCE(_pl.received_quantity,0), _qty,
      COALESCE((_line->>'quantity_rejected')::numeric,0), COALESCE((_line->>'quantity_damaged')::numeric,0),
      GREATEST(_qty - COALESCE((_line->>'quantity_rejected')::numeric,0)
                    - COALESCE((_line->>'quantity_damaged')::numeric,0), 0),
      COALESCE(_line->>'unit', _pl.unit), COALESCE((_line->>'unit_price')::numeric, _pl.unit_price),
      nullif(_line->>'batch_number',''), (nullif(_line->>'expiry_date',''))::date,
      COALESCE((nullif(_line->>'location_id',''))::uuid, _location), nullif(_line->>'notes',''),
      CASE WHEN _qty > _outstanding + 0.0001 THEN _over_receipt_reason ELSE NULL END);
    _count := _count + 1;
  END LOOP;

  IF _count = 0 THEN RAISE EXCEPTION 'no_receipt_lines' USING ERRCODE='22023'; END IF;

  _post := public.inventory_post_receipt(_grn);

  SELECT EXISTS (
    SELECT 1 FROM public.purchase_order_lines pl
     WHERE pl.order_id=_order
       AND COALESCE(pl.accepted_quantity,0) + COALESCE(pl.cancelled_quantity,0) < pl.quantity
  ) INTO _partial;
  UPDATE public.goods_receipts SET is_partial=_partial WHERE id=_grn;

  _prior := jsonb_build_object('ok',true,'receipt_id',_grn,'grn_number',_number,
              'lines',_count,'posting',_post,'partial',_partial,
              'order_status',(SELECT status FROM public.purchase_orders WHERE id=_order));
  INSERT INTO public.procurement_attempts (organization_id, action, attempt_key, record_id, result)
  VALUES (_org,'goods.receive',_attempt,_grn,_prior);
  RETURN _prior;
END $fn$;

-- 7. Store issues and returns ----------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_stores_issue(
  _location uuid, _lines jsonb, _attempt uuid, _department uuid DEFAULT NULL,
  _reason text DEFAULT NULL, _direction text DEFAULT 'issue')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE _org uuid := public.current_org_id(); _prior jsonb; _line jsonb;
        _sign numeric; _count integer := 0; _idx integer := 0; _qty numeric;
        _loc record; _movements uuid[] := '{}';
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'no_organisation' USING ERRCODE='42501'; END IF;
  IF _attempt IS NULL THEN RAISE EXCEPTION 'attempt_key_required' USING ERRCODE='22023'; END IF;
  IF lower(coalesce(_direction,'issue')) NOT IN ('issue','return') THEN
    RAISE EXCEPTION 'invalid_direction' USING ERRCODE='22023';
  END IF;

  SELECT result INTO _prior FROM public.procurement_attempts
   WHERE organization_id=_org AND action='stores.'||lower(_direction) AND attempt_key=_attempt;
  IF _prior IS NOT NULL THEN RETURN _prior || jsonb_build_object('replayed', true); END IF;

  IF NOT (public.has_permission('stores','issues.create')
          OR public.has_permission('stores','requisition.issue')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE='42501';
  END IF;

  SELECT * INTO _loc FROM public.stock_locations WHERE id=_location AND organization_id=_org AND active;
  IF _loc IS NULL THEN RAISE EXCEPTION 'store_location_required' USING ERRCODE='22023'; END IF;
  IF NOT public.neo_branch_in_scope(_loc.branch_id) THEN RAISE EXCEPTION 'branch_out_of_scope' USING ERRCODE='42501'; END IF;
  IF nullif(btrim(coalesce(_reason,'')),'') IS NULL THEN RAISE EXCEPTION 'reason_required' USING ERRCODE='22023'; END IF;

  _sign := CASE WHEN lower(_direction)='issue' THEN -1 ELSE 1 END;

  FOR _line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    _idx := _idx + 1;
    _qty := COALESCE((_line->>'quantity')::numeric, 0);
    IF _qty <= 0 THEN CONTINUE; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.stock_items si
                    WHERE si.id=(_line->>'stock_item_id')::uuid AND si.organization_id=_org) THEN
      RAISE EXCEPTION 'unknown_stock_item' USING ERRCODE='22023';
    END IF;
    _movements := _movements || public.inventory_apply_movement(
      (_line->>'stock_item_id')::uuid, _location, _sign * _qty, nullif(_line->>'unit',''),
      CASE WHEN _sign < 0 THEN 'issue' ELSE 'return' END, NULL,
      'store_'||lower(_direction), _attempt, _reason,
      'store:'||lower(_direction)||':'||_attempt::text||':'||_idx::text, NULL, NULL);
    _count := _count + 1;
  END LOOP;

  IF _count = 0 THEN RAISE EXCEPTION 'no_lines' USING ERRCODE='22023'; END IF;

  _prior := jsonb_build_object('ok',true,'direction',lower(_direction),'lines',_count,
              'location_id',_location,'department_id',_department,'movements',to_jsonb(_movements));
  INSERT INTO public.procurement_attempts (organization_id, action, attempt_key, record_id, result)
  VALUES (_org,'stores.'||lower(_direction),_attempt,_location,_prior);
  RETURN _prior;
END $fn$;

-- 8. Low-stock alerts to authorised procurement users -----------------------
CREATE OR REPLACE FUNCTION public.neo_stores_low_stock_scan(_branch uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE _org uuid := public.current_org_id(); _row record; _sent integer := 0; _found integer := 0; _u record;
BEGIN
  IF _org IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','no_organisation'); END IF;
  IF NOT (public.has_permission('procurement','overview.view')
          OR public.has_permission('stores','overview.view')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE='42501';
  END IF;

  FOR _row IN
    SELECT si.id, si.name, si.min_level, si.reorder_quantity, si.branch_id,
           COALESCE(sum(sl.quantity_on_hand),0) AS on_hand
      FROM public.stock_items si
      LEFT JOIN public.stock_levels sl ON sl.stock_item_id = si.id
     WHERE si.organization_id=_org AND si.active AND COALESCE(si.min_level,0) > 0
       AND (_branch IS NULL OR si.branch_id = _branch)
       AND public.neo_branch_in_scope(si.branch_id)
     GROUP BY si.id, si.name, si.min_level, si.reorder_quantity, si.branch_id
    HAVING COALESCE(sum(sl.quantity_on_hand),0) <= COALESCE(min(si.min_level),0)
  LOOP
    _found := _found + 1;
    FOR _u IN
      SELECT DISTINCT ur.user_id
        FROM public.user_roles ur
        JOIN public.role_permissions rp ON rp.role_id = ur.role_id
        JOIN public.permissions p ON p.id = rp.permission_id
       WHERE ur.organization_id=_org AND p.module='procurement'
         AND p.feature IN ('requests','lpos','*') AND p.action='create'
    LOOP
      PERFORM public.neo_notify(_org, _u.user_id, _row.branch_id, 'stock',
        'Low stock: '||_row.name,
        _row.name||' is at '||round(_row.on_hand,2)||' against a minimum of '||round(_row.min_level,2)||'.',
        '/procurement/requests', 'high', true, 'procurement', _row.id, 'stock.low',
        'lowstock:'||_row.id::text||':'||to_char(current_date,'YYYYMMDD'));
      _sent := _sent + 1;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object('ok',true,'items_below_minimum',_found,'notifications',_sent);
END $fn$;

-- 9. Reconciliation monitor -------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_procurement_reconciliation(_branch uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE _org uuid := public.current_org_id();
  _overdue jsonb; _unposted jsonb; _orphan jsonb; _negative jsonb; _low jsonb;
  _dupes jsonb; _drift jsonb;
BEGIN
  IF _org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.has_permission('procurement','overview.view')
          OR public.has_permission('stores','overview.view')
          OR public.has_permission('stores','reconciliation.view')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(jsonb_agg(x), '[]'::jsonb) INTO _overdue FROM (
    SELECT jsonb_build_object('order_id', p.id, 'order_number', p.order_number,
             'expected_date', p.expected_date, 'status', p.status,
             'outstanding', (SELECT coalesce(sum(pl.quantity - coalesce(pl.accepted_quantity,0)
                                                 - coalesce(pl.cancelled_quantity,0)),0)
                               FROM public.purchase_order_lines pl WHERE pl.order_id=p.id),
             'action', 'chase-supplier') AS x
      FROM public.purchase_orders p
     WHERE p.organization_id = _org
       AND (_branch IS NULL OR p.branch_id = _branch)
       AND public.neo_branch_in_scope(p.branch_id)
       AND p.status IN ('approved','sent','partially-received','partially_received')
       AND p.expected_date IS NOT NULL AND p.expected_date < current_date
     LIMIT 200) a;

  SELECT coalesce(jsonb_agg(y), '[]'::jsonb) INTO _unposted FROM (
    SELECT jsonb_build_object('receipt_id', r.id, 'grn_number', r.grn_number,
             'received_at', r.received_at, 'status', r.status, 'action', 'post-receipt') AS y
      FROM public.goods_receipts r
     WHERE r.organization_id = _org
       AND (_branch IS NULL OR r.branch_id = _branch)
       AND public.neo_branch_in_scope(r.branch_id)
       AND r.status NOT IN ('cancelled','draft')
       AND NOT EXISTS (SELECT 1 FROM public.stock_movements m
                        WHERE m.organization_id = _org AND m.reference_type = 'goods_receipt'
                          AND m.reference_id = r.id)
     LIMIT 200) b;

  SELECT coalesce(jsonb_agg(z), '[]'::jsonb) INTO _orphan FROM (
    SELECT jsonb_build_object('movement_id', m.id, 'reference_id', m.reference_id,
             'created_at', m.created_at, 'action', 'investigate-ledger') AS z
      FROM public.stock_movements m
     WHERE m.organization_id = _org AND m.reference_type = 'goods_receipt'
       AND NOT EXISTS (SELECT 1 FROM public.goods_receipts r WHERE r.id = m.reference_id)
     LIMIT 200) c;

  SELECT coalesce(jsonb_agg(n), '[]'::jsonb) INTO _negative FROM (
    SELECT jsonb_build_object('stock_item_id', l.stock_item_id, 'location_id', l.location_id,
             'quantity', l.quantity_on_hand, 'action', 'count-stock') AS n
      FROM public.stock_levels l
     WHERE l.organization_id = _org AND l.quantity_on_hand < 0
     LIMIT 200) d;

  SELECT coalesce(jsonb_agg(s), '[]'::jsonb) INTO _low FROM (
    SELECT jsonb_build_object('stock_item_id', si.id, 'name', si.name,
             'quantity', coalesce(sum(sl.quantity_on_hand),0), 'minimum', si.min_level,
             'reorder_quantity', si.reorder_quantity, 'action', 'raise-requisition') AS s
      FROM public.stock_items si
      LEFT JOIN public.stock_levels sl ON sl.stock_item_id = si.id
     WHERE si.organization_id = _org AND si.active AND coalesce(si.min_level,0) > 0
       AND (_branch IS NULL OR si.branch_id = _branch)
     GROUP BY si.id, si.name, si.min_level, si.reorder_quantity
    HAVING coalesce(sum(sl.quantity_on_hand),0) <= si.min_level
     LIMIT 200) e;

  SELECT coalesce(jsonb_agg(q), '[]'::jsonb) INTO _dupes FROM (
    SELECT jsonb_build_object('idempotency_key', m.idempotency_key, 'occurrences', count(*),
             'action', 'reverse-duplicate') AS q
      FROM public.stock_movements m
     WHERE m.organization_id = _org AND m.idempotency_key IS NOT NULL
     GROUP BY m.idempotency_key HAVING count(*) > 1
     LIMIT 200) f;

  SELECT coalesce(jsonb_agg(w), '[]'::jsonb) INTO _drift FROM (
    SELECT jsonb_build_object('order_id', p.id, 'order_number', p.order_number,
             'order_line_id', pl.id, 'ordered', pl.quantity,
             'received_on_lines', coalesce(g.received,0), 'received_on_order', coalesce(pl.received_quantity,0),
             'action', 'reconcile-line') AS w
      FROM public.purchase_order_lines pl
      JOIN public.purchase_orders p ON p.id = pl.order_id
      LEFT JOIN (SELECT order_line_id, sum(coalesce(quantity_received,0)) AS received
                   FROM public.goods_receipt_lines GROUP BY order_line_id) g
             ON g.order_line_id = pl.id
     WHERE p.organization_id = _org
       AND (_branch IS NULL OR p.branch_id = _branch)
       AND public.neo_branch_in_scope(p.branch_id)
       AND p.status NOT IN ('cancelled','voided','draft')
       AND abs(coalesce(g.received,0) - coalesce(pl.received_quantity,0)) > 0.0001
     LIMIT 200) h;

  RETURN jsonb_build_object('ok', true, 'generated_at', now(),
    'overdue_orders', _overdue, 'receipts_not_in_stock', _unposted,
    'stock_without_receipt', _orphan, 'negative_stock', _negative, 'below_minimum', _low,
    'duplicate_sources', _dupes, 'receipt_quantity_drift', _drift,
    'healthy', jsonb_array_length(_unposted) = 0 AND jsonb_array_length(_orphan) = 0
               AND jsonb_array_length(_negative) = 0 AND jsonb_array_length(_dupes) = 0
               AND jsonb_array_length(_drift) = 0);
END $fn$;

-- 10. Execute privileges ----------------------------------------------------
DO $do$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'neo_procurement_request_submit(uuid,uuid)',
    'neo_procurement_request_decide(uuid,text,text)',
    'neo_procurement_order_from_request(uuid,uuid,date,uuid,uuid)',
    'neo_procurement_order_approve(uuid,text)',
    'neo_stores_receive_goods(uuid,uuid,jsonb,uuid,text,text)',
    'neo_stores_issue(uuid,jsonb,uuid,uuid,text,text)',
    'neo_stores_low_stock_scan(uuid)',
    'neo_procurement_reconciliation(uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated', f);
  END LOOP;
END $do$;

-- 11. Recompile the affected role templates for every organisation ----------
DO $do$
DECLARE o uuid;
BEGIN
  FOR o IN SELECT id FROM public.organizations LOOP
    PERFORM public.neo_apply_feature_templates(o);
  END LOOP;
END $do$;