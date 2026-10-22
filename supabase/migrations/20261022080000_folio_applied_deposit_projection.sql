-- Include applied deposits that have no corresponding payments row.
-- Preserves existing guest-ledger and property access checks.
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
  IF auth.uid() IS NULL
     OR public.can_read_guest_ledger() IS NOT TRUE
  THEN
    RAISE EXCEPTION 'Guest ledger read permission required'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO f FROM public.folios
   WHERE id = _folio
     AND organization_id = current_org_id()
     AND (
       in_my_branch_scope(organization_id, branch_id)
       OR is_org_admin_for(organization_id)
     );

  IF f.id IS NULL THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  SELECT COALESCE(SUM(fl.net_amount), 0),
         COALESCE(SUM(fl.tax_amount), 0),
         COALESCE(SUM(fl.service_charge_amount), 0)
    INTO _gross, _tax, _service
    FROM public.folio_lines fl
   WHERE fl.folio_id = f.id
     AND fl.organization_id = f.organization_id
     AND COALESCE(fl.status, 'posted')
         NOT IN ('void', 'voided', 'reversed')
     AND COALESCE(fl.line_type, 'charge')
         NOT IN ('payment', 'deposit', 'refund');

  _net := _gross - _tax - _service;

  SELECT COALESCE(SUM(pm.amount), 0) INTO _paid
    FROM public.payments pm
   WHERE pm.folio_id = f.id
     -- neo_folio_payment_tenant_guard_v1
     AND pm.organization_id = f.organization_id
     AND pm.status IN ('confirmed', 'posted', 'completed');

  -- neo_folio_applied_deposit_projection_v1
  -- These deposits have no payments row, so the payment sum excludes them.
  SELECT _paid + COALESCE(SUM(d.amount), 0)
    INTO _paid
    FROM public.reservation_deposits d
   WHERE d.organization_id = f.organization_id
     AND d.applied_folio_id = f.id
     AND d.status = 'applied'
     AND d.payment_id IS NULL
     AND EXISTS (
       SELECT 1
       FROM public.folio_lines fl
       WHERE fl.id = d.applied_folio_line_id
         AND fl.folio_id = f.id
         AND fl.organization_id = f.organization_id
         AND fl.line_type IN ('payment', 'deposit')
         AND COALESCE(fl.status, 'posted')
             NOT IN ('void', 'voided', 'reversed')
         AND fl.net_amount = d.amount
     );

  SELECT c.full_name INTO _guest
    FROM public.customers c WHERE c.id = f.customer_id;

  SELECT r.confirmation_number INTO _res
    FROM public.reservations r WHERE r.id = f.reservation_id;

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
