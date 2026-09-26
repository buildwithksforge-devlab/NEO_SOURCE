CREATE OR REPLACE FUNCTION public.neo_assert_creator_workspace_recovery(_uid uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  a public.workspace_provisioning_attempts;
  profile_org uuid;
  profile_creator uuid;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '42501'; END IF;

  SELECT x.* INTO a FROM public.workspace_provisioning_attempts x
   WHERE x.user_id = _uid
   ORDER BY (x.status IN ('completed','complete')) ASC, x.created_at DESC
   LIMIT 1;
  IF a.id IS NULL THEN
    RAISE EXCEPTION 'No creator-bound workspace attempt exists for this account' USING ERRCODE = '42501';
  END IF;

  SELECT p.organization_id, p.created_by INTO profile_org, profile_creator
    FROM public.profiles p WHERE p.id = _uid;

  IF a.organization_id IS NOT NULL AND profile_org IS NOT NULL AND a.organization_id <> profile_org THEN
    RAISE EXCEPTION 'Workspace ownership evidence conflicts with the current membership' USING ERRCODE = '42501';
  END IF;

  IF a.organization_id IS NULL AND profile_org IS NOT NULL AND profile_creator IS DISTINCT FROM _uid THEN
    RAISE EXCEPTION 'An existing employee cannot convert their membership into workspace ownership' USING ERRCODE = '42501';
  END IF;

  IF profile_org IS NULL AND EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = _uid) THEN
    RAISE EXCEPTION 'Unanchored role assignments cannot establish workspace ownership' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.user_id = _uid
       AND ur.organization_id <> coalesce(a.organization_id, profile_org)
  ) THEN
    RAISE EXCEPTION 'Existing role assignments belong to another workspace' USING ERRCODE = '42501';
  END IF;
END;
$fn$;
REVOKE ALL ON FUNCTION public.neo_assert_creator_workspace_recovery(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_assert_creator_workspace_recovery(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.neo_reconcile_workspace()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '42501'; END IF;
  PERFORM public.neo_assert_creator_workspace_recovery(auth.uid());
  RETURN public.neo_finalize_creator_workspace(auth.uid());
END;
$fn$;
REVOKE ALL ON FUNCTION public.neo_reconcile_workspace() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_reconcile_workspace() TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_recover_my_workspace()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '42501'; END IF;
  PERFORM public.neo_assert_creator_workspace_recovery(auth.uid());
  RETURN public.neo_finalize_creator_workspace(auth.uid());
END;
$fn$;
REVOKE ALL ON FUNCTION public.neo_recover_my_workspace() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_recover_my_workspace() TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_register_workspace_attempt(_email text, _payload jsonb, _idempotency_key text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  attempt_id uuid;
  caller uuid := auth.uid();
  claim_email text;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'Authentication is required to register a workspace attempt' USING ERRCODE = '42501';
  END IF;
  IF coalesce(trim(_idempotency_key), '') = '' THEN RAISE EXCEPTION 'An idempotency key is required'; END IF;
  IF EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = caller AND p.organization_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = caller) THEN
    RAISE EXCEPTION 'An existing workspace member cannot create an Owner workspace' USING ERRCODE = '42501';
  END IF;

  SELECT lower(u.email) INTO claim_email FROM auth.users u WHERE u.id = caller;
  INSERT INTO public.workspace_provisioning_attempts
    (idempotency_key, email, user_id, payload, current_step, status)
  VALUES (_idempotency_key, claim_email, caller, coalesce(_payload, '{}'::jsonb) || jsonb_build_object('admin_role_key','owner'), 'registered', 'pending')
  ON CONFLICT (idempotency_key) DO UPDATE SET
    payload = CASE WHEN public.workspace_provisioning_attempts.status IN ('complete','completed')
      THEN public.workspace_provisioning_attempts.payload ELSE excluded.payload END,
    user_id = coalesce(public.workspace_provisioning_attempts.user_id, excluded.user_id),
    updated_at = now()
  WHERE public.workspace_provisioning_attempts.user_id IS NULL
     OR public.workspace_provisioning_attempts.user_id = caller
  RETURNING id INTO attempt_id;

  IF attempt_id IS NULL THEN
    RAISE EXCEPTION 'This onboarding attempt belongs to another account' USING ERRCODE = '42501';
  END IF;
  RETURN attempt_id;
END;
$fn$;
REVOKE ALL ON FUNCTION public.neo_register_workspace_attempt(text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_register_workspace_attempt(text, jsonb, text) TO authenticated;