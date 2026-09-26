CREATE OR REPLACE FUNCTION public.neo_guest_cart_set_quantity(
  _line uuid,
  _quantity numeric
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _cart uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT ci.cart_id INTO _cart
  FROM public.cart_items ci
  JOIN public.carts c ON c.id = ci.cart_id
  WHERE ci.id = _line
    AND c.status = 'active'
    AND c.customer_id = public.my_customer_id();
  IF _cart IS NULL THEN RAISE EXCEPTION 'Cart line not found'; END IF;
  IF coalesce(_quantity, 0) <= 0 THEN
    DELETE FROM public.cart_items WHERE id = _line AND cart_id = _cart;
    RETURN jsonb_build_object('ok', true, 'removed', true);
  END IF;
  IF _quantity > 50 THEN RAISE EXCEPTION 'Invalid quantity'; END IF;
  UPDATE public.cart_items SET quantity = _quantity, updated_at = now()
  WHERE id = _line AND cart_id = _cart;
  RETURN jsonb_build_object('ok', true, 'removed', false, 'quantity', _quantity);
END
$function$;

CREATE OR REPLACE FUNCTION public.neo_guest_cart_update(
  _cart uuid,
  _patch jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _c public.carts;
  _fulfilment text;
  _address uuid;
  _zone uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF _patch IS NULL OR jsonb_typeof(_patch) <> 'object' THEN RAISE EXCEPTION 'Invalid cart update'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(_patch) k WHERE k NOT IN ('fulfilment_type','address_id','zone_id','notes')) THEN
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

  UPDATE public.carts
  SET fulfilment_type = _fulfilment,
      address_id = _address,
      zone_id = _zone,
      notes = CASE WHEN _patch ? 'notes' THEN nullif(btrim(coalesce(_patch->>'notes','')), '') ELSE notes END,
      updated_at = now()
  WHERE id = _c.id;
  RETURN jsonb_build_object('ok', true, 'cart_id', _c.id);
END
$function$;

CREATE OR REPLACE FUNCTION public.neo_guest_toggle_favourite(
  _org uuid,
  _menu_item uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _cust uuid;
  _existing uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT id INTO _cust FROM public.customers
  WHERE organization_id = _org AND auth_user_id = auth.uid() AND merged_into_id IS NULL LIMIT 1;
  IF _cust IS NULL THEN RAISE EXCEPTION 'No guest profile for this property'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.menu_items WHERE id = _menu_item AND organization_id = _org) THEN
    RAISE EXCEPTION 'Menu item not found';
  END IF;
  SELECT id INTO _existing FROM public.customer_favourites
  WHERE organization_id = _org AND customer_id = _cust AND menu_item_id = _menu_item;
  IF _existing IS NOT NULL THEN
    DELETE FROM public.customer_favourites WHERE id = _existing AND customer_id = _cust;
    RETURN jsonb_build_object('saved', false, 'id', _existing);
  END IF;
  INSERT INTO public.customer_favourites (organization_id, customer_id, menu_item_id)
  VALUES (_org, _cust, _menu_item)
  RETURNING id INTO _existing;
  RETURN jsonb_build_object('saved', true, 'id', _existing);
END
$function$;

REVOKE ALL ON FUNCTION public.neo_guest_cart_set_quantity(uuid, numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_guest_cart_update(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_guest_toggle_favourite(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_guest_cart_set_quantity(uuid, numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_guest_cart_update(uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_guest_toggle_favourite(uuid, uuid) TO authenticated, service_role;