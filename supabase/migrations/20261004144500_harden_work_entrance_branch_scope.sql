-- Staff work entrances must follow effective branch access.
-- Being employed by an organisation must never expose every property in it.
-- Partner and rider relationships retain their own independent scope rules.

CREATE OR REPLACE FUNCTION public.neo_my_entrances()
RETURNS TABLE(
  branch_id uuid,
  organization_id uuid,
  property_name text,
  organization_name text,
  public_slug text,
  portal_slug text,
  logo_url text,
  work boolean,
  rider boolean,
  partner boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH me AS (
    SELECT auth.uid() AS uid
  ),
  staff_orgs AS (
    SELECT p.organization_id
      FROM public.profiles p, me
     WHERE p.id = me.uid
       AND COALESCE(p.account_status, 'active') = 'active'
       AND COALESCE(p.account_type, 'staff') <> 'customer'
       AND p.organization_id IS NOT NULL
  ),
  rider_rows AS (
    SELECT r.organization_id, r.branch_id
      FROM public.rider_profiles r, me
     WHERE r.active IS TRUE
       AND (
         r.profile_id = me.uid
         OR r.employee_id IN (
           SELECT e.id
             FROM public.employees e
            WHERE e.profile_id = me.uid
         )
       )
  ),
  partner_rows AS (
    SELECT a.organization_id, a.branch_id
      FROM public.neo_access_relationships a, me
     WHERE a.auth_user_id = me.uid
       AND a.door = 'partner'
       AND a.status = 'active'
  )
  SELECT
    b.id,
    b.organization_id,
    COALESCE(NULLIF(e.display_name, ''), b.name),
    o.name,
    e.public_slug,
    b.portal_slug,
    b.logo_url,

    (
      b.organization_id IN (SELECT organization_id FROM staff_orgs)
      AND public.neo_branch_in_scope(b.id)
      AND COALESCE((e.doors ->> 'work')::boolean, true)
    ) AS work,

    (
      EXISTS (
        SELECT 1
          FROM rider_rows r
         WHERE r.organization_id = b.organization_id
           AND (r.branch_id IS NULL OR r.branch_id = b.id)
      )
      AND COALESCE((e.doors ->> 'rider')::boolean, true)
    ) AS rider,

    (
      EXISTS (
        SELECT 1
          FROM partner_rows p
         WHERE p.organization_id = b.organization_id
           AND (p.branch_id IS NULL OR p.branch_id = b.id)
      )
      AND COALESCE((e.doors ->> 'partner')::boolean, true)
    ) AS partner

  FROM public.branches b
  JOIN public.organizations o
    ON o.id = b.organization_id
  LEFT JOIN public.neo_public_experience e
    ON e.branch_id = b.id

  WHERE b.active IS TRUE
    AND public.neo_platform_tenant_active(b.organization_id)
    AND (
      (
        b.organization_id IN (SELECT organization_id FROM staff_orgs)
        AND public.neo_branch_in_scope(b.id)
      )
      OR EXISTS (
        SELECT 1
          FROM rider_rows r
         WHERE r.organization_id = b.organization_id
           AND (r.branch_id IS NULL OR r.branch_id = b.id)
      )
      OR EXISTS (
        SELECT 1
          FROM partner_rows p
         WHERE p.organization_id = b.organization_id
           AND (p.branch_id IS NULL OR p.branch_id = b.id)
      )
    )

  ORDER BY o.name, b.name
  LIMIT 24;
$function$;

REVOKE ALL ON FUNCTION public.neo_my_entrances() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_my_entrances() TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';