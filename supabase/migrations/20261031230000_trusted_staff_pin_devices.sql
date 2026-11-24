-- NEØ trusted-property devices for personal staff PIN login.
--
-- A device token identifies an authorised property device, never an employee.
-- A personal six-digit PIN identifies the employee inside that device's
-- organisation. The employee's active status and property scope are checked
-- again under their own database identity before a login token may be issued.
--
-- Raw device tokens and PINs are never stored. This migration does not create
-- a staff session itself; only the service-role server endpoint may consume
-- the narrowly scoped resolver result.

BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure('public.can_manage_workforce()') IS NULL
    OR to_regprocedure('public.neo_branch_in_scope(uuid)') IS NULL
    OR to_regprocedure('public.neo_production_context(uuid)') IS NULL
    OR to_regprocedure('public.neo_access_cache_bump()') IS NULL
    OR to_regprocedure('public.is_active_staff()') IS NULL
    OR to_regprocedure('extensions.crypt(text,text)') IS NULL
    OR to_regprocedure('extensions.gen_random_bytes(integer)') IS NULL
    OR to_regclass('public.neo_production_staff_codes') IS NULL
    OR to_regclass('public.profiles') IS NULL
    OR to_regclass('public.branches') IS NULL
  THEN
    RAISE EXCEPTION
      'Trusted staff PIN devices require the existing workforce, scope and production PIN backend. No changes installed.';
  END IF;
END
$preflight$;

CREATE TABLE public.neo_staff_login_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  branch_id uuid NOT NULL REFERENCES public.branches(id),
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 2 AND 80),
  token_hash text NOT NULL UNIQUE
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  paired_by uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  revoked_at timestamptz,
  last_used_at timestamptz,
  failed_attempts integer NOT NULL DEFAULT 0
    CHECK (failed_attempts >= 0),
  attempt_window timestamptz NOT NULL DEFAULT now(),
  blocked_until timestamptz
);

CREATE INDEX neo_staff_login_devices_scope_idx
  ON public.neo_staff_login_devices (
    organization_id,
    branch_id,
    expires_at
  );

ALTER TABLE public.neo_staff_login_devices ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.neo_staff_login_devices
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.neo_staff_login_device_pair(
  _branch uuid,
  _label text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org uuid := public.current_org_id();
  v_branch_org uuid;
  v_branch_name text;
  v_token text;
  v_hash text;
  v_device public.neo_staff_login_devices;
BEGIN
  IF auth.uid() IS NULL
    OR v_org IS NULL
    OR NOT public.is_active_staff()
    OR NOT public.can_manage_workforce()
  THEN
    RAISE EXCEPTION
      'Workforce administration permission is required to authorise this device.'
      USING ERRCODE = '42501';
  END IF;

  IF _branch IS NULL OR NOT public.neo_branch_in_scope(_branch) THEN
    RAISE EXCEPTION
      'The selected property is outside your authorised scope.'
      USING ERRCODE = '42501';
  END IF;

  SELECT b.organization_id, b.name
    INTO v_branch_org, v_branch_name
    FROM public.branches b
   WHERE b.id = _branch;

  IF v_branch_org IS NULL OR v_branch_org IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION
      'The selected property is unavailable.'
      USING ERRCODE = '42501';
  END IF;

  IF char_length(btrim(coalesce(_label, ''))) NOT BETWEEN 2 AND 80 THEN
    RAISE EXCEPTION
      'Enter a device name between 2 and 80 characters.'
      USING ERRCODE = '22023';
  END IF;

  v_token :=
    'neowd_' || encode(extensions.gen_random_bytes(32), 'hex');

  v_hash :=
    encode(
      extensions.digest(convert_to(v_token, 'UTF8'), 'sha256'),
      'hex'
    );

  INSERT INTO public.neo_staff_login_devices (
    organization_id,
    branch_id,
    label,
    token_hash,
    paired_by
  )
  VALUES (
    v_org,
    _branch,
    btrim(_label),
    v_hash,
    auth.uid()
  )
  RETURNING *
    INTO v_device;

  RETURN jsonb_build_object(
    'ok', true,
    'device_id', v_device.id,
    'device_token', v_token,
    'branch_id', v_device.branch_id,
    'property_name', v_branch_name,
    'label', v_device.label,
    'expires_at', v_device.expires_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.neo_staff_login_device_pair(uuid, text)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.neo_staff_login_device_pair(uuid, text)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_staff_login_device_revoke(
  _device uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org uuid := public.current_org_id();
  v_device public.neo_staff_login_devices;
BEGIN
  IF auth.uid() IS NULL
    OR v_org IS NULL
    OR NOT public.is_active_staff()
    OR NOT public.can_manage_workforce()
  THEN
    RAISE EXCEPTION
      'Workforce administration permission is required to revoke this device.'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_device
    FROM public.neo_staff_login_devices d
   WHERE d.id = _device
     AND d.organization_id = v_org
   FOR UPDATE;

  IF v_device.id IS NULL
    OR NOT public.neo_branch_in_scope(v_device.branch_id)
  THEN
    RAISE EXCEPTION
      'The trusted device is unavailable in your scope.'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.neo_staff_login_devices
     SET revoked_at = coalesce(revoked_at, now()),
         token_hash = encode(
           extensions.digest(
             convert_to(
               token_hash || ':' || id::text || ':' || now()::text,
               'UTF8'
             ),
             'sha256'
           ),
           'hex'
         )
   WHERE id = v_device.id;

  RETURN jsonb_build_object(
    'ok', true,
    'device_id', v_device.id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.neo_staff_login_device_revoke(uuid)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.neo_staff_login_device_revoke(uuid)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_staff_login_device_resolve(
  _token_hash text,
  _pin text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_device public.neo_staff_login_devices;
  v_code public.neo_production_staff_codes;
  v_matches integer := 0;
  v_user uuid;
  v_allowed boolean := false;
  v_claims text := current_setting('request.jwt.claims', true);
  v_sub text := current_setting('request.jwt.claim.sub', true);
  v_role text := current_setting('request.jwt.claim.role', true);
BEGIN
  IF _token_hash IS NULL
    OR _token_hash !~ '^[0-9a-f]{64}$'
  THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'device',
      'message', 'This device is not authorised for staff PIN sign-in.'
    );
  END IF;

  SELECT *
    INTO v_device
    FROM public.neo_staff_login_devices d
   WHERE d.token_hash = _token_hash
   FOR UPDATE;

  IF v_device.id IS NULL
    OR v_device.revoked_at IS NOT NULL
    OR v_device.expires_at <= now()
  THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'device',
      'message', 'This device is not authorised for staff PIN sign-in.'
    );
  END IF;

  IF v_device.blocked_until > now() THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'locked',
      'message', 'Too many attempts. Ask an authorised supervisor for help.',
      'retry_at', v_device.blocked_until
    );
  END IF;

  IF v_device.attempt_window < now() - interval '15 minutes' THEN
    UPDATE public.neo_staff_login_devices
       SET failed_attempts = 0,
           blocked_until = NULL,
           attempt_window = now()
     WHERE id = v_device.id;

    v_device.failed_attempts := 0;
    v_device.attempt_window := now();
  END IF;

  IF _pin IS NOT NULL AND _pin ~ '^[0-9]{6}$' THEN
    SELECT
      count(*)::integer,
      (array_agg(c.user_id ORDER BY c.user_id))[1]
      INTO v_matches, v_user
      FROM public.neo_production_staff_codes c
     WHERE c.organization_id = v_device.organization_id
       AND c.enabled = true
       AND extensions.crypt(_pin, c.pin_hash) = c.pin_hash;
  END IF;

  IF v_matches <> 1 OR v_user IS NULL THEN
    UPDATE public.neo_staff_login_devices
       SET failed_attempts = v_device.failed_attempts + 1,
           attempt_window = v_device.attempt_window,
           blocked_until = CASE
             WHEN v_device.failed_attempts + 1 >= 5
             THEN now() + interval '15 minutes'
             ELSE NULL
           END
     WHERE id = v_device.id;

    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'credentials',
      'message', 'PIN not accepted. Check your PIN or ask your supervisor.'
    );
  END IF;

  SELECT *
    INTO v_code
    FROM public.neo_production_staff_codes c
   WHERE c.organization_id = v_device.organization_id
     AND c.user_id = v_user
   FOR UPDATE;

  IF v_code.blocked_until > now() THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'locked',
      'message', 'This PIN is temporarily locked. Ask your supervisor for help.',
      'retry_at', v_code.blocked_until
    );
  END IF;

  PERFORM public.neo_production_context(v_user);

  BEGIN
    v_allowed :=
      public.current_org_id() IS NOT DISTINCT FROM v_device.organization_id
      AND public.is_active_staff()
      AND public.neo_branch_in_scope(v_device.branch_id);
  EXCEPTION
    WHEN OTHERS THEN
      v_allowed := false;
  END;

  PERFORM set_config(
    'request.jwt.claims',
    coalesce(v_claims, ''),
    true
  );
  PERFORM set_config(
    'request.jwt.claim.sub',
    coalesce(v_sub, ''),
    true
  );
  PERFORM set_config(
    'request.jwt.claim.role',
    coalesce(v_role, ''),
    true
  );
  PERFORM public.neo_access_cache_bump();

  IF NOT v_allowed THEN
    UPDATE public.neo_staff_login_devices
       SET failed_attempts = v_device.failed_attempts + 1,
           attempt_window = v_device.attempt_window,
           blocked_until = CASE
             WHEN v_device.failed_attempts + 1 >= 5
             THEN now() + interval '15 minutes'
             ELSE NULL
           END
     WHERE id = v_device.id;

    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'scope',
      'message', 'Your staff account is not authorised for this property.'
    );
  END IF;

  UPDATE public.neo_staff_login_devices
     SET failed_attempts = 0,
         blocked_until = NULL,
         attempt_window = now(),
         last_used_at = now()
   WHERE id = v_device.id;

  UPDATE public.neo_production_staff_codes
     SET failed_attempts = 0,
         blocked_until = NULL
   WHERE organization_id = v_device.organization_id
     AND user_id = v_user;

  RETURN jsonb_build_object(
    'ok', true,
    'user_id', v_user,
    'branch_id', v_device.branch_id
  );

EXCEPTION
  WHEN OTHERS THEN
    PERFORM set_config(
      'request.jwt.claims',
      coalesce(v_claims, ''),
      true
    );
    PERFORM set_config(
      'request.jwt.claim.sub',
      coalesce(v_sub, ''),
      true
    );
    PERFORM set_config(
      'request.jwt.claim.role',
      coalesce(v_role, ''),
      true
    );
    PERFORM public.neo_access_cache_bump();
    RAISE;
END;
$$;

REVOKE ALL ON FUNCTION public.neo_staff_login_device_resolve(text, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.neo_staff_login_device_resolve(text, text)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;