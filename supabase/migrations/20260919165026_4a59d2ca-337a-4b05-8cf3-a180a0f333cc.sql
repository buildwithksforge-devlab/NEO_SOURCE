-- 1. Cross-tenant relationship guard ------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_assert_tenant_fk()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  _parent text := TG_ARGV[0];
  _pcol   text := TG_ARGV[1];
  _ccol   text := TG_ARGV[2];
  _cval   uuid;
  _corg   uuid;
  _porg   uuid;
BEGIN
  EXECUTE format('SELECT ($1).%I, ($1).organization_id', _ccol) INTO _cval, _corg USING NEW;
  IF _cval IS NULL OR _corg IS NULL THEN
    RETURN NEW;
  END IF;
  EXECUTE format('SELECT organization_id FROM public.%I WHERE %I = $1', _parent, _pcol)
    INTO _porg USING _cval;
  IF _porg IS NOT NULL AND _porg <> _corg THEN
    RAISE EXCEPTION 'Cross-workspace relationship blocked: %.% references %(%) owned by another workspace',
      TG_TABLE_NAME, _ccol, _parent, _cval
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

DO $do$
DECLARE r record;
BEGIN
  FOR r IN
    WITH fk AS (
      SELECT con.conname, c1.relname AS child, c2.relname AS parent,
             (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = con.conrelid AND a.attnum = con.conkey[1]) AS ccol,
             (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = con.confrelid AND a.attnum = con.confkey[1]) AS pcol,
             array_length(con.conkey, 1) AS ncols
        FROM pg_constraint con
        JOIN pg_class c1 ON c1.oid = con.conrelid
        JOIN pg_class c2 ON c2.oid = con.confrelid
        JOIN pg_namespace n ON n.oid = c1.relnamespace
       WHERE con.contype = 'f' AND n.nspname = 'public'
    ), org AS (
      SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'organization_id'
    )
    SELECT * FROM fk
     WHERE ncols = 1
       AND child IN (SELECT table_name FROM org)
       AND parent IN (SELECT table_name FROM org)
       AND parent NOT IN ('profiles','organizations')
       AND ccol <> 'organization_id'
       AND child ~ '^(journal|folio|payment|invoice|supplier_invoice|stock_|inventory_|requisition|store_|goods_|purchase_|reservation|room|housekeeping|asset|work_order|maintenance|employee|menu_items|recipes|pos_|guest_|bank_|budget|credit_note|expense_)'
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       WHERE c.relname = r.child AND t.tgname = left('tgtf_' || r.conname, 63)
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF %I ON public.%I FOR EACH ROW EXECUTE FUNCTION public.neo_assert_tenant_fk(%L, %L, %L)',
        left('tgtf_' || r.conname, 63), r.ccol, r.child, r.parent, r.pcol, r.ccol);
    END IF;
  END LOOP;
END;
$do$;

-- 2. Quarantine register for pre-existing cross-tenant links -------------------
CREATE TABLE IF NOT EXISTS public.tenant_relationship_violations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  constraint_name text NOT NULL,
  child_table text NOT NULL,
  child_column text NOT NULL,
  child_id uuid NOT NULL,
  parent_table text NOT NULL,
  parent_id uuid NOT NULL,
  parent_organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'quarantined',
  resolution_note text,
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (constraint_name, child_id)
);

GRANT SELECT ON public.tenant_relationship_violations TO authenticated;
GRANT ALL ON public.tenant_relationship_violations TO service_role;
ALTER TABLE public.tenant_relationship_violations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_relationship_violations_read" ON public.tenant_relationship_violations;
CREATE POLICY "tenant_relationship_violations_read"
  ON public.tenant_relationship_violations FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id() AND public.is_org_admin_for(organization_id));

-- 3. Privileged function review metadata --------------------------------------
ALTER TABLE public.privileged_function_review
  ADD COLUMN IF NOT EXISTS classification text,
  ADD COLUMN IF NOT EXISTS trusts_client_tenant boolean,
  ADD COLUMN IF NOT EXISTS search_path_fixed boolean,
  ADD COLUMN IF NOT EXISTS domain text;

-- 4. Trusted-context fixes -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_assert_tenant_context(_org uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE _cur uuid := public.current_org_id();
BEGIN
  IF _org IS NULL THEN
    RETURN _cur;
  END IF;
  IF _cur IS NULL OR _org <> _cur THEN
    RAISE EXCEPTION 'Workspace context mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN _cur;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.neo_reporting_candidate_rows_for(_org uuid, _profile uuid, _branch uuid, _keys text[], _min_level integer)
 RETURNS TABLE(profile_id uuid, full_name text, staff_id text, job_title text, role_key text, role_name text, branch_id uuid, department_id uuid, management_level integer, property_match text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH scope AS (SELECT public.neo_assert_tenant_context(_org) AS org),
  candidate AS (
    SELECT DISTINCT ON (p.id)
           p.id, p.full_name, p.staff_id, p.job_title,
           ro.normalized_role_key AS rkey, ro.name AS rname,
           p.branch_id AS bid, p.department_id AS did,
           COALESCE(ro.management_level, c.management_level, 0) AS lvl,
           COALESCE(c.managerial_scope, 'self') AS mscope
      FROM public.profiles p
      CROSS JOIN scope s
      JOIN public.user_roles ur ON ur.user_id = p.id AND ur.organization_id = s.org
      JOIN public.roles ro ON ro.id = ur.role_id
      LEFT JOIN public.role_catalogue c ON c.role_key = ro.normalized_role_key
     WHERE p.organization_id = s.org
       AND p.account_type = 'staff'
       AND p.account_status = 'active'
       AND p.invitation_status NOT IN ('suspended','deactivated')
       AND p.id <> COALESCE(_profile, '00000000-0000-0000-0000-000000000000'::uuid)
       AND ro.active
       AND ro.role_status <> 'archived'
       AND ro.normalized_role_key = ANY(COALESCE(_keys, '{}'::text[]))
     ORDER BY p.id, COALESCE(ro.management_level, c.management_level, 0) DESC
  )
  SELECT cd.id, cd.full_name, cd.staff_id, cd.job_title, cd.rkey, cd.rname,
         cd.bid, cd.did, cd.lvl,
         CASE
           WHEN _branch IS NULL OR cd.bid IS NULL THEN 'organisation'
           WHEN cd.bid = _branch THEN 'property'
           ELSE 'wider'
         END
    FROM candidate cd
   WHERE cd.lvl >= COALESCE(_min_level, 0)
     AND (
       _branch IS NULL OR cd.bid IS NULL OR cd.bid = _branch
       OR cd.mscope IN ('organisation','property')
     )
     AND NOT EXISTS (
       WITH RECURSIVE up(id, manager) AS (
         SELECT p2.id, p2.reporting_manager_id FROM public.profiles p2 WHERE p2.id = cd.id
         UNION ALL
         SELECT p3.id, p3.reporting_manager_id
           FROM public.profiles p3 JOIN up ON up.manager = p3.id
       )
       SELECT 1 FROM up WHERE up.id = _profile
     )
   ORDER BY cd.lvl DESC, cd.full_name;
$function$;

CREATE OR REPLACE FUNCTION public.provision_catalogue_roles(_org uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _created integer := 0;
  _granted integer := 0;
  _revoked integer := 0;
BEGIN
  IF _org IS NULL THEN
    RAISE EXCEPTION 'Workspace is required' USING ERRCODE = '22023';
  END IF;
  -- Trusted context: signed-in callers may only provision their own workspace,
  -- and only as an administrator of it. System/service context (no auth.uid())
  -- is permitted for platform provisioning routines.
  IF auth.uid() IS NOT NULL AND NOT public.is_org_admin_for(_org) THEN
    RAISE EXCEPTION 'Not permitted for this workspace' USING ERRCODE = '42501';
  END IF;

  WITH ins AS (
    INSERT INTO public.roles (organization_id, name, description, is_system, active, access_scope)
    SELECT _org, c.role_name, c.summary, true, true, c.access_scope
    FROM public.role_catalogue c
    ON CONFLICT (organization_id, name) DO UPDATE
      SET description  = EXCLUDED.description,
          access_scope = EXCLUDED.access_scope,
          is_system    = true,
          updated_at   = now()
    RETURNING (xmax = 0) AS inserted
  )
  SELECT count(*) FILTER (WHERE inserted) INTO _created FROM ins;

  WITH added AS (
    INSERT INTO public.role_permissions_base (organization_id, role_id, permission_id)
    SELECT _org, r.id, p.id
    FROM public.role_catalogue c
    JOIN public.roles r ON r.organization_id = _org AND r.name = c.role_name
    JOIN public.role_permission_templates t ON t.template_key = c.role_key
    JOIN public.permissions p ON p.module = t.module AND p.action = t.action
    WHERE (
      position('.' in t.action) > 0
      OR p.feature NOT IN ('menu','settings','configuration','pricing','rate_plans','catalogue')
      OR p.action IN ('view','print','export','access')
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.role_permissions_base rp
      WHERE rp.role_id = r.id AND rp.permission_id = p.id
    )
    RETURNING 1
  )
  SELECT count(*) INTO _granted FROM added;

  WITH removed AS (
    DELETE FROM public.role_permissions_base rp
    USING public.roles r,
          public.permissions p,
          public.restricted_actions ra,
          public.role_catalogue c
    WHERE rp.role_id = r.id
      AND r.organization_id = _org
      AND rp.permission_id = p.id
      AND p.module = ra.module
      AND p.action = ra.action
      AND c.role_name = r.name
      AND c.restricted_authority = false
    RETURNING 1
  )
  SELECT count(*) INTO _revoked FROM removed;

  RETURN jsonb_build_object(
    'organization_id', _org,
    'roles_created', _created,
    'permissions_granted', _granted,
    'restricted_permissions_revoked', _revoked
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.provision_catalogue_roles(uuid) FROM authenticated, anon;

-- 5. Standing tenant-safety health scan ---------------------------------------
CREATE OR REPLACE FUNCTION public.neo_tenant_safety_scan()
RETURNS TABLE(check_key text, severity text, findings bigint, detail jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  RETURN QUERY
  SELECT 'privileged_functions_unclassified', 'high',
         count(*)::bigint,
         jsonb_build_object('sample', coalesce(jsonb_agg(f.proname) FILTER (WHERE true), '[]'::jsonb))
    FROM (
      SELECT p.proname
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prosecdef
         AND NOT EXISTS (
           SELECT 1 FROM public.privileged_function_review r
            WHERE r.function_name = p.proname
              AND r.identity_arguments = pg_get_function_identity_arguments(p.oid)
              AND r.classification IS NOT NULL)
       LIMIT 25
    ) f;

  RETURN QUERY
  SELECT 'privileged_functions_without_fixed_search_path', 'high', count(*)::bigint, '{}'::jsonb
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef
     AND coalesce(array_to_string(p.proconfig, ','), '') NOT ILIKE '%search_path%';

  RETURN QUERY
  SELECT 'nullable_tenant_keys_unclassified', 'medium', count(*)::bigint, '{}'::jsonb
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
   WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND c.is_nullable = 'YES'
     AND NOT EXISTS (
       SELECT 1 FROM public.tenant_column_classification k
        WHERE k.table_name = c.table_name AND k.column_name = c.column_name);

  RETURN QUERY
  SELECT 'tenant_owned_tables_without_ownership_column', 'medium', count(*)::bigint, '{}'::jsonb
    FROM information_schema.tables t
   WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public' AND c.table_name = t.table_name
          AND c.column_name IN ('organization_id','organisation_id'))
     AND NOT EXISTS (
       SELECT 1 FROM public.tenant_column_classification k
        WHERE k.table_name = t.table_name AND k.column_name = '(none)');

  RETURN QUERY
  SELECT 'cross_tenant_links_open', 'high', count(*)::bigint, '{}'::jsonb
    FROM public.tenant_relationship_violations v
   WHERE v.status = 'quarantined';
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.neo_tenant_safety_scan() FROM public;
GRANT EXECUTE ON FUNCTION public.neo_tenant_safety_scan() TO service_role;