CREATE OR REPLACE FUNCTION public.neo_folio_document_tax_rows(_folio uuid, _property uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  f public.folios;
  tax_rows jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
  SELECT * INTO f FROM public.folios WHERE id=_folio AND (_property IS NULL OR branch_id=_property);
  IF NOT FOUND OR NOT coalesce((
    (public.can_read_guest_ledger() IS TRUE AND f.organization_id=public.current_org_id()
      AND (public.in_my_branch_scope(f.organization_id,f.branch_id) IS TRUE OR public.is_org_admin_for(f.organization_id) IS TRUE))
    OR (_property IS NOT NULL AND EXISTS(SELECT 1 FROM public.customers c
      WHERE c.id=f.customer_id AND c.organization_id=f.organization_id AND c.auth_user_id=auth.uid()
        AND c.merged_into_id IS NULL))
  ),false) THEN
    RAISE EXCEPTION 'Folio is outside your scope' USING ERRCODE='42501';
  END IF;

  WITH charges AS (
    SELECT fl.id, fl.tax_amount, o.id sale_id, count(o.id) over (partition by o.id) linked_charges
    FROM public.folio_lines fl
    LEFT JOIN public.pos_orders o ON fl.source_module IN ('pos','pos_order') AND fl.source_record_uuid=o.id
      AND o.organization_id=f.organization_id AND o.branch_id IS NOT DISTINCT FROM f.branch_id AND o.currency=f.currency
    WHERE fl.folio_id=f.id AND fl.organization_id=f.organization_id
      AND coalesce(fl.status,'posted') NOT IN ('void','voided','reversed')
      AND coalesce(fl.line_type,'charge') NOT IN ('payment','deposit','refund') AND coalesce(fl.tax_amount,0)<>0
  ), saved AS (
    SELECT c.*, parts.rows, parts.amount FROM charges c
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(part) rows, sum((part->>'amount')::numeric) amount
      FROM jsonb_array_elements(CASE WHEN c.sale_id IS NOT NULL AND c.linked_charges=1
        THEN public.neo_pos_sales_tax_receipt(c.sale_id,jsonb_build_array(jsonb_build_object('label','Tax','amount',c.tax_amount)))
        ELSE '[]'::jsonb END) p(part)
      WHERE part->>'label' NOT IN ('Tax','Net before tax') AND part ? 'amount'
    ) parts ON true
  ), labels AS (
    SELECT part->>'label' label, (part->>'amount')::numeric amount
    FROM saved s CROSS JOIN LATERAL jsonb_array_elements(s.rows) p(part)
    WHERE s.amount=s.tax_amount
    UNION ALL
    SELECT 'Other recorded tax', s.tax_amount FROM saved s WHERE s.amount IS DISTINCT FROM s.tax_amount
  ), grouped AS (
    SELECT label,sum(amount) amount FROM labels GROUP BY label HAVING sum(amount)<>0
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('label',label,'amount',amount) ORDER BY label='Other recorded tax',label),'[]')
  INTO tax_rows FROM grouped;
  RETURN tax_rows;
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_folio_document_tax_rows(uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_folio_document_tax_rows(uuid,uuid) TO authenticated;
