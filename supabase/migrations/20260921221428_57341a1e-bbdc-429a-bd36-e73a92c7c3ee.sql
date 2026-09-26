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

  -- The folio header owns the canonical obligation. Net is always the balancing
  -- figure (gross minus tax) so gross = net + tax can never disagree.
  _gross := COALESCE(f.total_charges, 0);
  _tax := COALESCE(f.total_taxes, 0);
  _net := _gross - _tax;

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
    'gross_obligation', _gross,
    'collected', _paid,
    'outstanding', _gross - _paid
  );
END;
$function$;