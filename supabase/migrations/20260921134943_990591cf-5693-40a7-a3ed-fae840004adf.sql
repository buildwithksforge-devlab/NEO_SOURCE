CREATE OR REPLACE FUNCTION public.neo_guest_payment_availability(_org uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _configured boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF _org IS NULL THEN
    RAISE EXCEPTION 'Property context required';
  END IF;

  -- Only a boolean is returned: no credentials, short codes or environment
  -- details ever leave the database for a guest.
  SELECT EXISTS (
    SELECT 1 FROM public.mpesa_settings s
    WHERE s.organization_id = _org
      AND coalesce(s.short_code, '') <> ''
  ) INTO _configured;

  RETURN jsonb_build_object(
    'available', _configured,
    'reason', CASE WHEN _configured THEN 'configured' ELSE 'not-configured' END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.neo_guest_payment_availability(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_guest_payment_availability(uuid) TO authenticated;