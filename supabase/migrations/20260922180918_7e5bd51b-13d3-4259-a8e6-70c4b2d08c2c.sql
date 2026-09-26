CREATE OR REPLACE FUNCTION public.neo_delivery_can_record_payment(_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public.has_permission('finance','payments','create')
      OR public.has_permission('finance','invoices','create')
      OR public.has_permission('finance','approve')
      OR public.has_permission('finance','collections','collect_payment')
      OR public.has_permission('finance','collections','settle_bill')
      OR public.has_permission('finance','collections','issue_receipt')
      OR public.is_org_admin_for(_org);
$$;

REVOKE ALL ON FUNCTION public.neo_delivery_can_record_payment(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_delivery_can_record_payment(uuid) TO authenticated, service_role;
