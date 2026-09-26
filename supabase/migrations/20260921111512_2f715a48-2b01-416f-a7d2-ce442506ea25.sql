
CREATE TABLE IF NOT EXISTS public.neo_stay_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  reservation_id uuid NOT NULL REFERENCES public.reservations(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  auth_user_id uuid NOT NULL,
  method text NOT NULL DEFAULT 'reference_and_detail',
  verified_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS neo_stay_verification_unique
  ON public.neo_stay_verifications (reservation_id, auth_user_id);
CREATE INDEX IF NOT EXISTS neo_stay_verification_user
  ON public.neo_stay_verifications (auth_user_id, organization_id);

GRANT SELECT ON public.neo_stay_verifications TO authenticated;
GRANT ALL ON public.neo_stay_verifications TO service_role;

ALTER TABLE public.neo_stay_verifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY neo_stay_verification_read_own ON public.neo_stay_verifications
  FOR SELECT TO authenticated
  USING (auth_user_id = auth.uid() OR organization_id = public.current_org_id());

CREATE TRIGGER neo_stay_verification_touch
  BEFORE UPDATE ON public.neo_stay_verifications
  FOR EACH ROW EXECUTE FUNCTION public.neo_touch_updated_at();

-- Prove a booking belongs to the signed-in customer.
CREATE OR REPLACE FUNCTION public.neo_guest_verify_stay(_org uuid, _reference text, _detail text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _uid uuid := auth.uid();
  _me public.customers%ROWTYPE;
  _res public.reservations%ROWTYPE;
  _owner public.customers%ROWTYPE;
  _detail text := lower(btrim(_detail));
  _recent integer;
BEGIN
  IF _uid IS NULL THEN RETURN jsonb_build_object('verified', false, 'reason', 'not_signed_in'); END IF;
  IF _reference IS NULL OR btrim(_reference) = '' OR _detail = '' THEN
    RETURN jsonb_build_object('verified', false, 'reason', 'incomplete');
  END IF;

  SELECT * INTO _me FROM public.customers
  WHERE auth_user_id = _uid AND organization_id = _org LIMIT 1;
  IF _me.id IS NULL THEN RETURN jsonb_build_object('verified', false, 'reason', 'no_customer_record'); END IF;

  -- Simple abuse ceiling: no more than 10 successful links an hour per person.
  SELECT count(*) INTO _recent FROM public.neo_stay_verifications
  WHERE auth_user_id = _uid AND verified_at > now() - interval '1 hour';
  IF _recent >= 10 THEN RETURN jsonb_build_object('verified', false, 'reason', 'too_many_attempts'); END IF;

  SELECT * INTO _res FROM public.reservations
  WHERE organization_id = _org
    AND upper(btrim(confirmation_number)) = upper(btrim(_reference))
  LIMIT 1;
  IF _res.id IS NULL THEN RETURN jsonb_build_object('verified', false, 'reason', 'no_match'); END IF;

  SELECT * INTO _owner FROM public.customers WHERE id = _res.customer_id;
  IF _owner.id IS NULL THEN RETURN jsonb_build_object('verified', false, 'reason', 'no_match'); END IF;

  -- The supplied detail must match something already recorded on the booking.
  IF NOT (
    lower(COALESCE(_owner.full_name, '')) LIKE '%' || _detail || '%'
    OR lower(COALESCE(_owner.email, '')) = _detail
    OR regexp_replace(COALESCE(_owner.phone, ''), '\D', '', 'g') =
       regexp_replace(_detail, '\D', '', 'g')
    OR (length(regexp_replace(_detail, '\D', '', 'g')) >= 4
        AND right(regexp_replace(COALESCE(_owner.phone, ''), '\D', '', 'g'), 4) =
            right(regexp_replace(_detail, '\D', '', 'g'), 4))
  ) THEN
    RETURN jsonb_build_object('verified', false, 'reason', 'no_match');
  END IF;

  INSERT INTO public.neo_stay_verifications (
    organization_id, branch_id, reservation_id, customer_id, auth_user_id, method
  ) VALUES (_org, _res.branch_id, _res.id, _me.id, _uid, 'reference_and_detail')
  ON CONFLICT (reservation_id, auth_user_id) DO UPDATE
    SET revoked_at = NULL, verified_at = now();

  RETURN jsonb_build_object(
    'verified', true,
    'reservation_id', _res.id,
    'confirmation_number', _res.confirmation_number
  );
END;
$$;

REVOKE ALL ON FUNCTION public.neo_guest_verify_stay(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_guest_verify_stay(uuid, text, text) TO authenticated, service_role;

-- The signed-in customer's own stays: their own bookings plus verified links.
CREATE OR REPLACE FUNCTION public.neo_guest_my_stays(_org uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _uid uuid := auth.uid();
  _me uuid;
  _rows jsonb;
BEGIN
  IF _uid IS NULL THEN RETURN '[]'::jsonb; END IF;
  SELECT id INTO _me FROM public.customers WHERE auth_user_id = _uid AND organization_id = _org LIMIT 1;
  IF _me IS NULL THEN RETURN '[]'::jsonb; END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(t) ORDER BY t.arrival_date DESC), '[]'::jsonb) INTO _rows
  FROM (
    SELECT r.id, r.confirmation_number, r.status, r.arrival_date, r.departure_date,
           r.nights, r.adults, r.children, r.total_amount, r.balance, r.payment_status,
           rm.room_number, b.name AS property_name,
           (v.id IS NOT NULL) AS verified
    FROM public.reservations r
    LEFT JOIN public.rooms rm ON rm.id = r.room_id
    LEFT JOIN public.branches b ON b.id = r.branch_id
    LEFT JOIN public.neo_stay_verifications v
      ON v.reservation_id = r.id AND v.auth_user_id = _uid AND v.revoked_at IS NULL
    WHERE r.organization_id = _org
      AND (r.customer_id = _me OR v.id IS NOT NULL)
    ORDER BY r.arrival_date DESC
    LIMIT 25
  ) t;

  RETURN _rows;
END;
$$;

REVOKE ALL ON FUNCTION public.neo_guest_my_stays(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_guest_my_stays(uuid) TO authenticated, service_role;
