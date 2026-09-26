CREATE OR REPLACE FUNCTION public.my_rider_branch_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT branch_id FROM public.rider_profiles
  WHERE profile_id = auth.uid() AND active AND organization_id = public.current_org_id()
  LIMIT 1;
$$;

DROP POLICY IF EXISTS delivery_orders_rider_waiting_read ON public.delivery_orders;

CREATE POLICY delivery_orders_rider_waiting_read
ON public.delivery_orders
FOR SELECT
TO authenticated
USING (
  public.my_rider_id() IS NOT NULL
  AND organization_id = public.current_org_id()
  AND branch_id IS NOT DISTINCT FROM public.my_rider_branch_id()
  AND rider_id IS NULL
  AND fulfilment_type = 'delivery'
  AND order_status = ANY (ARRAY['confirmed','in-preparation','ready-for-pickup'])
);