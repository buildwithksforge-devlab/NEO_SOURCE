CREATE OR REPLACE FUNCTION public.neo_register_workspace_attempt(_email text, _payload jsonb, _idempotency_key text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _id uuid;
  _uid uuid := auth.uid();
  _claim_email text;
BEGIN
  -- Provisioning drafts are authenticated-only and always bound to the
  -- verified caller. Anonymous callers and caller-supplied identities are
  -- rejected outright.
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'Authentication is required to register a workspace attempt'
      USING ERRCODE = '42501';
  END IF;

  IF coalesce(trim(_idempotency_key), '') = '' THEN
    RAISE EXCEPTION 'An idempotency key is required';
  END IF;

  SELECT lower(u.email) INTO _claim_email FROM auth.users u WHERE u.id = _uid;

  -- The email recorded is the verified account's own email, never the value
  -- supplied by the frontend.
  INSERT INTO public.workspace_provisioning_attempts
    (idempotency_key, email, user_id, payload, current_step, status)
  VALUES
    (_idempotency_key, coalesce(_claim_email, lower(trim(coalesce(_email, '')))), _uid,
     coalesce(_payload, '{}'::jsonb), 'registered', 'pending')
  ON CONFLICT (idempotency_key) DO UPDATE
    SET payload = CASE WHEN public.workspace_provisioning_attempts.status = 'complete'
                       THEN public.workspace_provisioning_attempts.payload
                       ELSE excluded.payload END,
        user_id = coalesce(public.workspace_provisioning_attempts.user_id, excluded.user_id),
        updated_at = now()
    WHERE public.workspace_provisioning_attempts.user_id IS NULL
       OR public.workspace_provisioning_attempts.user_id = _uid
  RETURNING id INTO _id;

  IF _id IS NULL THEN
    RAISE EXCEPTION 'This onboarding attempt belongs to another account'
      USING ERRCODE = '42501';
  END IF;

  RETURN _id;
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_register_workspace_attempt(text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_register_workspace_attempt(text, jsonb, text) TO authenticated;