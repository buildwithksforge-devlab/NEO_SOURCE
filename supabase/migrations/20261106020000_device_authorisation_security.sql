-- Device authorisation and personal staff PIN administration.
-- No customer-specific identifiers or existing mapping rewrites.

DO $preflight$
BEGIN
  IF to_regclass('public.neo_staff_login_devices') IS NULL
     OR to_regclass('public.neo_production_staff_codes') IS NULL
     OR to_regclass('public.profiles') IS NULL
     OR to_regclass('public.user_roles') IS NULL
     OR to_regclass('public.roles') IS NULL
     OR to_regprocedure(
       'public.neo_staff_login_device_pair(uuid,text)'
     ) IS NULL
     OR to_regprocedure(
       'public.neo_staff_login_device_revoke(uuid)'
     ) IS NULL
     OR to_regprocedure(
       'public.neo_production_staff_pin(text,boolean)'
     ) IS NULL
     OR to_regprocedure(
       'public.neo_production_context(uuid)'
     ) IS NULL
     OR to_regprocedure(
       'public.neo_branch_in_scope(uuid)'
     ) IS NULL
     OR to_regprocedure(
       'public.log_audit_event(text,text,text,jsonb,jsonb,text,text,uuid,uuid,uuid,text,jsonb,text)'
     ) IS NULL
     OR to_regprocedure(
       'extensions.gen_random_bytes(integer)'
     ) IS NULL
     OR to_regprocedure(
       'extensions.digest(text,text)'
     ) IS NULL
  THEN
    RAISE EXCEPTION
      'Required staff-device, PIN, scope or audit backend is missing. No changes installed.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'roles'
      AND column_name = 'normalized_role_key'
  ) THEN
    RAISE EXCEPTION
      'Canonical role keys are missing. No changes installed.';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.neo_device_admin_allowed()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT
    auth.uid() IS NOT NULL
    AND public.is_active_staff()
    AND EXISTS (
      SELECT 1
      FROM public.user_roles ur
      JOIN public.roles r
        ON r.id = ur.role_id
       AND r.organization_id = ur.organization_id
      WHERE ur.user_id = auth.uid()
        AND ur.organization_id = public.current_org_id()
        AND COALESCE(r.active, true)
        AND COALESCE(r.role_status, 'active') <> 'archived'
        AND r.normalized_role_key IN (
          'owner',
          'it-system-administrator'
        )
    );
$function$;

REVOKE ALL
ON FUNCTION public.neo_device_admin_allowed()
FROM PUBLIC, anon;

GRANT EXECUTE
ON FUNCTION public.neo_device_admin_allowed()
TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_device_admin_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NOT public.neo_device_admin_allowed() THEN
    RAISE EXCEPTION
      'Only the Owner or System Administrator may authorise or revoke staff devices.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL
ON FUNCTION public.neo_device_admin_guard()
FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS neo_device_owner_guard
ON public.neo_staff_login_devices;

CREATE TRIGGER neo_device_owner_guard
BEFORE INSERT OR UPDATE OF revoked_at
ON public.neo_staff_login_devices
FOR EACH ROW
EXECUTE FUNCTION public.neo_device_admin_guard();

-- PIN attempt counters and last-used stamps do not invoke this trigger.

CREATE TABLE IF NOT EXISTS public.neo_device_activation_codes (
  code_hash text PRIMARY KEY,
  device_id uuid NOT NULL
    REFERENCES public.neo_staff_login_devices(id),
  payload jsonb NOT NULL,
  expires_at timestamptz NOT NULL
    DEFAULT (now() + interval '10 minutes'),
  claimed_at timestamptz
);

ALTER TABLE public.neo_device_activation_codes
ENABLE ROW LEVEL SECURITY;

REVOKE ALL
ON TABLE public.neo_device_activation_codes
FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.neo_device_activation_issue(
  _branch uuid,
  _label text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_org uuid := public.current_org_id();
  v_code text;
  v_token text;
  v_device uuid;
  v_property text;
  v_authorised_until timestamptz :=
    now() + interval '365 days';
  v_payload jsonb;
BEGIN
  IF NOT public.neo_device_admin_allowed() THEN
    RAISE EXCEPTION
      'Only the Owner or System Administrator may issue device activation.'
      USING ERRCODE = '42501';
  END IF;

  IF _branch IS NULL
     OR NOT COALESCE(
       public.neo_branch_in_scope(_branch),
       false
     )
  THEN
    RAISE EXCEPTION
      'Choose a property inside your authorised scope.'
      USING ERRCODE = '42501';
  END IF;

  SELECT b.name
  INTO v_property
  FROM public.branches b
  WHERE b.id = _branch
    AND b.organization_id = v_org;

  IF v_property IS NULL THEN
    RAISE EXCEPTION
      'The property does not belong to this workspace.'
      USING ERRCODE = '42501';
  END IF;

  IF char_length(btrim(COALESCE(_label, '')))
     NOT BETWEEN 2 AND 80
  THEN
    RAISE EXCEPTION
      'Enter a device name between 2 and 80 characters.'
      USING ERRCODE = '22023';
  END IF;

  -- Remove expired activation secrets.
  DELETE FROM public.neo_device_activation_codes
  WHERE expires_at <= now()
     OR claimed_at IS NOT NULL;

  v_token :=
    'neowd_' ||
    encode(extensions.gen_random_bytes(32), 'hex');

  INSERT INTO public.neo_staff_login_devices (
    organization_id,
    branch_id,
    label,
    token_hash,
    paired_by,
    expires_at
  )
  VALUES (
    v_org,
    _branch,
    btrim(_label),
    encode(extensions.digest(v_token, 'sha256'), 'hex'),
    auth.uid(),
    v_authorised_until
  )
  RETURNING id INTO v_device;

  v_payload := jsonb_build_object(
    'ok', true,
    'device_id', v_device,
    'device_token', v_token,
    'branch_id', _branch,
    'property_name', v_property,
    'label', btrim(_label),
    'expires_at', v_authorised_until
  );

  -- The transfer code is not the employee's six-digit PIN.
  v_code :=
    encode(extensions.gen_random_bytes(16), 'hex');

  INSERT INTO public.neo_device_activation_codes (
    code_hash,
    device_id,
    payload
  )
  VALUES (
    encode(extensions.digest(v_code, 'sha256'), 'hex'),
    v_device,
    v_payload
  );

  PERFORM public.log_audit_event(
    'staff_device_activation_issued',
    'administration',
    v_device::text,
    NULL,
    jsonb_build_object(
      'branch_id', _branch,
      'label', btrim(_label),
      'expires_at', v_authorised_until
    ),
    'Owner/System Administrator device authorisation',
    'administration.users.manage',
    _branch,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL
  );

  RETURN jsonb_build_object(
    'ok', true,
    'device_id', v_device,
    'code', v_code,
    'expires_at', now() + interval '10 minutes',
    'device_expires_at', v_authorised_until
  );
END;
$function$;

REVOKE ALL
ON FUNCTION public.neo_device_activation_issue(uuid,text)
FROM PUBLIC, anon;

GRANT EXECUTE
ON FUNCTION public.neo_device_activation_issue(uuid,text)
TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_device_activation_claim(
  _code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_activation public.neo_device_activation_codes;
  v_code text := lower(btrim(COALESCE(_code, '')));
BEGIN
  IF v_code !~ '^[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'Invalid activation code.';
  END IF;

  SELECT *
  INTO v_activation
  FROM public.neo_device_activation_codes
  WHERE code_hash =
    encode(extensions.digest(v_code, 'sha256'), 'hex')
  FOR UPDATE;

  IF v_activation.code_hash IS NULL
     OR v_activation.claimed_at IS NOT NULL
     OR v_activation.expires_at <= now()
  THEN
    RAISE EXCEPTION
      'Activation code expired, already used or unavailable.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.neo_staff_login_devices d
    WHERE d.id = v_activation.device_id
      AND d.revoked_at IS NULL
      AND d.expires_at > now()
  ) THEN
    RAISE EXCEPTION
      'Device authorisation expired or was revoked.';
  END IF;

  -- Locking plus consumption prevents concurrent reuse.
  -- The returned credential remains restricted to one property.
  UPDATE public.neo_device_activation_codes
  SET claimed_at = now(),
      payload = '{}'::jsonb
  WHERE code_hash = v_activation.code_hash;

  RETURN v_activation.payload;
END;
$function$;

REVOKE ALL
ON FUNCTION public.neo_device_activation_claim(text)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE
ON FUNCTION public.neo_device_activation_claim(text)
TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.neo_device_admin_list()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NOT public.neo_device_admin_allowed() THEN
    RAISE EXCEPTION
      'Owner or System Administrator access required.'
      USING ERRCODE = '42501';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'id', d.id,
        'label', d.label,
        'branch_id', d.branch_id,
        'property', b.name,
        'created_at', d.created_at,
        'expires_at', d.expires_at,
        'last_used_at', d.last_used_at,
        'revoked', d.revoked_at IS NOT NULL,
        'activated', EXISTS (
          SELECT 1
          FROM public.neo_device_activation_codes a
          WHERE a.device_id = d.id
            AND a.claimed_at IS NOT NULL
        )
      )
      ORDER BY d.created_at DESC
    )
    FROM public.neo_staff_login_devices d
    JOIN public.branches b
      ON b.id = d.branch_id
    WHERE d.organization_id = public.current_org_id()
      AND public.neo_branch_in_scope(d.branch_id)
  ), '[]'::jsonb);
END;
$function$;

REVOKE ALL
ON FUNCTION public.neo_device_admin_list()
FROM PUBLIC, anon;

GRANT EXECUTE
ON FUNCTION public.neo_device_admin_list()
TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_staff_pin_admin(
  _query text DEFAULT '',
  _user uuid DEFAULT NULL,
  _pin text DEFAULT NULL,
  _disable boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_org uuid := public.current_org_id();
  v_actor uuid := auth.uid();
  v_result jsonb;
  v_disable boolean := COALESCE(_disable, false);
  v_claims text :=
    current_setting('request.jwt.claims', true);
  v_sub text :=
    current_setting('request.jwt.claim.sub', true);
  v_role text :=
    current_setting('request.jwt.claim.role', true);
BEGIN
  IF NOT public.neo_device_admin_allowed() THEN
    RAISE EXCEPTION
      'Owner or System Administrator access required.'
      USING ERRCODE = '42501';
  END IF;

  IF _user IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.id = _user
        AND p.organization_id = v_org
        AND COALESCE(p.account_type, 'staff') = 'staff'
        AND COALESCE(p.account_status, 'active') = 'active'
    ) THEN
      RAISE EXCEPTION
        'Choose an active staff account in this workspace.'
        USING ERRCODE = '42501';
    END IF;

    IF NOT v_disable
       AND (
         _pin IS NULL
         OR _pin !~ '^[0-9]{6}$'
       )
    THEN
      RAISE EXCEPTION 'Use a six-digit personal PIN.';
    END IF;

    -- Reuse the existing uniqueness and hashing rules.
    PERFORM public.neo_production_context(_user);

    v_result :=
      public.neo_production_staff_pin(_pin, v_disable);

    -- Restore the actual administrator before auditing.
    PERFORM set_config(
      'request.jwt.claims',
      COALESCE(v_claims, ''),
      true
    );
    PERFORM set_config(
      'request.jwt.claim.sub',
      COALESCE(v_sub, ''),
      true
    );
    PERFORM set_config(
      'request.jwt.claim.role',
      COALESCE(v_role, ''),
      true
    );
    PERFORM public.neo_access_cache_bump();

    PERFORM public.log_audit_event(
      'staff_pin_admin_changed',
      'administration',
      _user::text,
      NULL,
      jsonb_build_object(
        'pin_set', NOT v_disable,
        'administrator_id', v_actor
      ),
      'Owner/System Administrator PIN management',
      'administration.users.manage',
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL
    );

    RETURN v_result;
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'id', p.id,
        'name', p.full_name,
        'email', p.email,
        'staff_id', p.staff_id,
        'pin_set', COALESCE(c.enabled, false)
      )
      ORDER BY p.full_name
    )
    FROM (
      SELECT id, full_name, email, staff_id
      FROM public.profiles
      WHERE organization_id = v_org
        AND COALESCE(account_type, 'staff') = 'staff'
        AND COALESCE(account_status, 'active') = 'active'
        AND (
          full_name ILIKE
            '%' || left(COALESCE(_query, ''), 100) || '%'
          OR email ILIKE
            '%' || left(COALESCE(_query, ''), 100) || '%'
          OR staff_id ILIKE
            '%' || left(COALESCE(_query, ''), 100) || '%'
        )
      ORDER BY full_name
      LIMIT 30
    ) p
    LEFT JOIN public.neo_production_staff_codes c
      ON c.user_id = p.id
     AND c.organization_id = v_org
  ), '[]'::jsonb);
END;
$function$;

REVOKE ALL
ON FUNCTION public.neo_staff_pin_admin(text,uuid,text,boolean)
FROM PUBLIC, anon;

GRANT EXECUTE
ON FUNCTION public.neo_staff_pin_admin(text,uuid,text,boolean)
TO authenticated;
