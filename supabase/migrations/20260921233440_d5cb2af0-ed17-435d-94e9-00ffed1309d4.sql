CREATE OR REPLACE FUNCTION public.neo_guest_folio_projection(_org uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _cust uuid; _folios jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT id INTO _cust FROM public.customers
   WHERE organization_id = _org AND auth_user_id = auth.uid() AND merged_into_id IS NULL
   LIMIT 1;
  IF _cust IS NULL THEN
    RETURN jsonb_build_object('folios', '[]'::jsonb, 'payments', '[]'::jsonb);
  END IF;

  SELECT coalesce(jsonb_agg(f ORDER BY f->>'opened_at' DESC), '[]'::jsonb) INTO _folios
  FROM (
    SELECT jsonb_build_object(
      'id', fo.id,
      'folio_number', fo.folio_number,
      'status', fo.status,
      'currency', fo.currency,
      'opened_at', fo.opened_at,
      'closed_at', fo.closed_at,
      'net_revenue', coalesce(fo.total_charges, 0) - coalesce(fo.total_taxes, 0) - coalesce(sc.amount, 0),
      'tax', coalesce(fo.total_taxes, 0),
      'service_charge', coalesce(sc.amount, 0),
      'gross_obligation', coalesce(fo.total_charges, 0),
      'collected', coalesce(py.amount, 0),
      'outstanding', coalesce(fo.total_charges, 0) - coalesce(py.amount, 0),
      'total_discounts', fo.total_discounts,
      'lines', (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
                 'id', fl.id,
                 'description', coalesce(fl.description, fl.category),
                 'quantity', fl.quantity,
                 'unit_price', fl.unit_price,
                 'tax_amount', fl.tax_amount,
                 'discount_amount', fl.discount_amount,
                 'net_amount', fl.net_amount,
                 'posting_date', fl.posting_date) ORDER BY fl.posting_date), '[]'::jsonb)
        FROM public.folio_lines fl
        WHERE fl.folio_id = fo.id AND coalesce(fl.status,'posted') <> 'void'
      )) AS f
    FROM public.folios fo
    LEFT JOIN LATERAL (
      SELECT coalesce(sum(coalesce(fl.service_charge_amount, 0)), 0) AS amount
      FROM public.folio_lines fl
      WHERE fl.folio_id = fo.id AND coalesce(fl.status, 'posted') = 'posted'
    ) sc ON true
    LEFT JOIN LATERAL (
      SELECT coalesce(sum(p.amount), 0) AS amount
      FROM public.payments p
      WHERE p.folio_id = fo.id AND p.status IN ('confirmed', 'posted', 'completed')
    ) py ON true
    WHERE fo.organization_id = _org AND fo.customer_id = _cust
  ) s;

  RETURN jsonb_build_object(
    'folios', _folios,
    'payments', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'id', p.id,
               'receipt_number', p.receipt_number,
               'amount', p.amount,
               'currency', p.currency,
               'method', p.method,
               'paid_at', p.paid_at,
               'folio_id', p.folio_id) ORDER BY p.paid_at DESC), '[]'::jsonb)
      FROM public.payments p
      WHERE p.organization_id = _org AND p.customer_id = _cust
        AND coalesce(p.status,'completed') NOT IN ('void','voided','failed')
      LIMIT 50));
END;
$function$;