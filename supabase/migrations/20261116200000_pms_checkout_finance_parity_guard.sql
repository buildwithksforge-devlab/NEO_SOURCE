-- PMS checkout / Finance reconciliation diagnostic.
-- Does NOT replace pms_check_out or change any guest financial records.
-- Service-role inspection only until real PostgreSQL integration tests pass.

BEGIN;

CREATE OR REPLACE FUNCTION public.neo_pms_checkout_finance_diagnostic(
  _reservation uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $diagnostic$
DECLARE
  v_org uuid := public.current_org_id();
  v_stay public.stays;
  v_checkout_charges numeric := 0;
  v_checkout_allocations numeric := 0;
  v_checkout_lines numeric := 0;
  v_checkout_balance numeric := 0;
  v_finance_balance numeric := 0;
  v_finance_collected numeric := 0;
  v_finance_charges numeric := 0;
  v_folio_count integer := 0;
  v_folio public.folios;
  v_components jsonb;
  v_details jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL
     OR v_org IS NULL
     OR NOT (
       public.has_permission('pms','checkout.perform')
       OR public.is_org_admin()
     )
  THEN
    RAISE EXCEPTION 'Checkout review permission required'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_stay
  FROM public.stays s
  WHERE s.reservation_id = _reservation
    AND s.organization_id = v_org;

  IF NOT FOUND
     OR NOT coalesce(
       public.neo_branch_in_scope(v_stay.branch_id),false
     )
  THEN
    RAISE EXCEPTION 'Stay not available in your property scope'
      USING ERRCODE = '42501';
  END IF;

  FOR v_folio IN
    SELECT *
    FROM public.folios f
    WHERE f.stay_id = v_stay.id
      AND f.organization_id = v_org
  LOOP
    v_folio_count := v_folio_count + 1;

    v_components := public.neo_folio_financial_components(
      v_folio.id,v_org
    );

    IF coalesce(v_components->>'found','false') <> 'true'
       OR v_components->>'outstanding' IS NULL
       OR v_components->>'gross_obligation' IS NULL
       OR v_components->>'collected' IS NULL
    THEN
      RAISE EXCEPTION 'Canonical Finance projection is incomplete'
        USING ERRCODE = '23514';
    END IF;

    v_finance_balance := v_finance_balance +
      (v_components->>'outstanding')::numeric;

    v_finance_charges := v_finance_charges +
      (v_components->>'gross_obligation')::numeric;

    v_finance_collected := v_finance_collected +
      (v_components->>'collected')::numeric;

    v_details := v_details || jsonb_build_array(
      jsonb_build_object(
        'folio_id',v_folio.id,
        'folio_type',v_folio.folio_type,
        'stored_balance',v_folio.balance,
        'finance',v_components
      )
    );
  END LOOP;

  IF v_folio_count = 0 THEN
    RAISE EXCEPTION 'No financial folio exists for this stay'
      USING ERRCODE = '23514';
  END IF;

  -- Existing checkout calculation: all valid charge lines.
  SELECT coalesce(sum(l.net_amount),0)
  INTO v_checkout_charges
  FROM public.folio_lines l
  JOIN public.folios f ON f.id=l.folio_id
  WHERE f.stay_id=v_stay.id
    AND f.organization_id=v_org
    AND coalesce(l.status,'posted')
        NOT IN ('void','voided','reversed')
    AND coalesce(l.line_type,'charge')
        NOT IN ('payment','deposit','refund');

  -- Existing checkout calculation: confirmed allocations.
  SELECT coalesce(sum(a.amount),0)
  INTO v_checkout_allocations
  FROM public.payment_allocations a
  JOIN public.folios f ON f.id=a.folio_id
  JOIN public.payments p ON p.id=a.payment_id
  WHERE f.stay_id=v_stay.id
    AND f.organization_id=v_org
    AND p.organization_id=v_org
    AND p.status='confirmed';

  -- Existing checkout calculation: payment/deposit lines.
  SELECT coalesce(sum(l.net_amount),0)
  INTO v_checkout_lines
  FROM public.folio_lines l
  JOIN public.folios f ON f.id=l.folio_id
  WHERE f.stay_id=v_stay.id
    AND f.organization_id=v_org
    AND coalesce(l.status,'posted')
        NOT IN ('void','voided','reversed')
    AND coalesce(l.line_type,'charge')
        IN ('payment','deposit');

  v_checkout_balance := round(
    v_checkout_charges-v_checkout_allocations-v_checkout_lines,2
  );

  RETURN jsonb_build_object(
    'reservation_id',_reservation,
    'stay_id',v_stay.id,
    'folio_count',v_folio_count,
    'checkout_method',jsonb_build_object(
      'charges',v_checkout_charges,
      'confirmed_allocations',v_checkout_allocations,
      'payment_and_deposit_lines',v_checkout_lines,
      'outstanding',v_checkout_balance
    ),
    'finance_method',jsonb_build_object(
      'charges',v_finance_charges,
      'collected',v_finance_collected,
      'outstanding',round(v_finance_balance,2)
    ),
    'difference',round(v_checkout_balance-v_finance_balance,2),
    'matches',
      abs(v_checkout_balance-v_finance_balance)<=0.005,
    'folios',v_details
  );
END;
$diagnostic$;

REVOKE ALL ON FUNCTION
  public.neo_pms_checkout_finance_diagnostic(uuid)
FROM PUBLIC,anon,authenticated;

GRANT EXECUTE ON FUNCTION
  public.neo_pms_checkout_finance_diagnostic(uuid)
TO service_role;

COMMIT;