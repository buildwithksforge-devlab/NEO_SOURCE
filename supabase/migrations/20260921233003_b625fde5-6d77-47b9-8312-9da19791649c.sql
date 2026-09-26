CREATE OR REPLACE FUNCTION public.neo_folio_projection(_folio uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  f public.folios;
  _net numeric := 0;
  _tax numeric := 0;
  _service numeric := 0;
  _gross numeric := 0;
  _paid numeric := 0;
  _guest text;
  _res text;
BEGIN
  SELECT * INTO f FROM public.folios
   WHERE id = _folio
     AND organization_id = current_org_id()
     AND (in_my_branch_scope(organization_id, branch_id) OR is_org_admin_for(organization_id));
  IF f.id IS NULL THEN RETURN jsonb_build_object('found', false); END IF;

  _gross := COALESCE(f.total_charges, 0);
  _tax := COALESCE(f.total_taxes, 0);
  SELECT COALESCE(SUM(COALESCE(fl.service_charge_amount, 0)), 0)
    INTO _service
    FROM public.folio_lines fl
   WHERE fl.folio_id = f.id
     AND COALESCE(fl.status, 'posted') = 'posted';
  _net := _gross - _tax - _service;

  SELECT COALESCE(SUM(pm.amount), 0) INTO _paid
    FROM public.payments pm
   WHERE pm.folio_id = f.id
     AND pm.status IN ('confirmed', 'posted', 'completed');

  SELECT c.full_name INTO _guest FROM public.customers c WHERE c.id = f.customer_id;
  SELECT r.confirmation_number INTO _res FROM public.reservations r WHERE r.id = f.reservation_id;

  RETURN jsonb_build_object(
    'found', true,
    'folio_id', f.id,
    'folio_number', f.folio_number,
    'status', f.status,
    'currency', f.currency,
    'branch_id', f.branch_id,
    'reservation_id', f.reservation_id,
    'reservation_number', _res,
    'customer_id', f.customer_id,
    'guest_name', _guest,
    'net_revenue', _net,
    'tax', _tax,
    'service_charge', _service,
    'gross_obligation', _gross,
    'collected', _paid,
    'outstanding', _gross - _paid
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.neo_folio_payment_trace(_folio uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'found', EXISTS (SELECT 1 FROM public.folios f WHERE f.id = _folio),
    'folio_id', _folio,
    'payments', COALESCE(
      (
        SELECT jsonb_agg(public.neo_payment_audit_trail(p.id) ORDER BY COALESCE(p.paid_at, p.created_at) DESC)
        FROM public.payments p
        WHERE p.folio_id = _folio
      ),
      '[]'::jsonb
    )
  )
$function$;

REVOKE ALL ON FUNCTION public.neo_folio_payment_trace(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_folio_payment_trace(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_folio_payment_trace(uuid) TO service_role;