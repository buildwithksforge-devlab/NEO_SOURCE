-- 1. Permission resolution for an arbitrary workspace member -----------------
CREATE OR REPLACE FUNCTION public.neo_user_has_permission_in_org(
  _user uuid, _org uuid, _module text, _feature text, _action text
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
WITH want AS (
  SELECT c.module, c.feature, c.action, public.permission_action_class(c.action) AS cls
    FROM public.canonical_permission(_module, _feature, _action) c
), role_ids AS (
  SELECT ur.role_id
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
   WHERE ur.user_id = _user
     AND ur.organization_id = _org
     AND r.organization_id = _org
     AND coalesce(r.active, true)
     AND coalesce(r.role_status, 'active') <> 'archived'
), perm_ids AS (
  SELECT x.role_id, x.permission_id FROM (
    SELECT b.role_id, b.permission_id
      FROM public.role_permissions_base b JOIN role_ids ri ON ri.role_id = b.role_id
    UNION
    SELECT o.role_id, o.permission_id
      FROM public.role_permission_overrides o JOIN role_ids ri ON ri.role_id = o.role_id
     WHERE o.effect = 'grant'
    UNION
    SELECT r.id, p.id
      FROM public.roles r
      JOIN role_ids ri ON ri.role_id = r.id
      JOIN public.role_feature_templates t ON t.role_key = r.template_key
      JOIN public.permissions p ON p.module = t.module AND p.feature = t.feature AND p.action = t.action
     WHERE r.follows_template
  ) x
  WHERE NOT EXISTS (
    SELECT 1 FROM public.role_permission_overrides d
     WHERE d.role_id = x.role_id AND d.permission_id = x.permission_id AND d.effect = 'deny'
  )
), held AS (
  SELECT c.module, c.feature, c.action, public.permission_action_class(c.action) AS cls, 'deny'::text AS effect
    FROM public.user_permissions up
    JOIN public.permissions p ON p.id = up.permission_id,
         LATERAL public.canonical_permission(p.module, p.feature, p.action) c
   WHERE up.user_id = _user AND up.organization_id = _org AND up.effect = 'deny'
  UNION ALL
  SELECT c.module, c.feature, c.action, public.permission_action_class(c.action), 'grant'
    FROM perm_ids pi
    JOIN public.permissions p ON p.id = pi.permission_id,
         LATERAL public.canonical_permission(p.module, p.feature, p.action) c
  UNION ALL
  SELECT c.module, c.feature, c.action, public.permission_action_class(c.action), 'grant'
    FROM public.user_permissions up
    JOIN public.permissions p ON p.id = up.permission_id,
         LATERAL public.canonical_permission(p.module, p.feature, p.action) c
   WHERE up.user_id = _user AND up.organization_id = _org AND up.effect = 'grant'
     AND (up.valid_from IS NULL OR up.valid_from <= now())
     AND (up.valid_until IS NULL OR up.valid_until >= now())
)
SELECT CASE
  WHEN _user IS NULL OR _org IS NULL THEN false
  WHEN NOT EXISTS (
    SELECT 1 FROM public.profiles pr
     WHERE pr.id = _user AND pr.organization_id = _org
       AND coalesce(pr.account_type, 'staff') = 'staff'
       AND coalesce(pr.account_status, 'active') = 'active'
  ) THEN false
  WHEN EXISTS (
    SELECT 1 FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
     WHERE ur.user_id = _user AND ur.organization_id = _org AND r.organization_id = _org
       AND coalesce(r.active, true) AND coalesce(r.role_status, 'active') <> 'archived'
       AND coalesce(r.normalized_role_key, '') IN ('owner', 'it-system-administrator')
  ) THEN true
  WHEN EXISTS (
    SELECT 1 FROM held h, want w
     WHERE h.effect = 'deny' AND h.module = w.module
       AND (w.feature = '*' OR h.feature IN (w.feature, '*'))
       AND (h.action = w.action OR h.cls = w.cls)
  ) THEN false
  ELSE EXISTS (
    SELECT 1 FROM held h, want w
     WHERE h.effect = 'grant' AND h.module = w.module
       AND (w.feature = '*' OR h.feature IN (w.feature, '*'))
       AND (h.action = w.action OR h.cls = w.cls)
  )
END;
$fn$;

REVOKE ALL ON FUNCTION public.neo_user_has_permission_in_org(uuid, uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_user_has_permission_in_org(uuid, uuid, text, text, text) TO authenticated, service_role;

-- Session-scoped convenience: always resolved inside the caller's own workspace.
CREATE OR REPLACE FUNCTION public.neo_user_has_permission(_user uuid, _module text, _feature text, _action text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT public.neo_user_has_permission_in_org(_user, public.current_org_id(), _module, _feature, _action);
$fn$;

REVOKE ALL ON FUNCTION public.neo_user_has_permission(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_user_has_permission(uuid, text, text, text) TO authenticated, service_role;

-- 2. The canonical Maintenance technician eligibility rule -------------------
CREATE OR REPLACE FUNCTION public.neo_maintenance_technician_eligible(_user uuid, _org uuid, _branch uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_worker_branch uuid;
BEGIN
  IF _user IS NULL OR _org IS NULL THEN RETURN false; END IF;

  SELECT coalesce(p.branch_id, e.branch_id) INTO v_worker_branch
    FROM public.profiles p
    LEFT JOIN LATERAL (
      SELECT e2.* FROM public.employees e2
       WHERE e2.profile_id = p.id AND e2.organization_id = p.organization_id
       ORDER BY e2.updated_at DESC LIMIT 1
    ) e ON true
   WHERE p.id = _user
     AND p.organization_id = _org
     AND coalesce(p.account_type, 'staff') = 'staff'
     AND coalesce(p.account_status, 'active') = 'active'
     AND coalesce(p.employment_status, 'active') NOT IN ('terminated', 'exited', 'resigned')
     AND e.id IS NOT NULL
     AND coalesce(e.employment_status, 'active') NOT IN ('terminated', 'exited', 'resigned')
     AND coalesce(e.system_access_status, 'active') NOT IN ('disabled', 'revoked', 'suspended');

  IF NOT FOUND THEN RETURN false; END IF;

  IF _branch IS NOT NULL AND v_worker_branch IS NOT NULL AND v_worker_branch <> _branch THEN
    RETURN false;
  END IF;

  RETURN public.neo_user_has_permission_in_org(_user, _org, 'maintenance', 'my-jobs', 'view');
END;
$fn$;

REVOKE ALL ON FUNCTION public.neo_maintenance_technician_eligible(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_maintenance_technician_eligible(uuid, uuid, uuid) TO authenticated, service_role;

-- 3. One directory every maintenance selector reads --------------------------
CREATE OR REPLACE FUNCTION public.neo_maintenance_technicians(_branch uuid)
RETURNS TABLE(
  id uuid, full_name text, staff_id text, job_title text,
  department_id uuid, department_name text, branch_id uuid, branch_name text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT w.id, w.full_name, w.staff_id, w.job_title,
         w.department_id, w.department_name, w.branch_id, w.branch_name
    FROM public.neo_scoped_workers(_branch, NULL, NULL) w
   WHERE public.neo_maintenance_technician_eligible(w.id, public.current_org_id(), _branch);
$fn$;

REVOKE ALL ON FUNCTION public.neo_maintenance_technicians(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_maintenance_technicians(uuid) TO authenticated, service_role;

-- 4. Write-time enforcement on every assignment surface ----------------------
CREATE OR REPLACE FUNCTION public.neo_guard_maintenance_assignee()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_name text;
BEGIN
  IF NEW.assigned_to IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.assigned_to IS NOT DISTINCT FROM NEW.assigned_to THEN
    RETURN NEW;
  END IF;

  IF public.neo_maintenance_technician_eligible(NEW.assigned_to, NEW.organization_id, NEW.branch_id) THEN
    RETURN NEW;
  END IF;

  SELECT p.full_name INTO v_name FROM public.profiles p WHERE p.id = NEW.assigned_to;
  RAISE EXCEPTION
    '% cannot receive maintenance work: the account needs an active employee record at this property and the Maintenance "My jobs" permission before it can be assigned.',
    coalesce(nullif(btrim(coalesce(v_name, '')), ''), 'That person');
END;
$fn$;

DROP TRIGGER IF EXISTS neo_guard_maintenance_assignee ON public.maintenance_work_orders;
CREATE TRIGGER neo_guard_maintenance_assignee
  BEFORE INSERT OR UPDATE OF assigned_to ON public.maintenance_work_orders
  FOR EACH ROW EXECUTE FUNCTION public.neo_guard_maintenance_assignee();

DROP TRIGGER IF EXISTS neo_guard_preventive_plan_assignee ON public.preventive_maintenance_plans;
CREATE TRIGGER neo_guard_preventive_plan_assignee
  BEFORE INSERT OR UPDATE OF assigned_to ON public.preventive_maintenance_plans
  FOR EACH ROW EXECUTE FUNCTION public.neo_guard_maintenance_assignee();

-- 5. Preventive due figures follow the property being viewed -----------------
DO $patch$
DECLARE def text; patched text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'neo_operational_facts';

  patched := replace(def,
    $old$      'preventive_due', (SELECT count(*) FROM public.preventive_maintenance_occurrences p
         WHERE p.organization_id = org AND p.status NOT IN ('completed','cancelled')
           AND p.due_date <= today + 7))$old$,
    $new$      'preventive_due', (SELECT count(*) FROM public.preventive_maintenance_occurrences p
         JOIN public.preventive_maintenance_plans pl
           ON pl.id = p.plan_id AND pl.organization_id = p.organization_id
         WHERE p.organization_id = org AND p.status NOT IN ('completed','cancelled')
           AND (_branch IS NULL OR pl.branch_id = _branch)
           AND p.due_date <= today + 7))$new$);

  IF patched = def THEN
    RAISE EXCEPTION 'neo_operational_facts preventive_due block not found — aborting rather than guessing';
  END IF;
  EXECUTE patched;
END;
$patch$;

-- 6. My Work never offers a maintenance queue the person cannot open ---------
DO $patch$
DECLARE def text; patched text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'neo_my_work';

  patched := replace(def,
    $old$    v_items := v_items || jsonb_build_array(
      jsonb_build_object('id','my-work-orders','module','housekeeping','label','Work orders assigned to me',
        'value', n2, 'detail', n1 || ' open work order(s) in total','route','/maintenance/my-jobs',
        'tone', CASE WHEN n2 > 0 THEN 'info' ELSE 'ok' END),
      jsonb_build_object('id','rooms-blocked','module','housekeeping','label','Rooms held out of service',
        'value', n3, 'detail','Open faults recorded as blocking the room','route','/maintenance/work-orders',
        'tone', CASE WHEN n3 > 0 THEN 'warning' ELSE 'ok' END));$old$,
    $new$    IF public.has_permission('maintenance', 'my-jobs', 'view') THEN
      v_items := v_items || jsonb_build_array(
        jsonb_build_object('id','my-work-orders','module','maintenance','label','Work orders assigned to me',
          'value', n2, 'detail', n1 || ' open work order(s) in total','route','/maintenance/my-jobs',
          'tone', CASE WHEN n2 > 0 THEN 'info' ELSE 'ok' END));
    END IF;
    v_items := v_items || jsonb_build_array(
      jsonb_build_object('id','rooms-blocked','module','maintenance','label','Rooms held out of service',
        'value', n3, 'detail','Open faults recorded as blocking the room','route','/maintenance',
        'tone', CASE WHEN n3 > 0 THEN 'warning' ELSE 'ok' END));$new$);

  IF patched = def THEN
    RAISE EXCEPTION 'neo_my_work maintenance block not found — aborting rather than guessing';
  END IF;
  EXECUTE patched;
END;
$patch$;