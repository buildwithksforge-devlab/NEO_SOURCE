-- Workforce administration authority: align the backend gate with the
-- canonical administration.users.* capability model. Previously these
-- routines accepted only roles carrying a legacy roles/permissions "manage"
-- permission, so an IT/System Administrator holding the canonical
-- administration capabilities was refused by the backend while the UI
-- offered the action.
CREATE OR REPLACE FUNCTION public.can_manage_workforce()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_org_admin()
      OR public.has_permission('administration', 'users', 'manage')
      OR public.has_permission('administration', 'users', 'invite')
      OR public.has_permission('administration', 'users', 'assign_roles');
$$;

REVOKE ALL ON FUNCTION public.can_manage_workforce() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_workforce() TO authenticated, service_role;
