CREATE OR REPLACE FUNCTION public.delivery_quote_cart(_cart uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _c public.carts; _s public.delivery_settings; _z public.delivery_zones;
  _sub numeric := 0; _tax numeric := 0; _mods numeric := 0;
  _fee numeric := 0; _disc numeric := 0; _promo public.promotion_codes;
  _issues text[] := '{}'; _lines jsonb := '[]'::jsonb; _uses int;
BEGIN
  SELECT * INTO _c FROM public.carts WHERE id = _cart;
  IF _c.id IS NULL OR _c.customer_id <> public.my_customer_id() THEN
    RAISE EXCEPTION 'Cart not found';
  END IF;
  _s := public.delivery_get_settings(_c.branch_id);

  SELECT
    coalesce(sum(ci.quantity * mi.base_price), 0),
    coalesce(sum(ci.quantity * mi.base_price * mi.tax_rate / 100), 0),
    coalesce(jsonb_agg(jsonb_build_object(
      'cart_item_id', ci.id, 'menu_item_id', mi.id, 'name', mi.name,
      'quantity', ci.quantity, 'unit_price', mi.base_price, 'tax_rate', mi.tax_rate,
      'station_id', mi.station_id, 'availability', mi.availability,
      'delivery_eligible', mi.available_delivery,
      'special_instructions', ci.special_instructions, 'allergy_note', ci.allergy_note
    ) ORDER BY ci.created_at), '[]'::jsonb)
  INTO _sub, _tax, _lines
  FROM public.cart_items ci JOIN public.menu_items mi ON mi.id = ci.menu_item_id
  WHERE ci.cart_id = _cart;

  SELECT coalesce(sum(cim.extra_charge * ci.quantity), 0) INTO _mods
  FROM public.cart_item_modifiers cim
  JOIN public.cart_items ci ON ci.id = cim.cart_item_id
  WHERE ci.cart_id = _cart;
  _sub := _sub + _mods;

  IF EXISTS (SELECT 1 FROM public.cart_items ci JOIN public.menu_items mi ON mi.id = ci.menu_item_id
             WHERE ci.cart_id = _cart
               AND (mi.availability <> 'available'
                 OR (_c.fulfilment_type = 'delivery' AND NOT mi.available_delivery)
                 OR (_c.fulfilment_type = 'pickup' AND NOT coalesce(mi.available_takeaway, false))
                 OR (_c.fulfilment_type = 'room-service' AND NOT coalesce(mi.available_room_service, false)))) THEN
    _issues := _issues || array['Some items are unavailable for this fulfilment type and must be removed.'];
  END IF;

  IF _c.fulfilment_type = 'room-service' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.reservations r
       WHERE r.customer_id = _c.customer_id
         AND r.organization_id = _c.organization_id
         AND r.status IN ('checked_in','in_house','checked-in')
    ) THEN
      _issues := _issues || array['Room service is available during an in-house stay only.'];
    END IF;
  END IF;

  IF _c.fulfilment_type = 'delivery' THEN
    SELECT * INTO _z FROM public.delivery_zones WHERE id = _c.zone_id AND active;
    IF _z.id IS NULL THEN
      _issues := _issues || array['Select a delivery address inside a served zone.'];
    ELSE
      _fee := _z.base_fee;
      IF _z.free_delivery_threshold IS NOT NULL AND _sub >= _z.free_delivery_threshold THEN _fee := 0; END IF;
      IF _sub < greatest(_z.min_order, coalesce(_s.min_order, 0)) THEN
        _issues := _issues || array[format('Minimum order for this zone is %s.', greatest(_z.min_order, coalesce(_s.min_order,0)))];
      END IF;
      IF localtime NOT BETWEEN _z.service_start AND _z.service_end AND _c.scheduled_for IS NULL THEN
        _issues := _issues || array['This zone is outside its service hours right now — schedule the order instead.'];
      END IF;
    END IF;
  ELSIF _c.fulfilment_type = 'pickup' AND coalesce(_s.pickup_enabled, true) = false THEN
    _issues := _issues || array['Pickup is not enabled for this branch.'];
  END IF;

  IF _c.promo_code IS NOT NULL AND length(trim(_c.promo_code)) > 0 THEN
    SELECT * INTO _promo FROM public.promotion_codes
    WHERE organization_id = _c.organization_id AND upper(code) = upper(trim(_c.promo_code))
      AND active AND approval_status = 'approved';
    IF _promo.id IS NULL THEN
      _issues := _issues || array['Promo code is not valid.'];
    ELSIF (_promo.starts_at IS NOT NULL AND now() < _promo.starts_at)
       OR (_promo.ends_at IS NOT NULL AND now() > _promo.ends_at) THEN
      _issues := _issues || array['Promo code is outside its validity period.'];
    ELSIF _sub < _promo.min_order THEN
      _issues := _issues || array['Order value is below the promo minimum.'];
    ELSE
      SELECT count(*) INTO _uses FROM public.promotion_redemptions
      WHERE promotion_id = _promo.id AND customer_id = _c.customer_id;
      IF _uses >= _promo.per_customer_limit THEN
        _issues := _issues || array['Promo usage limit reached for this customer.'];
      ELSIF _promo.total_usage_limit IS NOT NULL AND _promo.usage_count >= _promo.total_usage_limit THEN
        _issues := _issues || array['Promo code is fully redeemed.'];
      ELSE
        IF _promo.discount_type = 'percentage' THEN _disc := _sub * _promo.discount_value / 100;
        ELSIF _promo.discount_type = 'fixed' THEN _disc := _promo.discount_value;
        END IF;
        IF _promo.max_discount IS NOT NULL THEN _disc := least(_disc, _promo.max_discount); END IF;
        IF _promo.free_delivery OR _promo.discount_type = 'free-delivery' THEN _fee := 0; END IF;
        _disc := least(_disc, _sub);
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'cart_id', _c.id,
    'branch_id', _c.branch_id,
    'fulfilment_type', _c.fulfilment_type,
    'lines', _lines,
    'subtotal', round(_sub, 2),
    'tax_total', round(_tax, 2),
    'discount_total', round(_disc, 2),
    'delivery_fee', round(_fee, 2),
    'tip_amount', round(coalesce(_c.tip_amount, 0), 2),
    'grand_total', round(greatest(_sub + _tax + _fee + coalesce(_c.tip_amount,0) - _disc, 0), 2),
    'promotion_id', _promo.id,
    'zone_id', _z.id,
    'eta_minutes', coalesce(_z.eta_minutes, 45),
    'issues', to_jsonb(_issues),
    'can_checkout', (cardinality(_issues) = 0 AND jsonb_array_length(_lines) > 0)
  );
END; $function$;