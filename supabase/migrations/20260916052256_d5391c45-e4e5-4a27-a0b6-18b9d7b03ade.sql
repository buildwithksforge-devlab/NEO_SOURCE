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

  SELECT a.id INTO attempt_id
    FROM public.workspace_provisioning_attempts a
   WHERE a.idempotency_key = _idempotency_key AND a.user_id = caller;
  IF attempt_id IS NOT NULL THEN RETURN attempt_id; END IF;

  IF EXISTS (SELECT 1 FROM public.workspace_provisioning_attempts a WHERE a.idempotency_key = _idempotency_key) THEN
    RAISE EXCEPTION 'This onboarding attempt belongs to another account' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = caller AND p.organization_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = caller) THEN
    RAISE EXCEPTION 'An existing workspace member cannot create an Owner workspace' USING ERRCODE = '42501';
  END IF;

  SELECT lower(u.email) INTO claim_email FROM auth.users u WHERE u.id = caller;
  INSERT INTO public.workspace_provisioning_attempts
    (idempotency_key, email, user_id, payload, current_step, status)
  VALUES (_idempotency_key, claim_email, caller,
          coalesce(_payload, '{}'::jsonb) || jsonb_build_object('admin_role_key','owner'),
          'registered', 'pending')
  RETURNING id INTO attempt_id;
  RETURN attempt_id;
END;
$fn$;
REVOKE ALL ON FUNCTION public.neo_register_workspace_attempt(text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_register_workspace_attempt(text, jsonb, text) TO authenticated;

DO $do$
DECLARE source text; updated text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO source
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'neo_build_effective_access'
     AND pg_get_function_identity_arguments(p.oid) = '';
  updated := regexp_replace(source,
    'WHERE a\.user_id = ctx\.uid\s+OR lower\(a\.email\) = lower\(coalesce\(\(SELECT u\.email FROM auth\.users u WHERE u\.id = ctx\.uid\), ''''\)\)',
    'WHERE a.user_id = ctx.uid');
  IF updated = source THEN
    RAISE EXCEPTION 'Expected legacy email-based effective-access expression was not found';
  END IF;
  EXECUTE updated;
END;
$do$;