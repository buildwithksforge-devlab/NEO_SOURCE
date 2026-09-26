
-- 1. Org-scoped admin check
CREATE OR REPLACE FUNCTION public.is_org_admin()
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
    WHERE ur.user_id = auth.uid()
      AND r.name IN ('Owner', 'System Administrator')
      AND ur.organization_id = public.current_org_id()
      AND r.organization_id = public.current_org_id()
  );
$function$;

-- 2. Org-scoped permission check
CREATE OR REPLACE FUNCTION public.has_permission(_module text, _action text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM public.user_permissions up
      JOIN public.permissions p ON p.id = up.permission_id
      WHERE up.user_id = auth.uid() AND up.effect = 'deny'
        AND p.module = _module AND p.action = _action
        AND up.organization_id = public.current_org_id()
    ) THEN false
    WHEN public.is_org_admin() THEN true
    ELSE EXISTS (
      SELECT 1 FROM public.user_roles ur
      JOIN public.roles r ON r.id = ur.role_id AND r.active
      JOIN public.role_permissions rp ON rp.role_id = r.id
      JOIN public.permissions p ON p.id = rp.permission_id
      WHERE ur.user_id = auth.uid() AND p.module = _module AND p.action = _action
        AND ur.organization_id = public.current_org_id()
        AND r.organization_id = public.current_org_id()
        AND rp.organization_id = public.current_org_id()
    ) OR EXISTS (
      SELECT 1 FROM public.user_permissions up
      JOIN public.permissions p ON p.id = up.permission_id
      WHERE up.user_id = auth.uid() AND up.effect = 'grant'
        AND p.module = _module AND p.action = _action
        AND up.organization_id = public.current_org_id()
    )
  END;
$function$;

-- 3. dashboard_alerts write policies require a permission
DROP POLICY IF EXISTS "alerts insert" ON public.dashboard_alerts;
DROP POLICY IF EXISTS "alerts update" ON public.dashboard_alerts;
CREATE POLICY "alerts insert" ON public.dashboard_alerts FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id()
    AND (public.is_org_admin() OR public.has_permission('dashboards','customize')));
CREATE POLICY "alerts update" ON public.dashboard_alerts FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id()
    AND (public.is_org_admin() OR public.has_permission('dashboards','customize')))
  WITH CHECK (organization_id = public.current_org_id()
    AND (public.is_org_admin() OR public.has_permission('dashboards','customize')));

-- 4. provider_webhook_events explicit, org-scoped write policies
DROP POLICY IF EXISTS "provider_webhook_events insert" ON public.provider_webhook_events;
DROP POLICY IF EXISTS "provider_webhook_events update" ON public.provider_webhook_events;
DROP POLICY IF EXISTS "provider_webhook_events delete" ON public.provider_webhook_events;
CREATE POLICY "provider_webhook_events insert" ON public.provider_webhook_events FOR INSERT TO authenticated
  WITH CHECK (organization_id IS NOT NULL AND organization_id = public.current_org_id() AND public.is_org_admin());
CREATE POLICY "provider_webhook_events update" ON public.provider_webhook_events FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id() AND public.is_org_admin())
  WITH CHECK (organization_id IS NOT NULL AND organization_id = public.current_org_id() AND public.is_org_admin());

-- 5. Revoke EXECUTE on SECURITY DEFINER functions from anon; and internal-only ones from authenticated
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig, p.prorettype = 'trigger'::regtype AS is_trigger, p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', r.sig);
    IF r.is_trigger OR r.proname IN (
      'seed_org_dashboards','seed_role_dashboard','evaluate_dashboard_alerts',
      'emit_domain_event','pms_release_expired_holds','pms_post_accommodation',
      'unassigned_accounts','pos_check_table_reservation_overlap'
    ) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', r.sig);
    ELSE
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.sig);
    END IF;
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
  END LOOP;
END $$;
