-- The public signup wizard previously kept the workspace draft only in the
-- creator's browser. Verifying the confirmation e-mail on another device left
-- no provisioning attempt anywhere, so the creator was told an administrator
-- must finish their workspace. The draft now also travels with the account
-- itself (auth user metadata), so the creator can always finish their own
-- workspace. Ownership is still proven by the signed-in account.

CREATE OR REPLACE FUNCTION public.neo_signup_workspace_draft()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN auth.uid() IS NULL THEN NULL
    ELSE (
      SELECT CASE
        WHEN jsonb_typeof(u.raw_user_meta_data -> 'workspace_draft') = 'object'
             AND coalesce(trim(u.raw_user_meta_data -> 'workspace_draft' ->> 'business_name'), '') <> ''
        THEN u.raw_user_meta_data -> 'workspace_draft'
        ELSE NULL END
        FROM auth.users u WHERE u.id = auth.uid())
  END;
$function$;

REVOKE ALL ON FUNCTION public.neo_signup_workspace_draft() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_signup_workspace_draft() TO authenticated, service_role;

-- Recoverability now covers both evidence paths: a recorded attempt, or the
-- signup draft carried by the creator's own account.
CREATE OR REPLACE FUNCTION public.neo_creator_workspace_recoverable()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT auth.uid() IS NOT NULL AND (
    EXISTS (
      SELECT 1 FROM public.workspace_provisioning_attempts a
       WHERE a.user_id = auth.uid()
         AND coalesce(a.payload->>'admin_role_key', 'owner') = 'owner')
    OR (
      public.neo_signup_workspace_draft() IS NOT NULL
      -- Never for somebody who already belongs to a workspace they did not create.
      AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = auth.uid())
      AND NOT EXISTS (
        SELECT 1 FROM public.profiles p
         WHERE p.id = auth.uid()
           AND p.organization_id IS NOT NULL
           AND p.created_by IS DISTINCT FROM auth.uid())
    ));
$function$;

-- Registers the signup draft as a creator-bound attempt exactly once.
CREATE OR REPLACE FUNCTION public.neo_claim_signup_workspace()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  caller uuid := auth.uid();
  draft jsonb;
  attempt_id uuid;
  claim_email text;
  key text;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '42501';
  END IF;

  SELECT a.id INTO attempt_id
    FROM public.workspace_provisioning_attempts a
   WHERE a.user_id = caller
   ORDER BY a.created_at DESC LIMIT 1;
  IF attempt_id IS NOT NULL THEN RETURN attempt_id; END IF;

  draft := public.neo_signup_workspace_draft();
  IF draft IS NULL THEN RETURN NULL; END IF;

  IF EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = caller)
     OR EXISTS (SELECT 1 FROM public.profiles p
                 WHERE p.id = caller AND p.organization_id IS NOT NULL
                   AND p.created_by IS DISTINCT FROM caller) THEN
    RAISE EXCEPTION 'An existing workspace member cannot create an Owner workspace' USING ERRCODE = '42501';
  END IF;

  SELECT lower(u.email) INTO claim_email FROM auth.users u WHERE u.id = caller;
  key := 'signup::' || caller::text;

  INSERT INTO public.workspace_provisioning_attempts
    (idempotency_key, email, user_id, payload, current_step, status)
  VALUES (key, claim_email, caller,
          draft || jsonb_build_object('admin_role_key', 'owner'),
          'registered', 'pending')
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO attempt_id;

  IF attempt_id IS NULL THEN
    SELECT a.id INTO attempt_id FROM public.workspace_provisioning_attempts a
     WHERE a.idempotency_key = key AND a.user_id = caller;
  END IF;
  RETURN attempt_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_claim_signup_workspace() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_claim_signup_workspace() TO authenticated, service_role;

-- Recovery claims the signup draft first, so the creator never needs the
-- original browser to finish the workspace they created.
CREATE OR REPLACE FUNCTION public.neo_recover_my_workspace()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '42501'; END IF;
  PERFORM public.neo_claim_signup_workspace();
  PERFORM public.neo_assert_creator_workspace_recovery(auth.uid());
  RETURN public.neo_finalize_creator_workspace(auth.uid());
END;
$function$;

CREATE OR REPLACE FUNCTION public.neo_workspace_link_status()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'user_id', auth.uid(),
    'has_profile', EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid()),
    'attempt_recorded', EXISTS (SELECT 1 FROM public.workspace_provisioning_attempts a WHERE a.user_id = auth.uid())
      OR public.neo_signup_workspace_draft() IS NOT NULL,
    'recoverable', public.neo_creator_workspace_recoverable(),
    'candidate_workspaces', (SELECT count(*) FROM public.workspace_provisioning_attempts a WHERE a.user_id = auth.uid()));
$function$;