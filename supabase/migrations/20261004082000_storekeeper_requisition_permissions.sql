-- Align Stores requisition actions with the Storekeeper's canonical authority:
-- stores / issues / create.
-- Preserve legacy Stores permissions and org-admin authority for compatibility.

CREATE OR REPLACE FUNCTION public.req_issue(
  _requisition uuid,
  _lines jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := current_org_id();
  v_req record;
  v_line jsonb;
  v_row record;
  v_qty numeric;
  v_issued int := 0;
  v_partial boolean := false;
  v_dest uuid;
BEGIN
  IF NOT (
    public.has_permission('stores','issues','create')
    OR public.has_permission('stores','edit')
    OR public.has_permission('stores','approve')
    OR public.is_org_admin()
  ) THEN
    RAISE EXCEPTION 'Only Stores may issue requisition items';
  END IF;

  SELECT *
    INTO v_req
  FROM public.internal_requisitions
  WHERE id = _requisition
    AND organization_id = v_org
  FOR UPDATE;

  IF v_req IS NULL THEN
    RAISE EXCEPTION 'Unknown requisition';
  END IF;

  IF v_req.source_location_id IS NULL THEN
    RAISE EXCEPTION 'Set the issuing store before issuing';
  END IF;

  v_dest := v_req.destination_location_id;

  FOR v_line IN
    SELECT *
    FROM jsonb_array_elements(COALESCE(_lines, '[]'::jsonb))
  LOOP
    SELECT *
      INTO v_row
    FROM public.internal_requisition_lines
    WHERE id = (v_line->>'id')::uuid
      AND requisition_id = _requisition
    FOR UPDATE;

    CONTINUE WHEN v_row IS NULL;

    v_qty := COALESCE((v_line->>'quantity_issued')::numeric, 0);

    IF v_qty <= 0 THEN
      CONTINUE;
    END IF;

    IF v_qty >
       COALESCE(v_row.quantity_approved, v_row.quantity_requested)
       - v_row.quantity_issued
    THEN
      RAISE EXCEPTION 'Cannot issue more than the approved quantity';
    END IF;

    IF v_row.stock_item_id IS NOT NULL THEN
      PERFORM public.inventory_apply_movement(
        v_row.stock_item_id,
        v_req.source_location_id,
        -v_qty,
        v_row.unit,
        CASE WHEN v_dest IS NULL THEN 'issue' ELSE 'transfer-out' END,
        NULL,
        'internal-requisition',
        _requisition,
        'Requisition issue',
        'req-out:' || v_row.id::text || ':' || v_qty::text
      );

      IF v_dest IS NOT NULL THEN
        PERFORM public.inventory_apply_movement(
          v_row.stock_item_id,
          v_dest,
          v_qty,
          v_row.unit,
          'transfer-in',
          NULL,
          'internal-requisition',
          _requisition,
          'Requisition transfer to mini-store',
          'req-in:' || v_row.id::text || ':' || v_qty::text
        );
      END IF;
    END IF;

    UPDATE public.internal_requisition_lines
       SET quantity_issued = quantity_issued + v_qty
     WHERE id = v_row.id;

    v_issued := v_issued + 1;
  END LOOP;

  SELECT EXISTS (
    SELECT 1
    FROM public.internal_requisition_lines
    WHERE requisition_id = _requisition
      AND quantity_issued <
          COALESCE(quantity_approved, quantity_requested)
  )
  INTO v_partial;

  UPDATE public.internal_requisitions
     SET status = CASE
                    WHEN v_partial THEN 'partially-issued'
                    ELSE 'issued'
                  END,
         issued_by = auth.uid(),
         issued_at = now()
   WHERE id = _requisition;

  RETURN jsonb_build_object(
    'ok', true,
    'lines_issued', v_issued,
    'partial', v_partial
  );
END;
$$;

REVOKE ALL ON FUNCTION public.req_issue(uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.req_issue(uuid,jsonb) TO authenticated, service_role;


CREATE OR REPLACE FUNCTION public.neo_stores_requisition_reject(
  _requisition uuid,
  _reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := current_org_id();
  v_req record;
BEGIN
  IF _reason IS NULL OR btrim(_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required when returning a requisition';
  END IF;

  IF NOT (
    public.has_permission('stores','issues','create')
    OR public.has_permission('stores','edit')
    OR public.has_permission('stores','approve')
    OR public.is_org_admin()
  ) THEN
    RAISE EXCEPTION 'Only Stores may return a department requisition';
  END IF;

  SELECT *
    INTO v_req
  FROM public.internal_requisitions
  WHERE id = _requisition
    AND organization_id = v_org
  FOR UPDATE;

  IF v_req IS NULL THEN
    RAISE EXCEPTION 'Unknown requisition';
  END IF;

  IF v_req.status IN ('issued','received','closed','cancelled','rejected') THEN
    RAISE EXCEPTION 'This requisition can no longer be returned';
  END IF;

  UPDATE public.internal_requisitions
     SET status = 'rejected',
         store_reviewed_by = auth.uid(),
         store_reviewed_at = now(),
         shortage_notes = _reason
   WHERE id = _requisition;

  RETURN jsonb_build_object('ok', true, 'status', 'rejected');
END;
$$;

REVOKE ALL ON FUNCTION public.neo_stores_requisition_reject(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_stores_requisition_reject(uuid,text) TO authenticated, service_role;


CREATE OR REPLACE FUNCTION public.neo_stores_shortage_to_pr(
  _requisition uuid,
  _notes text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _req public.internal_requisitions%ROWTYPE;
  _pr_id uuid;
  _number text;
  _total numeric := 0;
  _lines integer := 0;
BEGIN
  IF NOT (
    public.has_permission('stores','issues','create')
    OR public.has_permission('stores','requisitions','create')
    OR public.has_permission('stores','edit')
    OR public.has_permission('stores','approve')
    OR public.is_org_admin()
  ) THEN
    RAISE EXCEPTION 'Only Stores may route a requisition shortage to Procurement';
  END IF;

  SELECT *
    INTO _req
  FROM public.internal_requisitions
  WHERE id = _requisition;

  IF _req.id IS NULL THEN
    RAISE EXCEPTION 'Requisition not found';
  END IF;

  IF _req.organization_id IS DISTINCT FROM current_org_id() THEN
    RAISE EXCEPTION 'Requisition belongs to another organisation';
  END IF;

  IF _req.purchase_request_id IS NOT NULL THEN
    SELECT request_number
      INTO _number
    FROM public.purchase_requests
    WHERE id = _req.purchase_request_id;

    RETURN jsonb_build_object(
      'purchase_request_id', _req.purchase_request_id,
      'request_number', _number,
      'created', false
    );
  END IF;

  CREATE TEMP TABLE _shortage ON COMMIT DROP AS
  SELECT
    l.stock_item_id,
    COALESCE(NULLIF(l.description, ''), si.name, 'Item') AS description,
    COALESCE(NULLIF(l.unit, ''), si.base_unit, 'unit') AS unit,
    GREATEST(
      COALESCE(l.quantity_approved, l.quantity_requested)
      - COALESCE(l.quantity_issued, 0),
      0
    ) AS quantity,
    COALESCE(NULLIF(si.last_cost, 0), si.average_cost, 0) AS unit_price
  FROM public.internal_requisition_lines l
  LEFT JOIN public.stock_items si
    ON si.id = l.stock_item_id
  WHERE l.requisition_id = _requisition;

  DELETE FROM _shortage
  WHERE quantity <= 0;

  SELECT
    count(*),
    COALESCE(sum(quantity * unit_price), 0)
  INTO
    _lines,
    _total
  FROM _shortage;

  IF _lines = 0 THEN
    RAISE EXCEPTION 'Nothing is outstanding on this requisition, so there is no shortage to purchase';
  END IF;

  _number := public.next_document_number('purchase-request');

  INSERT INTO public.purchase_requests (
    organization_id,
    branch_id,
    department_id,
    request_number,
    title,
    justification,
    source,
    source_reference,
    status,
    priority,
    estimated_total,
    requested_by
  )
  VALUES (
    _req.organization_id,
    _req.branch_id,
    _req.department_id,
    _number,
    'Stores replenishment — ' || COALESCE(_req.request_number, 'requisition'),
    COALESCE(NULLIF(_notes, ''), 'Shortage routed from Stores'),
    'stores-shortage',
    _req.request_number,
    'submitted',
    COALESCE(_req.priority, 'normal'),
    _total,
    auth.uid()
  )
  RETURNING id INTO _pr_id;

  INSERT INTO public.purchase_request_lines (
    organization_id,
    request_id,
    stock_item_id,
    description,
    quantity,
    unit,
    estimated_unit_price
  )
  SELECT
    _req.organization_id,
    _pr_id,
    stock_item_id,
    description,
    quantity,
    unit,
    unit_price
  FROM _shortage;

  UPDATE public.internal_requisitions
     SET purchase_request_id = _pr_id,
         shortage_notes = COALESCE(NULLIF(_notes, ''), shortage_notes)
   WHERE id = _requisition;

  RETURN jsonb_build_object(
    'purchase_request_id', _pr_id,
    'request_number', _number,
    'lines', _lines,
    'estimated_total', _total,
    'created', true
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_stores_shortage_to_pr(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_stores_shortage_to_pr(uuid,text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';