-- ============================================================
-- NEO Access Scope Layer (additive, reversible)
-- Stage 1: canonical scope resolution helpers
-- ============================================================

ALTER TABLE public.roles ADD COLUMN IF NOT EXISTS access_scope text;

COMMENT ON COLUMN public.roles.access_scope IS
  'organisation|branch|department|team|self|technical - overrides the platform default derived from the role name.';

CREATE OR REPLACE FUNCTION public.role_scope_level(_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN lower(coalesce(_name,'')) IN ('owner','director','managing director') THEN 'organisation'
    WHEN lower(coalesce(_name,'')) IN ('system administrator') THEN 'technical'
    WHEN lower(coalesce(_name,'')) IN ('general manager','operations manager','duty manager') THEN 'branch'
    WHEN lower(coalesce(_name,'')) LIKE '%manager%' THEN 'department'
    WHEN lower(coalesce(_name,'')) LIKE '%supervisor%'
      OR lower(coalesce(_name,'')) LIKE 'head %'
      OR lower(coalesce(_name,'')) IN ('human resources','accountant') THEN 'team'
    ELSE 'self'
  END;
$$;

CREATE OR REPLACE FUNCTION public.scope_rank(_scope text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE _scope
    WHEN 'organisation' THEN 5
    WHEN 'branch' THEN 4
    WHEN 'department' THEN 3
    WHEN 'team' THEN 2
    WHEN 'self' THEN 1
    WHEN 'technical' THEN 0
    ELSE 1 END;
$$;

CREATE OR REPLACE FUNCTION public.current_staff_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM public.profiles
  WHERE id = auth.uid()
    AND account_type IN ('staff','platform_admin')
    AND account_status = 'active';
$$;

CREATE OR REPLACE FUNCTION public.current_organisation_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$ SELECT public.current_org_id(); $$;

CREATE OR REPLACE FUNCTION public.current_branch_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(array_agg(DISTINCT b), '{}'::uuid[]) FROM (
    SELECT ub.branch_id AS b FROM public.user_branches ub
      WHERE ub.user_id = auth.uid() AND ub.branch_id IS NOT NULL
    UNION
    SELECT p.branch_id FROM public.profiles p
      WHERE p.id = auth.uid() AND p.branch_id IS NOT NULL
  ) s;
$$;

CREATE OR REPLACE FUNCTION public.current_department_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(array_agg(DISTINCT d), '{}'::uuid[]) FROM (
    SELECT ud.department_id AS d FROM public.user_departments ud
      WHERE ud.user_id = auth.uid() AND ud.department_id IS NOT NULL
    UNION
    SELECT p.department_id FROM public.profiles p
      WHERE p.id = auth.uid() AND p.department_id IS NOT NULL
  ) s;
$$;

CREATE OR REPLACE FUNCTION public.current_station_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(array_agg(DISTINCT us.station_id), '{}'::uuid[])
  FROM public.user_stations us
  WHERE us.user_id = auth.uid() AND us.station_id IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION public.current_access_scope()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(
    (SELECT s.lvl FROM (
       SELECT coalesce(r.access_scope, public.role_scope_level(r.name)) AS lvl
       FROM public.user_roles ur
       JOIN public.roles r ON r.id = ur.role_id
       WHERE ur.user_id = auth.uid()
         AND ur.organization_id = public.current_org_id()
     ) s
     ORDER BY public.scope_rank(s.lvl) DESC
     LIMIT 1),
    'self');
$$;

CREATE OR REPLACE FUNCTION public.manages_department(_department_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT _department_id IS NOT NULL
     AND public.scope_rank(public.current_access_scope()) >= 3
     AND (public.scope_rank(public.current_access_scope()) >= 4
          OR _department_id = ANY (public.current_department_ids()));
$$;

CREATE OR REPLACE FUNCTION public.supervises_user(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT _user_id IS NOT NULL AND (
    _user_id = auth.uid()
    OR (
      public.scope_rank(public.current_access_scope()) >= 2
      AND EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = _user_id
          AND p.organization_id = public.current_org_id()
          AND (public.scope_rank(public.current_access_scope()) >= 5
               OR p.branch_id IS NULL
               OR p.branch_id = ANY (public.current_branch_ids()))
          AND (public.scope_rank(public.current_access_scope()) >= 4
               OR p.department_id = ANY (public.current_department_ids()))
      )
    )
  );
$$;

CREATE TABLE IF NOT EXISTS public.record_assistants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  record_type text NOT NULL,
  record_id uuid NOT NULL,
  user_id uuid NOT NULL,
  granted_by uuid,
  reason text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (record_type, record_id, user_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.record_assistants TO authenticated;
GRANT ALL ON public.record_assistants TO service_role;
ALTER TABLE public.record_assistants ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.work_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid,
  record_type text NOT NULL,
  record_id uuid NOT NULL,
  transferred_from_user_id uuid,
  transferred_to_user_id uuid,
  transferred_by_user_id uuid,
  reason text,
  transferred_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.work_transfers TO authenticated;
GRANT ALL ON public.work_transfers TO service_role;
ALTER TABLE public.work_transfers ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.is_shared_with_me(_record_type text, _record_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.record_assistants ra
    WHERE ra.record_type = _record_type
      AND ra.record_id = _record_id
      AND ra.user_id = auth.uid()
      AND ra.active
      AND ra.organization_id = public.current_org_id()
  );
$$;

CREATE OR REPLACE FUNCTION public.in_my_scope(
  _org uuid,
  _branch uuid,
  _department uuid,
  _station uuid,
  _assigned_user uuid,
  _created_by uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN _org IS NULL OR _org <> public.current_org_id() THEN false
    ELSE CASE public.current_access_scope()
      WHEN 'organisation' THEN true
      WHEN 'branch' THEN (_branch IS NULL OR _branch = ANY (public.current_branch_ids()))
      WHEN 'department' THEN
        (_branch IS NULL OR _branch = ANY (public.current_branch_ids()))
        AND (
          _department = ANY (public.current_department_ids())
          OR _station = ANY (public.current_station_ids())
          OR _assigned_user = auth.uid()
          OR _created_by = auth.uid()
          OR public.supervises_user(_assigned_user)
        )
      WHEN 'team' THEN
        (_branch IS NULL OR _branch = ANY (public.current_branch_ids()))
        AND (
          _station = ANY (public.current_station_ids())
          OR _assigned_user = auth.uid()
          OR _created_by = auth.uid()
          OR public.supervises_user(_assigned_user)
        )
      WHEN 'technical' THEN false
      ELSE (_assigned_user = auth.uid() OR _created_by = auth.uid())
    END
  END;
$$;

REVOKE EXECUTE ON FUNCTION public.role_scope_level(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.scope_rank(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.current_staff_id() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.current_organisation_id() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.current_branch_ids() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.current_department_ids() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.current_station_ids() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.current_access_scope() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.manages_department(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.supervises_user(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_shared_with_me(text, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.in_my_scope(uuid,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.role_scope_level(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.scope_rank(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_staff_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_organisation_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_branch_ids() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_department_ids() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_station_ids() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_access_scope() TO authenticated;
GRANT EXECUTE ON FUNCTION public.manages_department(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.supervises_user(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_shared_with_me(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.in_my_scope(uuid,uuid,uuid,uuid,uuid,uuid) TO authenticated;

DROP POLICY IF EXISTS record_assistants_select ON public.record_assistants;
CREATE POLICY record_assistants_select ON public.record_assistants FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id()
         AND (user_id = auth.uid() OR granted_by = auth.uid() OR public.supervises_user(user_id)));

DROP POLICY IF EXISTS record_assistants_insert ON public.record_assistants;
CREATE POLICY record_assistants_insert ON public.record_assistants FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id()
              AND granted_by = auth.uid()
              AND public.scope_rank(public.current_access_scope()) >= 2);

DROP POLICY IF EXISTS record_assistants_update ON public.record_assistants;
CREATE POLICY record_assistants_update ON public.record_assistants FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id()
         AND public.scope_rank(public.current_access_scope()) >= 2
         AND (granted_by = auth.uid() OR public.supervises_user(user_id)));

DROP POLICY IF EXISTS record_assistants_delete ON public.record_assistants;
CREATE POLICY record_assistants_delete ON public.record_assistants FOR DELETE TO authenticated
  USING (organization_id = public.current_org_id()
         AND public.scope_rank(public.current_access_scope()) >= 2
         AND (granted_by = auth.uid() OR public.supervises_user(user_id)));

DROP POLICY IF EXISTS work_transfers_select ON public.work_transfers;
CREATE POLICY work_transfers_select ON public.work_transfers FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id()
         AND (transferred_from_user_id = auth.uid()
              OR transferred_to_user_id = auth.uid()
              OR transferred_by_user_id = auth.uid()
              OR public.scope_rank(public.current_access_scope()) >= 2));

DROP POLICY IF EXISTS work_transfers_insert ON public.work_transfers;
CREATE POLICY work_transfers_insert ON public.work_transfers FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id()
              AND transferred_by_user_id = auth.uid());