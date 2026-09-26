
-- Which businesses does the signed-in person represent at this property?
CREATE OR REPLACE FUNCTION public.neo_partner_context(_branch uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _uid uuid := auth.uid();
  _org uuid;
  _rels jsonb;
BEGIN
  IF _uid IS NULL THEN RETURN jsonb_build_object('allowed', false, 'reason', 'not_signed_in'); END IF;
  SELECT organization_id INTO _org FROM public.branches WHERE id = _branch AND active IS TRUE;
  IF _org IS NULL THEN RETURN jsonb_build_object('allowed', false, 'reason', 'unknown_property'); END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', a.id,
           'relationship_type', a.relationship_type,
           'display_name', COALESCE(a.party_display_name, s.name, c.legal_name),
           'supplier_id', a.supplier_id,
           'corporate_account_id', a.corporate_account_id
         ) ORDER BY COALESCE(a.party_display_name, s.name, c.legal_name)), '[]'::jsonb)
    INTO _rels
  FROM public.neo_access_relationships a
  LEFT JOIN public.suppliers s ON s.id = a.supplier_id
  LEFT JOIN public.corporate_accounts c ON c.id = a.corporate_account_id
  WHERE a.auth_user_id = _uid
    AND a.door = 'partner'
    AND a.status = 'active'
    AND a.organization_id = _org
    AND (a.branch_id IS NULL OR a.branch_id = _branch);

  IF _rels = '[]'::jsonb THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'no_relationship');
  END IF;

  RETURN jsonb_build_object(
    'allowed', true,
    'organization_id', _org,
    'branch_id', _branch,
    'relationships', _rels
  );
END;
$$;

REVOKE ALL ON FUNCTION public.neo_partner_context(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_partner_context(uuid) TO authenticated, service_role;

-- The canonical records a partner is entitled to see for one business.
CREATE OR REPLACE FUNCTION public.neo_partner_records(_branch uuid, _relationship uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _uid uuid := auth.uid();
  _rel public.neo_access_relationships%ROWTYPE;
  _org uuid;
BEGIN
  IF _uid IS NULL THEN RETURN jsonb_build_object('allowed', false, 'reason', 'not_signed_in'); END IF;
  SELECT organization_id INTO _org FROM public.branches WHERE id = _branch AND active IS TRUE;
  IF _org IS NULL THEN RETURN jsonb_build_object('allowed', false, 'reason', 'unknown_property'); END IF;

  SELECT * INTO _rel FROM public.neo_access_relationships
  WHERE id = _relationship
    AND auth_user_id = _uid
    AND door = 'partner'
    AND status = 'active'
    AND organization_id = _org
    AND (branch_id IS NULL OR branch_id = _branch);

  IF _rel.id IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'no_relationship');
  END IF;

  RETURN jsonb_build_object(
    'allowed', true,
    'relationship_type', _rel.relationship_type,
    'purchase_orders', CASE WHEN _rel.supplier_id IS NULL THEN '[]'::jsonb ELSE (
      SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) FROM (
        SELECT po.order_number, po.status, po.expected_date, po.total_amount,
               po.currency, po.invoiced_amount, po.paid_amount, po.created_at
        FROM public.purchase_orders po
        WHERE po.supplier_id = _rel.supplier_id
          AND po.organization_id = _org
          AND po.branch_id = _branch
          AND po.status IN ('sent','approved','partially_received','received','closed')
        ORDER BY po.created_at DESC LIMIT 50
      ) t) END,
    'deliveries', CASE WHEN _rel.supplier_id IS NULL THEN '[]'::jsonb ELSE (
      SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) FROM (
        SELECT gr.grn_number, gr.status, gr.received_at, gr.total_value, gr.is_partial
        FROM public.goods_receipts gr
        WHERE gr.supplier_id = _rel.supplier_id
          AND gr.organization_id = _org
          AND gr.branch_id = _branch
        ORDER BY gr.received_at DESC NULLS LAST LIMIT 50
      ) t) END,
    'invoices', CASE WHEN _rel.supplier_id IS NULL THEN '[]'::jsonb ELSE (
      SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) FROM (
        SELECT si.invoice_number, si.invoice_date, si.due_date, si.amount,
               si.paid_amount, si.status, si.match_status
        FROM public.supplier_invoices si
        WHERE si.supplier_id = _rel.supplier_id
          AND si.organization_id = _org
          AND si.branch_id = _branch
        ORDER BY si.invoice_date DESC NULLS LAST LIMIT 50
      ) t) END,
    'corporate_account', CASE WHEN _rel.corporate_account_id IS NULL THEN NULL ELSE (
      SELECT to_jsonb(t) FROM (
        SELECT c.account_number, c.legal_name, c.trading_name, c.account_status,
               c.billing_address, c.phone, c.email
        FROM public.corporate_accounts c
        WHERE c.id = _rel.corporate_account_id AND c.organization_id = _org
      ) t) END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.neo_partner_records(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_partner_records(uuid, uuid) TO authenticated, service_role;
