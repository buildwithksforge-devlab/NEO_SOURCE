CREATE POLICY delivery_zones_customer_read ON public.delivery_zones
  FOR SELECT TO authenticated
  USING (
    active
    AND EXISTS (
      SELECT 1 FROM public.customers c
      WHERE c.id = public.my_customer_id()
        AND c.organization_id = delivery_zones.organization_id
    )
  );

CREATE POLICY delivery_settings_customer_read ON public.delivery_settings
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.customers c
      WHERE c.id = public.my_customer_id()
        AND c.organization_id = delivery_settings.organization_id
    )
  );