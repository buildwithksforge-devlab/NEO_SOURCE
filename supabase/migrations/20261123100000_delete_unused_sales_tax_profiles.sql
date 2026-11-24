BEGIN;

CREATE FUNCTION public.neo_sales_tax_guard_profile_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF OLD.active OR OLD.workspace_default THEN
    RAISE EXCEPTION 'Archive the sales tax profile before deleting it.' USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.pos_order_items i
    WHERE i.organization_id=OLD.organization_id AND i.sales_tax_snapshot->>'profile_id'=OLD.id::text
  ) THEN
    RAISE EXCEPTION 'This profile appears on saved sales. Keep it archived to preserve that history.' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_sales_tax_guard_profile_delete() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER sales_tax_profile_guard_delete BEFORE DELETE ON public.sales_tax_profiles
FOR EACH ROW EXECUTE FUNCTION public.neo_sales_tax_guard_profile_delete();

GRANT DELETE ON public.sales_tax_profiles TO authenticated;
CREATE POLICY sales_tax_profile_delete ON public.sales_tax_profiles FOR DELETE TO authenticated
USING (organization_id=public.current_org_id() AND public.is_org_admin() AND NOT active);

COMMIT;
