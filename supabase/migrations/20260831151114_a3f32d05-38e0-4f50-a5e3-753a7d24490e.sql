-- A custom role is a live role. Only an archived role should remove a worker
-- from the assignable list, or a department's own officers become invisible to
-- their manager.
CREATE OR REPLACE FUNCTION public.neo_scoped_workers(_branch uuid DEFAULT NULL::uuid, _department uuid DEFAULT NULL::uuid, _department_key text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, full_name text, staff_id text, job_title text, department_id uuid, department_name text, branch_id uuid, branch_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH requested_department AS (
    SELECT d.id,
           coalesce(
             nullif(btrim(coalesce(d.catalogue_key,'')),''),
             public.neo_department_catalogue_key(d.name),
             lower(btrim(d.name))
           ) AS ident,
           d.branch_id
      FROM public.departments d
     WHERE _department IS NOT NULL
       AND d.id = _department
       AND d.organization_id = public.current_org_id()
       AND coalesce(d.active, true)
       AND coalesce(d.department_status, 'active') <> 'archived'
       AND (_branch IS NULL OR d.branch_id IS NULL OR d.branch_id = _branch)
  ), wanted AS (
    SELECT coalesce(
             nullif(btrim(_department_key), ''),
             (SELECT ident FROM requested_department LIMIT 1)
           ) AS ident
  ), active_staff AS (
    SELECT DISTINCT ON (p.id)
           p.id,
           p.full_name,
           p.staff_id,
           coalesce(nullif(p.job_title, ''), nullif(e.job_title, '')) AS job_title,
           coalesce(p.department_id, e.department_id) AS staff_department_id,
           coalesce(p.branch_id, e.branch_id) AS staff_branch_id
      FROM public.profiles p
      JOIN public.employees e
        ON e.profile_id = p.id
       AND e.organization_id = p.organization_id
       AND coalesce(e.employment_status, 'active') NOT IN ('terminated', 'exited', 'resigned')
       AND coalesce(e.system_access_status, 'active') NOT IN ('disabled', 'revoked', 'suspended')
     WHERE p.organization_id = public.current_org_id()
       AND coalesce(p.account_status, 'active') = 'active'
       AND coalesce(p.employment_status, 'active') NOT IN ('terminated', 'exited', 'resigned')
       AND (_branch IS NULL OR coalesce(p.branch_id, e.branch_id) = _branch)
       AND public.neo_branch_in_scope(coalesce(p.branch_id, e.branch_id))
       AND EXISTS (
         SELECT 1
           FROM public.user_roles ur
           JOIN public.roles r
             ON r.id = ur.role_id
            AND r.organization_id = p.organization_id
            AND coalesce(r.active, true)
            AND coalesce(r.role_status, 'active') <> 'archived'
           LEFT JOIN public.departments rd
             ON rd.id = r.department_id
          CROSS JOIN wanted w
          WHERE ur.user_id = p.id
            AND ur.organization_id = p.organization_id
            AND (
              w.ident IS NULL
              OR (
                rd.id IS NOT NULL
                AND coalesce(
                  nullif(btrim(coalesce(rd.catalogue_key,'')),''),
                  public.neo_department_catalogue_key(rd.name),
                  lower(btrim(rd.name))
                ) = w.ident
              )
            )
       )
       AND (
         (SELECT ident FROM wanted) IS NULL
         OR EXISTS (
           SELECT 1
             FROM public.departments sd
            WHERE sd.id IN (p.department_id, e.department_id)
              AND sd.organization_id = p.organization_id
              AND coalesce(sd.active, true)
              AND coalesce(sd.department_status, 'active') <> 'archived'
              AND (_branch IS NULL OR sd.branch_id IS NULL OR sd.branch_id = _branch)
              AND coalesce(
                nullif(btrim(coalesce(sd.catalogue_key,'')),''),
                public.neo_department_catalogue_key(sd.name),
                lower(btrim(sd.name))
              ) = (SELECT ident FROM wanted)
         )
       )
     ORDER BY p.id, (p.department_id IS NOT NULL) DESC, (p.branch_id IS NOT NULL) DESC
  )
  SELECT a.id,
         a.full_name,
         a.staff_id,
         a.job_title,
         a.staff_department_id,
         d.name,
         a.staff_branch_id,
         b.name
    FROM active_staff a
    LEFT JOIN public.departments d ON d.id = a.staff_department_id
    LEFT JOIN public.branches b ON b.id = a.staff_branch_id
   ORDER BY a.full_name, a.staff_id;
$function$;