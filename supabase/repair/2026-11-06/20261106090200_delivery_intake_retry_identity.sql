-- Wave 1 delivery intake: retries share one committed business identity.
-- Existing intake validation, pricing, routing and PIN issuance stay in their owning RPC.
BEGIN;
ALTER TABLE public.delivery_orders
  ADD COLUMN IF NOT EXISTS intake_idempotency_key text,
  ADD COLUMN IF NOT EXISTS intake_request_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS delivery_orders_intake_identity_idx
  ON public.delivery_orders(organization_id, branch_id, intake_idempotency_key)
  WHERE intake_idempotency_key IS NOT NULL;

CREATE OR REPLACE FUNCTION public.neo_delivery_staff_place_order_once(
  _idempotency_key text,
  _branch uuid,
  _contact_name text,
  _contact_phone text,
  _items jsonb,
  _fulfilment text DEFAULT 'delivery',
  _zone uuid DEFAULT NULL,
  _address jsonb DEFAULT '{}'::jsonb,
  _payment_method text DEFAULT 'cash',
  _notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_org uuid := public.current_org_id();
  v_key text := nullif(btrim(_idempotency_key), '');
  v_hash text;
  v_existing public.delivery_orders;
  v_result jsonb;
  v_id uuid;
BEGIN
  PERFORM public.neo_assert_capability('delivery','orders','create-assisted');
  IF v_org IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.branches WHERE id = _branch AND organization_id = v_org
  ) THEN
    RAISE EXCEPTION 'Property not found in this workspace';
  END IF;
  IF NOT public.neo_branch_in_scope(_branch) THEN
    RAISE EXCEPTION 'Property is outside your access scope' USING ERRCODE='42501';
  END IF;
  IF v_key IS NULL OR length(v_key) > 200 THEN
    RAISE EXCEPTION 'A delivery intake identity of 1 to 200 characters is required';
  END IF;
  v_hash := md5(jsonb_build_object(
    'name', _contact_name, 'phone', _contact_phone, 'items', _items,
    'fulfilment', _fulfilment, 'zone', _zone, 'address', _address,
    'payment_method', _payment_method, 'notes', _notes
  )::text);
  PERFORM pg_advisory_xact_lock(hashtextextended(v_org::text || ':' || _branch::text || ':' || v_key, 0));
  SELECT * INTO v_existing FROM public.delivery_orders
    WHERE organization_id = v_org AND branch_id = _branch AND intake_idempotency_key = v_key;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.intake_request_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'This intake identity already belongs to a different order. Open the saved order before starting another.';
    END IF;
    RETURN jsonb_build_object(
      'delivery_order_id',v_existing.id, 'pos_order_id',v_existing.pos_order_id,
      'order_number',v_existing.order_number, 'customer_id',v_existing.customer_id,
      'pin_issued',true, 'delivery_fee',v_existing.delivery_fee,
      'grand_total',v_existing.grand_total, 'eta_minutes',v_existing.estimated_prep_minutes,
      'order_status',v_existing.order_status, 'idempotent',true
    );
  END IF;
  v_result := public.neo_delivery_staff_place_order(
    _branch,_contact_name,_contact_phone,_items,_fulfilment,_zone,_address,_payment_method,_notes
  );
  IF v_result IS NULL OR v_result->>'ok' = 'false'
     OR nullif(v_result->>'delivery_order_id','') IS NULL THEN
    RAISE EXCEPTION 'The delivery intake was not saved';
  END IF;
  v_id := (v_result->>'delivery_order_id')::uuid;
  UPDATE public.delivery_orders
    SET intake_idempotency_key=v_key, intake_request_hash=v_hash
    WHERE id=v_id AND organization_id=v_org AND branch_id=_branch;
  IF NOT FOUND THEN RAISE EXCEPTION 'The delivery intake has no matching saved order'; END IF;
  RETURN v_result || jsonb_build_object('idempotent',false);
END
$function$;
REVOKE ALL ON FUNCTION public.neo_delivery_staff_place_order_once(text,uuid,text,text,jsonb,text,uuid,jsonb,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_delivery_staff_place_order_once(text,uuid,text,text,jsonb,text,uuid,jsonb,text,text) TO authenticated;
COMMIT;
