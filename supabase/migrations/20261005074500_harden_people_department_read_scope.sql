-- NEØ people/directory read-scope hardening.
-- No business data is changed.
-- Self remains visible.
-- Organisation-scope management remains organisation-wide.
-- Property users cannot read another property's people.
-- Ordinary property users are additionally department/supervision bounded.

-- ---------------------------------------------------------------------------
-- PROFILES
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "profiles tenant read" ON public.profiles;
DROP POLICY IF EXISTS "profiles scoped read" ON public.profiles;

CREATE POLICY "profiles scoped read"
ON public.profiles
FOR SELECT
TO authenticated
USING (
  id = auth.uid()
  OR (
    organization_id = public.current_org_id()
    AND (
      public.is_org_admin()

      OR public.current_access_scope() = 'organisation'

      OR (
        public.current_access_scope() <> 'technical'
        AND branch_id IS NOT NULL
        AND branch_id = ANY(
          COALESCE(public.current_branch_ids(), '{}'::uuid[])
        )
        AND (
          department_id = ANY(
            COALESCE(public.current_department_ids(), '{}'::uuid[])
          )
          OR public.can_view_role_directory()
          OR public.supervises_user(id)
        )
      )
    )
  )
);

-- ---------------------------------------------------------------------------
-- EMPLOYEES
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "employees tenant read" ON public.employees;
DROP POLICY IF EXISTS "employees scoped read" ON public.employees;

CREATE POLICY "employees scoped read"
ON public.employees
FOR SELECT
TO authenticated
USING (
  profile_id = auth.uid()
  OR (
    organization_id = public.current_org_id()
    AND (
      public.is_org_admin()

      OR public.current_access_scope() = 'organisation'

      OR (
        public.current_access_scope() <> 'technical'
        AND branch_id IS NOT NULL
        AND branch_id = ANY(
          COALESCE(public.current_branch_ids(), '{}'::uuid[])
        )
        AND (
          department_id = ANY(
            COALESCE(public.current_department_ids(), '{}'::uuid[])
          )
          OR public.can_view_role_directory()
          OR (
            profile_id IS NOT NULL
            AND public.supervises_user(profile_id)
          )
        )
      )
    )
  )
);

-- ---------------------------------------------------------------------------
-- DEPARTMENTS
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "departments tenant read" ON public.departments;
DROP POLICY IF EXISTS "departments scoped read" ON public.departments;

CREATE POLICY "departments scoped read"
ON public.departments
FOR SELECT
TO authenticated
USING (
  organization_id = public.current_org_id()
  AND (
    public.is_org_admin()

    OR public.current_access_scope() = 'organisation'

    OR (
      public.current_access_scope() <> 'technical'
      AND (
        branch_id IS NULL
        OR branch_id = ANY(
          COALESCE(public.current_branch_ids(), '{}'::uuid[])
        )
      )
    )
  )
);

NOTIFY pgrst, 'reload schema';