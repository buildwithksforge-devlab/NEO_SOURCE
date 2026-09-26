-- Stage A of the NEØ permanent authorisation repair.
-- Additive and reversible: no data is deleted, no UUIDs change.

-- 1. Administrative authority becomes capability-driven instead of role-name driven.
--    Rollback: restore the previous body which matched r.normalized_role_key IN ('owner','it-system-administrator').
CREATE OR REPLACE FUNCTION public.is_org_admin()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT public.is_active_staff() AND (
    EXISTS (
      SELECT 1
        FROM public.user_roles ur
        JOIN public.roles r ON r.id = ur.role_id
        JOIN public.role_permissions rp ON rp.role_id = r.id
        JOIN public.permissions p ON p.id = rp.permission_id
       WHERE ur.user_id = auth.uid()
         AND ur.organization_id = public.current_org_id()
         AND r.organization_id = public.current_org_id()
         AND r.role_status <> 'archived'
         AND r.active
         AND p.module IN ('roles','permissions')
         AND p.action = 'manage'
    )
    OR EXISTS (
      SELECT 1
        FROM public.user_permissions up
        JOIN public.permissions p ON p.id = up.permission_id
       WHERE up.user_id = auth.uid()
         AND up.organization_id = public.current_org_id()
         AND up.effect = 'grant'
         AND (up.valid_from IS NULL OR up.valid_from <= now())
         AND (up.valid_until IS NULL OR up.valid_until >= now())
         AND p.module IN ('roles','permissions')
         AND p.action = 'manage'
    )
  );
$function$;

-- 2. Operations Manager resolves to a dedicated Operations dashboard, not the
--    General Manager dashboard. Rollback: change 'operations' back to 'general-manager'.
CREATE OR REPLACE FUNCTION public.neo_dashboard_key(_role_key text, _role_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT coalesce(
    CASE _role_key
      WHEN 'owner' THEN 'owner'
      WHEN 'operations-manager' THEN 'operations'
      WHEN 'general-manager' THEN 'general-manager'
      WHEN 'finance-manager' THEN 'finance'
      WHEN 'accountant' THEN 'finance'
      WHEN 'night-auditor' THEN 'finance'
      WHEN 'food-and-beverage-manager' THEN 'restaurant-operations'
      WHEN 'waiter' THEN 'restaurant-floor'
      WHEN 'barista' THEN 'coffee-station'
      WHEN 'bar-attendant' THEN 'bar'
      WHEN 'head-chef' THEN 'kitchen-overview'
      WHEN 'hot-kitchen-chef' THEN 'hot-kitchen'
      WHEN 'chief-steward' THEN 'kitchen-overview'
      WHEN 'kitchen-steward' THEN 'hot-kitchen'
      WHEN 'head-pastry-chef' THEN 'pastry'
      WHEN 'pastry-chef' THEN 'pastry'
      WHEN 'front-office-supervisor' THEN 'front-office'
      WHEN 'receptionist' THEN 'front-office'
      WHEN 'reservations-agent' THEN 'front-office'
      WHEN 'front-office-cashier' THEN 'front-office'
      WHEN 'porter' THEN 'front-office'
      WHEN 'driver' THEN 'delivery'
      WHEN 'housekeeping-supervisor' THEN 'housekeeping'
      WHEN 'housekeeper' THEN 'housekeeping'
      WHEN 'laundry-supervisor' THEN 'housekeeping'
      WHEN 'laundry-attendant' THEN 'housekeeping'
      WHEN 'maintenance-manager' THEN 'maintenance'
      WHEN 'maintenance-technician' THEN 'maintenance'
      WHEN 'grounds-worker' THEN 'maintenance'
      WHEN 'marketing-manager' THEN 'marketing'
      WHEN 'sales-and-events-manager' THEN 'events'
      WHEN 'events-coordinator' THEN 'events'
      WHEN 'banqueting-staff' THEN 'events'
      WHEN 'procurement-manager' THEN 'procurement'
      WHEN 'procurement-officer' THEN 'procurement'
      WHEN 'storekeeper' THEN 'stores'
      WHEN 'receiving-clerk' THEN 'stores'
      WHEN 'human-resources-manager' THEN 'human-resources'
      WHEN 'hr-officer' THEN 'human-resources'
      WHEN 'it-system-administrator' THEN 'administration'
      WHEN 'delivery-manager' THEN 'delivery'
      WHEN 'rider' THEN 'delivery'
      ELSE NULL
    END,
    public.dashboard_key_for_role(_role_name),
    'staff');
$function$;

-- 3. A strictly read-only replacement for the login-time reconciliation call.
--    It reports what a sign-in found; it never provisions, grants or migrates.
CREATE OR REPLACE FUNCTION public.neo_workspace_link_status()
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'user_id', auth.uid(),
    'has_profile', EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid()),
    'attempt_recorded', EXISTS (
      SELECT 1 FROM public.workspace_provisioning_attempts a
       WHERE a.user_id = auth.uid()
         OR lower(a.email) = lower(coalesce((SELECT u.email FROM auth.users u WHERE u.id = auth.uid()), ''))),
    'candidate_workspaces', (
      SELECT count(*) FROM public.workspace_provisioning_attempts a
       WHERE a.user_id = auth.uid()
         OR lower(a.email) = lower(coalesce((SELECT u.email FROM auth.users u WHERE u.id = auth.uid()), '')))
  );
$function$;

REVOKE ALL ON FUNCTION public.neo_workspace_link_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_workspace_link_status() TO authenticated;

-- 4. Unresolved role-ownership decisions are surfaced, never guessed.
--    Each row is one worker whose recorded job title or role combination needs
--    an explicit human decision before their access can be narrowed.
CREATE OR REPLACE VIEW public.neo_pending_role_decisions AS
WITH assigned AS (
  SELECT ur.user_id, ur.organization_id, r.id AS role_id, r.name AS role_name,
         r.normalized_role_key, ur.is_primary,
         EXISTS (
           SELECT 1 FROM public.role_permissions rp
             JOIN public.permissions p ON p.id = rp.permission_id
            WHERE rp.role_id = r.id AND p.module IN ('roles','permissions') AND p.action = 'manage'
         ) AS confers_admin
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
   WHERE r.role_status <> 'archived'
)
SELECT
  a.user_id,
  a.organization_id,
  pr.full_name,
  pr.job_title,
  string_agg(a.role_name, ' + ' ORDER BY a.role_name) AS current_roles,
  max(CASE WHEN a.is_primary THEN a.role_name END) AS primary_role,
  bool_or(a.confers_admin) AS holds_admin_authority,
  count(*) FILTER (WHERE a.confers_admin) AS admin_role_count,
  CASE
    WHEN count(*) > 1 AND bool_or(a.confers_admin)
      THEN 'This worker holds an administrative role alongside an operational role. Confirm which role is intended before the extra authority is withdrawn.'
    WHEN pr.job_title IS NOT NULL AND pr.job_title <> ''
         AND NOT bool_or(lower(a.role_name) = lower(pr.job_title))
      THEN 'The recorded job title does not match any assigned role. Confirm the intended role.'
    ELSE NULL
  END AS reason
  FROM assigned a
  JOIN public.profiles pr ON pr.id = a.user_id
 GROUP BY a.user_id, a.organization_id, pr.full_name, pr.job_title
HAVING (count(*) > 1 AND bool_or(a.confers_admin))
    OR (pr.job_title IS NOT NULL AND pr.job_title <> ''
        AND NOT bool_or(lower(a.role_name) = lower(pr.job_title)));

ALTER VIEW public.neo_pending_role_decisions SET (security_invoker = true);
GRANT SELECT ON public.neo_pending_role_decisions TO authenticated;