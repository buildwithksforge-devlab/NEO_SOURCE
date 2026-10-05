-- NEØ Asset custody integrity + atomic movement
-- 2026-10-04
--
-- Guarantees:
--   asset property -> department -> custodian
--   active worker and role alignment
--   direct asset writes cannot bypass custody integrity
--   asset movement + asset state update happen atomically
--   asset movement history follows asset visibility scope

-- ---------------------------------------------------------------------------
-- 1. Row-level asset integrity
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.neo_validate_asset_custody()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_department public.departments;
  v_profile public.profiles;
  v_employee public.employees;
  v_worker_branch uuid;
  v_department_key text;
  v_worker_department_ok boolean;
  v_worker_role_ok boolean;
BEGIN
  -- Asset organisation is mandatory by schema, but fail clearly.
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'An asset must belong to an organisation';
  END IF;

  -- -----------------------------------------------------------------------
  -- Department must belong to this organisation and property.
  -- Organisation-wide departments remain valid for a property.
  -- -----------------------------------------------------------------------
  IF NEW.department_id IS NOT NULL THEN
    SELECT *
      INTO v_department
      FROM public.departments d
     WHERE d.id = NEW.department_id
       AND d.organization_id = NEW.organization_id;

    IF v_department.id IS NULL THEN
      RAISE EXCEPTION 'The selected asset department does not belong to this organisation';
    END IF;

    IF NOT coalesce(v_department.active, true)
       OR coalesce(v_department.department_status, 'active') = 'archived' THEN
      RAISE EXCEPTION 'The selected asset department is not active';
    END IF;

    IF v_department.branch_id IS NOT NULL
       AND NEW.branch_id IS DISTINCT FROM v_department.branch_id THEN
      RAISE EXCEPTION 'The selected asset department belongs to another property';
    END IF;
  END IF;

  -- No custodian means there is no worker relationship to validate.
  IF NEW.custodian_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- A worker assignment must have a complete parent chain.
  IF NEW.branch_id IS NULL THEN
    RAISE EXCEPTION 'Select the asset property before assigning a custodian';
  END IF;

  IF NEW.department_id IS NULL THEN
    RAISE EXCEPTION 'Select the asset department before assigning a custodian';
  END IF;

  v_department_key := coalesce(
    nullif(btrim(coalesce(v_department.catalogue_key, '')), ''),
    public.neo_department_catalogue_key(v_department.name),
    lower(btrim(v_department.name))
  );

  -- -----------------------------------------------------------------------
  -- Worker profile
  -- -----------------------------------------------------------------------
  SELECT *
    INTO v_profile
    FROM public.profiles p
   WHERE p.id = NEW.custodian_id
     AND p.organization_id = NEW.organization_id;

  IF v_profile.id IS NULL THEN
    RAISE EXCEPTION 'That custodian is not a staff account in this organisation';
  END IF;

  IF coalesce(v_profile.account_status, 'active') <> 'active'
     OR coalesce(v_profile.employment_status, 'active')
        IN ('terminated', 'exited', 'resigned') THEN
    RAISE EXCEPTION 'That custodian''s account is not active';
  END IF;

  -- -----------------------------------------------------------------------
  -- Latest HR employee record
  -- -----------------------------------------------------------------------
  SELECT *
    INTO v_employee
    FROM public.employees e
   WHERE e.profile_id = v_profile.id
     AND e.organization_id = NEW.organization_id
   ORDER BY e.updated_at DESC
   LIMIT 1;

  IF v_employee.id IS NULL THEN
    RAISE EXCEPTION 'That custodian is not linked to an active HR employee record';
  END IF;

  IF coalesce(v_employee.employment_status, 'active')
       IN ('terminated', 'exited', 'resigned')
     OR coalesce(v_employee.system_access_status, 'active')
       IN ('disabled', 'revoked', 'suspended') THEN
    RAISE EXCEPTION 'That custodian is not an active employee';
  END IF;

  -- Exact property match.
  v_worker_branch := coalesce(v_profile.branch_id, v_employee.branch_id);

  IF v_worker_branch IS DISTINCT FROM NEW.branch_id THEN
    RAISE EXCEPTION 'That custodian belongs to another property';
  END IF;

  -- -----------------------------------------------------------------------
  -- Worker department identity must match asset department identity.
  -- This mirrors neo_assert_worker_scope().
  -- -----------------------------------------------------------------------
  SELECT EXISTS (
    SELECT 1
      FROM public.departments d
     WHERE d.id IN (v_profile.department_id, v_employee.department_id)
       AND d.organization_id = NEW.organization_id
       AND coalesce(d.active, true)
       AND coalesce(d.department_status, 'active') <> 'archived'
       AND (d.branch_id IS NULL OR d.branch_id = NEW.branch_id)
       AND coalesce(
         nullif(btrim(coalesce(d.catalogue_key, '')), ''),
         public.neo_department_catalogue_key(d.name),
         lower(btrim(d.name))
       ) = v_department_key
  )
  INTO v_worker_department_ok;

  IF NOT coalesce(v_worker_department_ok, false) THEN
    RAISE EXCEPTION
      'That custodian is not assigned to the asset department for this property';
  END IF;

  -- -----------------------------------------------------------------------
  -- Worker must hold an active role for that canonical department.
  -- -----------------------------------------------------------------------
  SELECT EXISTS (
    SELECT 1
      FROM public.user_roles ur
      JOIN public.roles r
        ON r.id = ur.role_id
       AND r.organization_id = NEW.organization_id
       AND coalesce(r.active, true)
       AND coalesce(r.role_status, 'active') <> 'archived'
      JOIN public.departments rd
        ON rd.id = r.department_id
     WHERE ur.user_id = v_profile.id
       AND ur.organization_id = NEW.organization_id
       AND coalesce(
         nullif(btrim(coalesce(rd.catalogue_key, '')), ''),
         public.neo_department_catalogue_key(rd.name),
         lower(btrim(rd.name))
       ) = v_department_key
  )
  INTO v_worker_role_ok;

  IF NOT coalesce(v_worker_role_ok, false) THEN
    RAISE EXCEPTION
      'That custodian does not hold an active role for the asset department';
  END IF;

  RETURN NEW;
END
$function$;


DROP TRIGGER IF EXISTS neo_validate_asset_custody_trg
ON public.assets;

CREATE TRIGGER neo_validate_asset_custody_trg
BEFORE INSERT OR UPDATE OF
  organization_id,
  branch_id,
  department_id,
  custodian_id
ON public.assets
FOR EACH ROW
EXECUTE FUNCTION public.neo_validate_asset_custody();


REVOKE ALL
ON FUNCTION public.neo_validate_asset_custody()
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE
ON FUNCTION public.neo_validate_asset_custody()
TO service_role;


-- ---------------------------------------------------------------------------
-- 2. Asset movement RLS
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS asset_movements_select
ON public.asset_movements;

CREATE POLICY asset_movements_select
ON public.asset_movements
FOR SELECT
TO authenticated
USING (
  organization_id = public.current_org_id()
  AND EXISTS (
    SELECT 1
      FROM public.assets a
     WHERE a.id = asset_movements.asset_id
       AND a.organization_id = asset_movements.organization_id
       AND (
         public.in_my_config_scope(
           a.organization_id,
           a.branch_id
         )
         OR
         public.in_my_scope(
           a.organization_id,
           a.branch_id,
           a.department_id,
           NULL::uuid,
           NULL::uuid,
           a.created_by
         )
       )
  )
);


DROP POLICY IF EXISTS asset_movements_insert
ON public.asset_movements;

CREATE POLICY asset_movements_insert
ON public.asset_movements
FOR INSERT
TO authenticated
WITH CHECK (
  organization_id = public.current_org_id()
  AND performed_by = auth.uid()
  AND (
    public.has_permission('maintenance', 'edit')
    OR public.has_permission('maintenance', 'approve')
    OR public.is_org_admin()
  )
  AND EXISTS (
    SELECT 1
      FROM public.assets a
     WHERE a.id = asset_movements.asset_id
       AND a.organization_id = asset_movements.organization_id
       AND public.in_my_scope(
         a.organization_id,
         a.branch_id,
         a.department_id,
         NULL::uuid,
         NULL::uuid,
         a.created_by
       )
  )
);


-- ---------------------------------------------------------------------------
-- 3. Atomic asset movement command
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.neo_asset_move(
  _asset uuid,
  _new_location text,
  _new_department_id uuid DEFAULT NULL,
  _new_custodian uuid DEFAULT NULL,
  _movement_type text DEFAULT 'transfer',
  _reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_org uuid := public.current_org_id();
  v_actor uuid := auth.uid();
  v_asset public.assets;
  v_department public.departments;
  v_department_key text;
  v_movement uuid;
  v_reason text := nullif(btrim(coalesce(_reason, '')), '');
  v_type text := coalesce(nullif(btrim(_movement_type), ''), 'transfer');
BEGIN
  IF v_org IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'No authenticated organisation context is available';
  END IF;

  SELECT *
    INTO v_asset
    FROM public.assets a
   WHERE a.id = _asset
     AND a.organization_id = v_org
   FOR UPDATE;

  IF v_asset.id IS NULL THEN
    RAISE EXCEPTION 'Asset not found in your organisation';
  END IF;

  IF NOT public.in_my_scope(
    v_asset.organization_id,
    v_asset.branch_id,
    v_asset.department_id,
    NULL::uuid,
    NULL::uuid,
    v_asset.created_by
  ) THEN
    RAISE EXCEPTION 'This asset is outside your authorised scope';
  END IF;

  IF NOT (
    public.has_permission('maintenance', 'edit')
    OR public.has_permission('maintenance', 'approve')
    OR public.is_org_admin()
  ) THEN
    RAISE EXCEPTION 'You do not have permission to move this asset';
  END IF;

  IF v_asset.branch_id IS NULL THEN
    RAISE EXCEPTION 'The asset must belong to a property before it can be transferred';
  END IF;

  -- Validate destination department when supplied.
  IF _new_department_id IS NOT NULL THEN
    SELECT *
      INTO v_department
      FROM public.departments d
     WHERE d.id = _new_department_id
       AND d.organization_id = v_org;

    IF v_department.id IS NULL THEN
      RAISE EXCEPTION 'The destination department does not belong to this organisation';
    END IF;

    IF NOT coalesce(v_department.active, true)
       OR coalesce(v_department.department_status, 'active') = 'archived' THEN
      RAISE EXCEPTION 'The destination department is not active';
    END IF;

    IF v_department.branch_id IS NOT NULL
       AND v_department.branch_id IS DISTINCT FROM v_asset.branch_id THEN
      RAISE EXCEPTION 'The destination department belongs to another property';
    END IF;

    v_department_key := coalesce(
      nullif(btrim(coalesce(v_department.catalogue_key, '')), ''),
      public.neo_department_catalogue_key(v_department.name),
      lower(btrim(v_department.name))
    );
  END IF;

  -- A custodian always requires a destination department.
  IF _new_custodian IS NOT NULL THEN
    IF _new_department_id IS NULL THEN
      RAISE EXCEPTION 'Select the destination department before assigning a custodian';
    END IF;

    -- Canonical existing worker validator:
    -- active profile + employee + exact property + department + active role.
    PERFORM public.neo_assert_worker_scope(
      _new_custodian,
      v_asset.branch_id,
      v_department_key
    );
  END IF;

  -- Updating the asset invokes neo_validate_asset_custody as a second,
  -- table-level line of defence.
  UPDATE public.assets
     SET location_label = _new_location,
         department_id = _new_department_id,
         custodian_id = _new_custodian,
         updated_at = now()
   WHERE id = v_asset.id;

  INSERT INTO public.asset_movements (
    organization_id,
    asset_id,
    movement_type,
    previous_location,
    new_location,
    previous_custodian,
    new_custodian,
    previous_department_id,
    new_department_id,
    reason,
    performed_by
  )
  VALUES (
    v_org,
    v_asset.id,
    v_type,
    v_asset.location_label,
    _new_location,
    v_asset.custodian_id,
    _new_custodian,
    v_asset.department_id,
    _new_department_id,
    v_reason,
    v_actor
  )
  RETURNING id INTO v_movement;

  RETURN jsonb_build_object(
    'ok', true,
    'asset_id', v_asset.id,
    'movement_id', v_movement,
    'branch_id', v_asset.branch_id,
    'department_id', _new_department_id,
    'custodian_id', _new_custodian,
    'location_label', _new_location
  );
END
$function$;


REVOKE ALL
ON FUNCTION public.neo_asset_move(uuid, text, uuid, uuid, text, text)
FROM PUBLIC, anon;

GRANT EXECUTE
ON FUNCTION public.neo_asset_move(uuid, text, uuid, uuid, text, text)
TO authenticated, service_role;


NOTIFY pgrst, 'reload schema';