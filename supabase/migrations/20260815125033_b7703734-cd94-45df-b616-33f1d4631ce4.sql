CREATE OR REPLACE FUNCTION public.customer_register_self(
  _org uuid,
  _branch uuid,
  _full_name text,
  _phone text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid uuid := auth.uid();
  _email text;
  _existing public.customers;
  _new public.customers;
  _number text;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = _org) THEN
    RAISE EXCEPTION 'Unknown workspace';
  END IF;

  IF _branch IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.branches b WHERE b.id = _branch AND b.organization_id = _org
  ) THEN
    _branch := NULL;
  END IF;

  SELECT * INTO _existing FROM public.customers c
   WHERE c.auth_user_id = _uid AND c.organization_id = _org
   LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object('customer_id', _existing.id, 'created', false);
  END IF;

  SELECT u.email INTO _email FROM auth.users u WHERE u.id = _uid;

  _number := 'C-' || to_char(now(), 'YYMM') || '-' || upper(substr(replace(_uid::text, '-', ''), 1, 6));

  INSERT INTO public.customers (
    organization_id, primary_branch_id, auth_user_id, customer_number,
    customer_type, full_name, phone, email, account_status, source
  ) VALUES (
    _org, _branch, _uid, _number,
    'individual-guest',
    COALESCE(NULLIF(btrim(_full_name), ''), split_part(COALESCE(_email, 'guest'), '@', 1)),
    NULLIF(btrim(_phone), ''),
    _email,
    'active',
    'self-registration'
  ) RETURNING * INTO _new;

  RETURN jsonb_build_object('customer_id', _new.id, 'created', true);
END;
$$;

REVOKE ALL ON FUNCTION public.customer_register_self(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.customer_register_self(uuid, uuid, text, text) TO authenticated, service_role;