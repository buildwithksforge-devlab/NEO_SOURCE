DROP POLICY IF EXISTS "profiles tenant read" ON public.profiles;
CREATE POLICY "profiles tenant read" ON public.profiles FOR SELECT
USING (
  id = (SELECT auth.uid())
  OR ((SELECT public.current_org_id()) IS NOT NULL
      AND organization_id = (SELECT public.current_org_id())
      AND (SELECT public.is_staff()))
);

DROP POLICY IF EXISTS "profiles self update" ON public.profiles;
CREATE POLICY "profiles self update" ON public.profiles FOR UPDATE
USING (
  id = (SELECT auth.uid())
  OR ((SELECT public.current_org_id()) IS NOT NULL
      AND organization_id = (SELECT public.current_org_id())
      AND (SELECT public.is_org_admin()))
)
WITH CHECK (
  ((SELECT public.current_org_id()) IS NOT NULL
   AND organization_id = (SELECT public.current_org_id())
   AND (SELECT public.is_org_admin()))
  OR (id = (SELECT auth.uid())
      AND NOT (organization_id IS DISTINCT FROM (SELECT public.my_profile_org()))
      AND account_status = (SELECT public.my_profile_account_status())
      AND account_type = (SELECT public.my_account_type()))
);

DROP POLICY IF EXISTS "profiles admin read customers" ON public.profiles;
CREATE POLICY "profiles admin read customers" ON public.profiles FOR SELECT
USING (
  account_type = 'customer'
  AND (SELECT public.is_org_admin())
  AND (SELECT public.current_org_id()) IS NOT NULL
  AND public.customer_profile_in_my_org(id)
);

DROP POLICY IF EXISTS "profiles admin delete" ON public.profiles;
CREATE POLICY "profiles admin delete" ON public.profiles FOR DELETE
USING (
  (SELECT public.is_org_admin())
  AND id <> (SELECT auth.uid())
  AND (SELECT public.current_org_id()) IS NOT NULL
  AND (organization_id = (SELECT public.current_org_id())
       OR (organization_id IS NULL
           AND account_type = 'customer'
           AND public.customer_profile_in_my_org(id)))
);

DROP TRIGGER IF EXISTS neo_invalidate_access_trg ON public.profiles;
CREATE TRIGGER neo_invalidate_access_ins_del_trg
AFTER INSERT OR DELETE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.neo_invalidate_access();

CREATE TRIGGER neo_invalidate_access_upd_trg
AFTER UPDATE ON public.profiles
FOR EACH ROW
WHEN (
  OLD.organization_id IS DISTINCT FROM NEW.organization_id
  OR OLD.branch_id IS DISTINCT FROM NEW.branch_id
  OR OLD.department_id IS DISTINCT FROM NEW.department_id
  OR OLD.account_type IS DISTINCT FROM NEW.account_type
  OR OLD.account_status IS DISTINCT FROM NEW.account_status
  OR OLD.employment_status IS DISTINCT FROM NEW.employment_status
  OR OLD.invitation_status IS DISTINCT FROM NEW.invitation_status
)
EXECUTE FUNCTION public.neo_invalidate_access();

DROP TRIGGER IF EXISTS trg_neo_structure_guard ON public.profiles;
CREATE TRIGGER trg_neo_structure_guard_ins
BEFORE INSERT ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.neo_structure_guard();

CREATE TRIGGER trg_neo_structure_guard_upd
BEFORE UPDATE ON public.profiles
FOR EACH ROW
WHEN (
  OLD.organization_id IS DISTINCT FROM NEW.organization_id
  OR OLD.branch_id IS DISTINCT FROM NEW.branch_id
  OR OLD.department_id IS DISTINCT FROM NEW.department_id
)
EXECUTE FUNCTION public.neo_structure_guard();

DROP TRIGGER IF EXISTS profiles_self_update_guard ON public.profiles;
CREATE TRIGGER profiles_self_update_guard
BEFORE UPDATE OF organization_id, account_type, account_status, employment_status,
  invitation_status, branch_id, department_id, job_title, staff_id, created_by,
  invited_by, invited_at, email, locked_until, failed_login_count, avatar_url, phone
ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.enforce_profile_self_update();