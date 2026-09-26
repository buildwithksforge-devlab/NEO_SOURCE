
-- 1. Routines only the system should run. Every remaining caller is itself a
--    SECURITY DEFINER routine or a scheduled job, so revoking direct access
--    from signed-in users does not break any in-app path.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         'neo_approval_execute','neo_autoseed_role_aliases','neo_bump_access_epoch',
         'neo_install_default_workflows','neo_provisioning_step','outbox_reap_expired_leases',
         'pms_escalate_overdue_requests','pms_expire_waitlist','pms_release_expired_blocks',
         'pos_recalc_order_totals','provision_catalogue_roles','seed_dashboard_catalogue')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
  END LOOP;
END $$;

-- 2. Routines that stay callable but must never touch another workspace.
CREATE OR REPLACE FUNCTION public.neo_finance_ensure_account(
  _org uuid, _code text, _name text, _category text, _group text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE a uuid;
BEGIN
  IF auth.uid() IS NOT NULL AND _org IS DISTINCT FROM public.current_org_id() THEN
    RAISE EXCEPTION 'Not allowed for another workspace' USING ERRCODE = '42501';
  END IF;
  SELECT id INTO a FROM public.chart_of_accounts WHERE organization_id = _org AND code = _code;
  IF a IS NULL THEN
    INSERT INTO public.chart_of_accounts (organization_id, code, name, category, account_group, is_header, postable)
    VALUES (_org, _code, _name, _category, _group, false, true)
    RETURNING id INTO a;
  END IF;
  RETURN a;
END
$fn$;

CREATE OR REPLACE FUNCTION public.neo_kitchen_alert(
  _org uuid, _branch uuid, _user uuid, _kind text, _title text, _body text,
  _link text, _priority text, _alert_key text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE _nid uuid;
BEGIN
  IF _org IS NULL THEN RETURN NULL; END IF;
  IF auth.uid() IS NOT NULL AND _org IS DISTINCT FROM public.current_org_id() THEN
    RAISE EXCEPTION 'Not allowed for another workspace' USING ERRCODE = '42501';
  END IF;
  _nid := public.neo_notify(_org, _user, _branch, 'operational-alert', _title, _body, _link,
                            coalesce(_priority, 'normal'), false, 'kitchen', NULL, _kind, _alert_key);
  INSERT INTO public.kitchen_alert_log (organization_id, branch_id, alert_key, kind, suppressed, notification_id)
  VALUES (_org, _branch, _alert_key, _kind, _nid IS NULL, _nid);
  RETURN _nid;
END
$fn$;
