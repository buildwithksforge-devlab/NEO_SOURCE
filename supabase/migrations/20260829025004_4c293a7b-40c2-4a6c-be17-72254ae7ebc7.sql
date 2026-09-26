CREATE OR REPLACE FUNCTION public.neo_purchase_request_from_reorder(
  _stock_item uuid,
  _branch uuid,
  _quantity numeric,
  _unit text DEFAULT 'unit',
  _title text DEFAULT NULL,
  _justification text DEFAULT NULL,
  _estimated_unit_price numeric DEFAULT 0,
  _request_number text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := current_org_id();
  v_req uuid;
  v_existing uuid;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No organisation context'; END IF;
  IF _stock_item IS NULL THEN RAISE EXCEPTION 'A stock item is required'; END IF;
  IF coalesce(_quantity, 0) <= 0 THEN RAISE EXCEPTION 'Enter the quantity to request'; END IF;
  IF NOT (has_permission('procurement','requests.create')
          OR has_permission('procurement','create')
          OR has_permission('stores','create')
          OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to raise a purchase request';
  END IF;
  IF _branch IS NULL OR NOT (_branch = ANY (current_branch_ids())) THEN
    RAISE EXCEPTION 'Purchase requests may only be raised for your own property';
  END IF;

  -- Idempotency: while an earlier replenishment request for this item at this
  -- property is still open, a retry returns that request instead of raising a
  -- second one.
  SELECT pr.id INTO v_existing
  FROM public.purchase_requests pr
  JOIN public.purchase_request_lines prl ON prl.request_id = pr.id
  WHERE pr.organization_id = v_org
    AND pr.branch_id IS NOT DISTINCT FROM _branch
    AND prl.stock_item_id = _stock_item
    AND pr.status IN ('draft','submitted','pending','pending-approval')
  ORDER BY pr.created_at DESC
  LIMIT 1;

  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'request_id', v_existing);
  END IF;

  INSERT INTO public.purchase_requests
    (organization_id, branch_id, request_number, title, justification,
     source, status, priority, requested_by)
  VALUES (v_org, _branch, _request_number, coalesce(_title, 'Replenishment'),
          _justification, 'reorder-recommendation', 'draft', 'normal', auth.uid())
  RETURNING id INTO v_req;

  INSERT INTO public.purchase_request_lines
    (organization_id, request_id, stock_item_id, description, quantity, unit, estimated_unit_price)
  VALUES (v_org, v_req, _stock_item, coalesce(_title, 'Replenishment'),
          _quantity, coalesce(nullif(_unit,''), 'unit'), coalesce(_estimated_unit_price, 0));

  RETURN jsonb_build_object('ok', true, 'duplicate', false, 'request_id', v_req);
END $function$;

REVOKE ALL ON FUNCTION public.neo_purchase_request_from_reorder(uuid, uuid, numeric, text, text, text, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_purchase_request_from_reorder(uuid, uuid, numeric, text, text, text, numeric, text) TO authenticated;