BEGIN;

-- Use the same per-line currency rounding for the quote and draft order.
DO $rounding$
DECLARE definition text;
BEGIN
  definition := pg_get_functiondef('public.neo_procurement_order_from_request(uuid,uuid,date,uuid,uuid)'::regprocedure);
  IF strpos(definition,'SELECT round(sum(quantity*unit_price),2) FROM public.supplier_quotation_lines')=0
    OR strpos(definition,'l.quantity * coalesce(q.unit_price,l.estimated_unit_price,0)')=0 THEN
    RAISE EXCEPTION 'Install the recommended quote LPO pricing migration before supplier RFQs';
  END IF;
  definition := replace(definition,'SELECT round(sum(quantity*unit_price),2) FROM public.supplier_quotation_lines',
    'SELECT sum(round(quantity*unit_price,2)) FROM public.supplier_quotation_lines');
  definition := replace(definition,'l.quantity * coalesce(q.unit_price,l.estimated_unit_price,0)',
    'round(l.quantity * coalesce(q.unit_price,l.estimated_unit_price,0),2)');
  EXECUTE definition;
END;
$rounding$;

CREATE FUNCTION public.neo_partner_rfq_quotes(
  _branch uuid, _relationship uuid, _rfq uuid DEFAULT NULL,
  _prices jsonb DEFAULT NULL, _valid_until date DEFAULT NULL, _notes text DEFAULT NULL,
  _previous uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  org uuid;
  supplier uuid;
  currency_code text;
  request_id_to_quote uuid;
  saved_id uuid;
  active_quote public.supplier_quotations;
  line_count integer;
  total numeric;
BEGIN
  SELECT b.organization_id,a.supplier_id,coalesce(b.currency,'KES')
  INTO org,supplier,currency_code
  FROM public.branches b
  JOIN public.neo_access_relationships a ON a.organization_id=b.organization_id
    AND (a.branch_id IS NULL OR a.branch_id=b.id)
  JOIN public.suppliers v ON v.id=a.supplier_id AND v.organization_id=b.organization_id
  WHERE b.id=_branch AND b.active AND a.id=_relationship AND a.auth_user_id=auth.uid()
    AND a.door='partner' AND a.status='active' AND a.relationship_type='supplier';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Supplier access is unavailable for this property' USING ERRCODE='42501';
  END IF;

  IF _rfq IS NULL THEN
    RETURN coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id',r.id,'number',r.rfq_number,'title',r.title,'closes_at',r.closes_at,
        'currency',currency_code,'quote_id',q.id,'total',q.total_amount,
        'valid_until',q.valid_until,'notes',q.notes,
        'can_quote',r.status='issued' AND (r.closes_at IS NULL OR r.closes_at>now())
          AND p.status IN ('submitted','pending_approval','under-review','approved') AND NOT coalesce(q.selected,false),
        'lines',(SELECT jsonb_agg(jsonb_build_object('id',l.id,'description',coalesce(l.description,'Requested item'),
          'quantity',l.quantity,'unit',l.unit,'price',ql.unit_price) ORDER BY l.created_at,l.id)
          FROM public.purchase_request_lines l LEFT JOIN public.supplier_quotation_lines ql
          ON ql.quotation_id=q.id AND ql.organization_id=org AND ql.request_line_id=l.id
          WHERE l.request_id=p.id AND l.organization_id=org)
      ) ORDER BY r.issued_at DESC NULLS LAST,r.id)
      FROM public.rfq_suppliers i
      JOIN public.rfqs r ON r.id=i.rfq_id AND r.organization_id=org AND r.branch_id=_branch
      JOIN public.purchase_requests p ON p.id=r.request_id AND p.organization_id=org AND p.branch_id=_branch
      LEFT JOIN LATERAL (
        SELECT sq.* FROM public.supplier_quotations sq WHERE sq.organization_id=org
          AND sq.rfq_id=r.id AND sq.supplier_id=supplier AND sq.status<>'superseded'
        ORDER BY sq.created_at DESC,sq.id LIMIT 1
      ) q ON true
      WHERE i.organization_id=org AND i.supplier_id=supplier AND i.dispatch_state IN ('sent','marked-sent')
        AND r.status<>'draft'
    ),'[]'::jsonb);
  END IF;

  SELECT p.id INTO request_id_to_quote
  FROM public.rfqs r
  JOIN public.purchase_requests p ON p.id=r.request_id AND p.organization_id=org AND p.branch_id=_branch
  JOIN public.rfq_suppliers i ON i.rfq_id=r.id AND i.organization_id=org AND i.supplier_id=supplier
  WHERE r.id=_rfq AND r.organization_id=org AND r.branch_id=_branch AND r.status='issued'
    AND (r.closes_at IS NULL OR r.closes_at>now()) AND p.status IN ('submitted','pending_approval','under-review','approved')
    AND i.dispatch_state IN ('sent','marked-sent')
  FOR UPDATE OF p,r,i;
  IF NOT FOUND THEN RAISE EXCEPTION 'This invitation is closed or unavailable' USING ERRCODE='42501'; END IF;

  SELECT * INTO active_quote FROM public.supplier_quotations q
  WHERE q.organization_id=org AND q.rfq_id=_rfq AND q.supplier_id=supplier AND q.status<>'superseded'
  ORDER BY q.created_at DESC,q.id LIMIT 1 FOR UPDATE;
  IF active_quote.id IS DISTINCT FROM _previous OR coalesce(active_quote.selected,false) THEN
    RAISE EXCEPTION 'The quotation changed or was selected. Refresh before revising it.' USING ERRCODE='23514';
  END IF;
  IF jsonb_typeof(_prices) IS DISTINCT FROM 'object' OR length(coalesce(_notes,''))>2000
    OR _valid_until IS NULL OR _valid_until<(now() AT TIME ZONE 'Africa/Nairobi')::date THEN
    RAISE EXCEPTION 'Enter line prices and a current validity date.' USING ERRCODE='22023';
  END IF;
  SELECT count(*),sum(round(l.quantity*(_prices->>l.id::text)::numeric,2)) INTO line_count,total
  FROM public.purchase_request_lines l WHERE l.organization_id=org AND l.request_id=request_id_to_quote
    AND l.quantity>0 AND l.quantity::text NOT IN ('NaN','Infinity','-Infinity')
    AND (_prices->>l.id::text) ~ '^[0-9]{1,12}(\.[0-9]{1,2})?$';
  IF line_count=0 OR total<=0 OR line_count<>(SELECT count(*) FROM jsonb_object_keys(_prices))
    OR line_count<>(SELECT count(*) FROM public.purchase_request_lines l WHERE l.organization_id=org AND l.request_id=request_id_to_quote) THEN
    RAISE EXCEPTION 'Give a valid price for every requested line.' USING ERRCODE='22023';
  END IF;

  IF active_quote.id IS NOT NULL THEN
    UPDATE public.supplier_quotations SET status='superseded' WHERE id=active_quote.id;
  END IF;
  INSERT INTO public.supplier_quotations(organization_id,branch_id,supplier_id,request_id,rfq_id,
    quotation_number,status,valid_until,total_amount,currency,notes)
  VALUES(org,_branch,supplier,request_id_to_quote,_rfq,'QT-'||gen_random_uuid()::text,
    'received',_valid_until,total,currency_code,nullif(btrim(_notes),''))
  RETURNING id INTO saved_id;
  INSERT INTO public.supplier_quotation_lines(organization_id,quotation_id,request_line_id,stock_item_id,
    description,quantity,unit,unit_price)
  SELECT org,saved_id,l.id,l.stock_item_id,l.description,l.quantity,l.unit,(_prices->>l.id::text)::numeric
  FROM public.purchase_request_lines l WHERE l.organization_id=org AND l.request_id=request_id_to_quote;
  UPDATE public.rfq_suppliers SET responded_at=now() WHERE rfq_id=_rfq AND supplier_id=supplier AND organization_id=org;
  RETURN jsonb_build_object('id',saved_id,'total',total,'currency',currency_code);
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_partner_rfq_quotes(uuid,uuid,uuid,jsonb,date,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_partner_rfq_quotes(uuid,uuid,uuid,jsonb,date,text,uuid) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
