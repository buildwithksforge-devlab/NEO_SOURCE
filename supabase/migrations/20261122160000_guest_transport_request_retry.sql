ALTER TABLE public.transport_requests ADD COLUMN IF NOT EXISTS guest_request_key uuid;

CREATE UNIQUE INDEX IF NOT EXISTS transport_requests_guest_request_key
ON public.transport_requests (organization_id, branch_id, customer_id, guest_request_key)
WHERE guest_request_key IS NOT NULL;

CREATE OR REPLACE FUNCTION public.neo_guest_request_transport(
  _org uuid, _branch uuid, _product uuid, _pickup_at timestamptz, _pickup_point text, _destination text,
  _passengers integer, _luggage integer, _travel_reference text, _notes text, _request_key uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  _customer uuid;
  _existing public.transport_requests;
  _saved jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  IF _request_key IS NULL THEN RAISE EXCEPTION 'Transfer request key is required'; END IF;

  SELECT id INTO _customer FROM public.customers
  WHERE auth_user_id = auth.uid() AND organization_id = _org AND merged_into_id IS NULL
  LIMIT 1;
  IF _customer IS NULL THEN RAISE EXCEPTION 'No guest account for this property' USING ERRCODE = '42501'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws(':', 'guest-transfer', _org, _branch, _customer, _request_key), 0));
  SELECT * INTO _existing FROM public.transport_requests
  WHERE organization_id = _org AND branch_id = _branch AND customer_id = _customer AND guest_request_key = _request_key;
  IF FOUND THEN
    RETURN jsonb_build_object('id', _existing.id, 'request_number', _existing.request_number,
      'status', _existing.status, 'quoted_amount', _existing.quoted_amount);
  END IF;

  _saved := public.neo_guest_request_transport(_org, _branch, _product, _pickup_at, _pickup_point,
    _destination, _passengers, _luggage, _travel_reference, _notes);
  UPDATE public.transport_requests SET guest_request_key = _request_key
  WHERE id = (_saved->>'id')::uuid AND organization_id = _org AND branch_id = _branch AND customer_id = _customer;
  IF NOT FOUND THEN RAISE EXCEPTION 'Could not confirm the saved transfer reference'; END IF;
  RETURN _saved;
END $function$;

REVOKE ALL ON FUNCTION public.neo_guest_request_transport(uuid,uuid,uuid,timestamptz,text,text,integer,integer,text,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_guest_request_transport(uuid,uuid,uuid,timestamptz,text,text,integer,integer,text,text,uuid) TO authenticated, service_role;
