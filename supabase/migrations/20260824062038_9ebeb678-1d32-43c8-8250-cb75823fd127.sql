CREATE OR REPLACE FUNCTION public.current_org_id()
 RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (SELECT organization_id FROM public.profiles
      WHERE id = auth.uid()
        AND account_type IN ('staff','platform_admin')
        AND account_status = 'active'),
    -- Trusted system context only: never applies to a signed-in caller.
    CASE WHEN auth.uid() IS NULL
      THEN nullif(current_setting('neo.system_org', true), '')::uuid END
  );
$function$;

CREATE OR REPLACE FUNCTION public.neo_set_system_org()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL AND NEW.organization_id IS NOT NULL THEN
    PERFORM set_config('neo.system_org', NEW.organization_id::text, true);
  END IF;
  RETURN NEW;
END $function$;

REVOKE ALL ON FUNCTION public.neo_set_system_org() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pos_orders','folio_lines','payments','guest_laundry_orders',
                           'delivery_orders','event_bookings','invoices','supplier_invoices','supplier_payments'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS aaa_neo_system_org_ctx ON public.%I', t);
    EXECUTE format('CREATE TRIGGER aaa_neo_system_org_ctx BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.neo_set_system_org()', t);
  END LOOP;
END $$;