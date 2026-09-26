CREATE OR REPLACE FUNCTION public.neo_matching_policy(_org uuid, _branch uuid)
 RETURNS procurement_matching_policies
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  p public.procurement_matching_policies;
  v_org uuid;
BEGIN
  -- Trusted context: signed-in callers are pinned to their active workspace.
  IF auth.uid() IS NOT NULL THEN
    v_org := public.neo_assert_tenant_context(_org);
  ELSE
    v_org := _org;
  END IF;

  SELECT * INTO p FROM public.procurement_matching_policies
   WHERE organization_id = v_org AND branch_id = _branch;
  IF p.id IS NULL THEN
    SELECT * INTO p FROM public.procurement_matching_policies
     WHERE organization_id = v_org AND branch_id IS NULL;
  END IF;
  IF p.id IS NULL THEN
    p.organization_id := v_org;
    p.branch_id := NULL;
    p.match_mode := 'three-way';
    p.price_tolerance_pct := 2;
    p.price_tolerance_amount := 0;
    p.quantity_tolerance_pct := 0;
    p.inventory_account_code := '1070';
    p.grni_account_code := '2015';
    p.payable_account_code := '2010';
    p.tax_input_account_code := '1085';
    p.opening_equity_account_code := '3020';
    p.expense_account_code := '6090';
  END IF;
  RETURN p;
END $function$;