-- NEO P1.6A - MANUAL PAYMENT VERIFICATION RESPONSE
-- LOCAL DRAFT - NOT DEPLOYED
--
-- Verification evidence is not financial settlement.
-- Existing payment balances and journal posting remain unchanged.
CREATE OR REPLACE FUNCTION public.neo_payment_attempt_verify(_attempt uuid, _note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE a public.payment_attempts; org uuid;
BEGIN
  org := public.current_org_id();
  SELECT * INTO a FROM public.payment_attempts WHERE id = _attempt AND organization_id = org;
  IF a.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF NOT (public.is_org_admin_for(org) OR public.has_permission('finance','approve')) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;
  IF NOT a.manual_tender THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_manual',
      'detail', 'Only a manually recorded tender is verified by a person; a provider confirms its own payments.');
  END IF;
  IF a.verified_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_verified', 'verified_at', a.verified_at);
  END IF;

  UPDATE public.payment_attempts
     SET verified_by = auth.uid(), verified_at = now(), verification_note = _note, updated_at = now()
   WHERE id = _attempt;

  INSERT INTO public.payment_attempt_events (organization_id, attempt_id, from_state, to_state, detail, actor_id)
  VALUES (org, _attempt, a.state, a.state, coalesce(_note, 'Manual tender verified'), auth.uid());

  RETURN jsonb_build_object(
  'ok', true,
  'verified_at', now(),
  'verification_recorded', true,
  'payment_settled', false,
  'detail',
    'Manual verification recorded. Finance payment settlement must be confirmed separately.'
);
END;
$$;


REVOKE ALL ON FUNCTION public.neo_payment_attempt_verify(uuid, text)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.neo_payment_attempt_verify(uuid, text)
TO authenticated;
