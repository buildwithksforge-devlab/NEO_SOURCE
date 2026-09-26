CREATE OR REPLACE FUNCTION public.neo_guest_cart_update(_cart uuid, _patch jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  _c public.carts;
  _fulfilment text;
  _address uuid;
  _zone uuid;
  _scheduled timestamptz;
  _z public.delivery_zones;
  _local time;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF _patch IS NULL OR jsonb_typeof(_patch) <> 'object' THEN RAISE EXCEPTION 'Invalid cart update'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(_patch) k
              WHERE k NOT IN ('fulfilment_type','address_id','zone_id','notes','scheduled_for')) THEN
    RAISE EXCEPTION 'Unsupported cart field';
  END IF;
  SELECT * INTO _c FROM public.carts
  WHERE id = _cart AND status = 'active' AND customer_id = public.my_customer_id();
  IF _c.id IS NULL THEN RAISE EXCEPTION 'Cart not found'; END IF;

  IF _patch ? 'fulfilment_type' THEN
    _fulfilment := nullif(_patch->>'fulfilment_type','');
    IF _fulfilment NOT IN ('room-service','pickup','delivery') THEN RAISE EXCEPTION 'Unsupported fulfilment type'; END IF;
  ELSE
    _fulfilment := _c.fulfilment_type;
  END IF;

  IF _patch ? 'address_id' THEN
    _address := nullif(_patch->>'address_id','')::uuid;
    IF _address IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.customer_addresses a
      WHERE a.id = _address AND a.customer_id = _c.customer_id AND a.organization_id = _c.organization_id
    ) THEN RAISE EXCEPTION 'Address not available'; END IF;
  ELSE
    _address := _c.address_id;
  END IF;

  IF _patch ? 'zone_id' THEN
    _zone := nullif(_patch->>'zone_id','')::uuid;
    IF _zone IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.delivery_zones z
      WHERE z.id = _zone AND z.organization_id = _c.organization_id AND z.active
        AND (z.branch_id IS NULL OR _c.branch_id IS NULL OR z.branch_id = _c.branch_id)
    ) THEN RAISE EXCEPTION 'Delivery zone not available'; END IF;
  ELSE
    _zone := _c.zone_id;
  END IF;

  IF _patch ? 'scheduled_for' THEN
    _scheduled := nullif(_patch->>'scheduled_for','')::timestamptz;
    IF _scheduled IS NOT NULL THEN
      IF _scheduled <= now() THEN
        RAISE EXCEPTION 'Choose a time in the future';
      END IF;
      IF _scheduled > now() + interval '14 days' THEN
        RAISE EXCEPTION 'Orders can be scheduled up to 14 days ahead';
      END IF;
      IF _fulfilment = 'delivery' AND _zone IS NOT NULL THEN
        SELECT * INTO _z FROM public.delivery_zones WHERE id = _zone AND active;
        _local := (_scheduled AT TIME ZONE current_setting('TimeZone'))::time;
        IF _z.id IS NOT NULL AND _local NOT BETWEEN _z.service_start AND _z.service_end THEN
          RAISE EXCEPTION 'That time is outside the delivery hours for this zone (% to %)',
            to_char(_z.service_start, 'HH24:MI'), to_char(_z.service_end, 'HH24:MI');
        END IF;
      END IF;
    END IF;
  ELSE
    _scheduled := _c.scheduled_for;
  END IF;

  UPDATE public.carts
  SET fulfilment_type = _fulfilment,
      address_id = _address,
      zone_id = _zone,
      scheduled_for = _scheduled,
      notes = CASE WHEN _patch ? 'notes' THEN nullif(btrim(coalesce(_patch->>'notes','')), '') ELSE notes END,
      updated_at = now()
  WHERE id = _c.id;
  RETURN jsonb_build_object('ok', true, 'cart_id', _c.id, 'scheduled_for', _scheduled);
END
$function$;