BEGIN;

CREATE FUNCTION public.neo_partner_lpo_payload(_branch uuid, _relationship uuid, _number text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $lpo$
  SELECT jsonb_build_object(
    'type','purchase_order',
    'document',jsonb_build_object('number',p.order_number,'date',coalesce(p.sent_at,p.created_at),
      'status',p.status,'title','Local purchase order',
      'subtitle',case when p.expected_date is not null then 'Expected '||p.expected_date::text end),
    'property',jsonb_build_object('name',b.name,'logo_url',b.logo_url,'timezone',b.timezone,'currency',p.currency),
    'identity',jsonb_build_object('organisation',b.name,'organisation_id',b.organization_id),
    'party',jsonb_build_object('label','Supplier','name',s.name),
    'lines',coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'description',coalesce(l.description,i.name),'quantity',l.quantity,'unit',l.unit,
        'unit_price',l.unit_price,'discount',l.discount_amount,'tax',l.tax_amount,'total',l.line_total
      ) ORDER BY l.created_at,l.id)
      FROM public.purchase_order_lines l
      LEFT JOIN public.stock_items i ON i.id=l.stock_item_id AND i.organization_id=p.organization_id
      WHERE l.order_id=p.id
    ),'[]'::jsonb),
    'totals',jsonb_build_array(
      jsonb_build_object('label','Subtotal','amount',p.subtotal),
      jsonb_build_object('label','Discount','amount',-coalesce(p.discount_amount,0)),
      jsonb_build_object('label','Tax','amount',p.tax_amount),
      jsonb_build_object('label','Order total','amount',p.total_amount,'emphasis',true)
    ),
    'meta',jsonb_strip_nulls(jsonb_build_object('Payment terms',p.payment_terms,'Delivery address',p.delivery_address)),
    'generated_at',now()
  )
  FROM public.neo_access_relationships r
  JOIN public.branches b ON b.id=_branch AND b.organization_id=r.organization_id AND b.active IS TRUE
  JOIN public.purchase_orders p ON p.branch_id=b.id AND p.organization_id=b.organization_id AND p.supplier_id=r.supplier_id
  JOIN public.suppliers s ON s.id=r.supplier_id AND s.organization_id=b.organization_id
  WHERE r.id=_relationship AND r.auth_user_id=auth.uid()
    AND r.door='partner' AND r.status='active' AND (r.branch_id IS NULL OR r.branch_id=b.id)
    AND p.order_number=nullif(btrim(_number),'')
    AND p.status NOT IN ('draft','cancelled','rejected','pending-approval')
    AND (p.sent_at IS NOT NULL OR p.status IN ('approved','sent','partially-received','received','completed','closed'))
  ORDER BY p.created_at DESC,p.id
  LIMIT 1;
$lpo$;
REVOKE ALL ON FUNCTION public.neo_partner_lpo_payload(uuid,uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.neo_partner_lpo_payload(uuid,uuid,text) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
