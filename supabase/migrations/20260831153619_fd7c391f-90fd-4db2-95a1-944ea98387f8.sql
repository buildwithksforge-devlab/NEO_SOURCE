CREATE OR REPLACE FUNCTION public.neo_stores_shortage_to_pr(_requisition uuid, _notes text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _req internal_requisitions%ROWTYPE;
  _pr_id uuid;
  _number text;
  _total numeric := 0;
  _lines integer := 0;
BEGIN
  SELECT * INTO _req FROM internal_requisitions WHERE id = _requisition;
  IF _req.id IS NULL THEN
    RAISE EXCEPTION 'Requisition not found';
  END IF;
  IF _req.organization_id IS DISTINCT FROM current_org_id() THEN
    RAISE EXCEPTION 'Requisition belongs to another organisation';
  END IF;

  -- Already routed: hand back the same purchase request rather than a second one.
  IF _req.purchase_request_id IS NOT NULL THEN
    SELECT request_number INTO _number FROM purchase_requests WHERE id = _req.purchase_request_id;
    RETURN jsonb_build_object('purchase_request_id', _req.purchase_request_id,
                              'request_number', _number, 'created', false);
  END IF;

  -- The shortage is what was asked for and has not been issued.
  CREATE TEMP TABLE _shortage ON COMMIT DROP AS
  SELECT l.stock_item_id,
         COALESCE(NULLIF(l.description, ''), si.name, 'Item') AS description,
         COALESCE(NULLIF(l.unit, ''), si.base_unit, 'unit') AS unit,
         GREATEST(COALESCE(l.quantity_approved, l.quantity_requested) - COALESCE(l.quantity_issued, 0), 0) AS quantity,
         COALESCE(NULLIF(si.last_cost, 0), si.average_cost, 0) AS unit_price
  FROM internal_requisition_lines l
  LEFT JOIN stock_items si ON si.id = l.stock_item_id
  WHERE l.requisition_id = _requisition;

  DELETE FROM _shortage WHERE quantity <= 0;
  SELECT count(*), COALESCE(sum(quantity * unit_price), 0) INTO _lines, _total FROM _shortage;

  IF _lines = 0 THEN
    RAISE EXCEPTION 'Nothing is outstanding on this requisition, so there is no shortage to purchase';
  END IF;

  _number := next_document_number('purchase-request');

  INSERT INTO purchase_requests (organization_id, branch_id, department_id, request_number, title,
                                 justification, source, source_reference, status, priority,
                                 estimated_total, requested_by)
  VALUES (_req.organization_id, _req.branch_id, _req.department_id, _number,
          'Stores replenishment — ' || COALESCE(_req.request_number, 'requisition'),
          COALESCE(NULLIF(_notes, ''), 'Shortage routed from Stores'),
          'stores-shortage', _req.request_number, 'submitted',
          COALESCE(_req.priority, 'normal'), _total, auth.uid())
  RETURNING id INTO _pr_id;

  INSERT INTO purchase_request_lines (organization_id, request_id, stock_item_id, description,
                                      quantity, unit, estimated_unit_price)
  SELECT _req.organization_id, _pr_id, stock_item_id, description, quantity, unit, unit_price
  FROM _shortage;

  UPDATE internal_requisitions
     SET purchase_request_id = _pr_id,
         shortage_notes = COALESCE(NULLIF(_notes, ''), shortage_notes)
   WHERE id = _requisition;

  RETURN jsonb_build_object('purchase_request_id', _pr_id, 'request_number', _number,
                            'lines', _lines, 'estimated_total', _total, 'created', true);
END;
$$;

REVOKE ALL ON FUNCTION public.neo_stores_shortage_to_pr(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_stores_shortage_to_pr(uuid, text) TO authenticated;