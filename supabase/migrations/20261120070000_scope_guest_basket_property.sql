-- Preserve the active basket on a property switch. An empty basket can be reused.
BEGIN;
CREATE OR REPLACE FUNCTION public.neo_guest_cart_add_item(
  _org uuid, _fulfilment text, _menu_item uuid, _quantity numeric DEFAULT 1,
  _special_instructions text DEFAULT NULL, _allergy_note text DEFAULT NULL,
  _branch uuid DEFAULT NULL, _options uuid[] DEFAULT '{}')
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _cust uuid; _cart public.carts; _item public.menu_items; _line uuid; _target_branch uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF _fulfilment NOT IN ('room-service','pickup','delivery') THEN
    RAISE EXCEPTION 'Unsupported fulfilment type';
  END IF;
  IF coalesce(_quantity,0) <= 0 OR _quantity > 50 THEN RAISE EXCEPTION 'Invalid quantity'; END IF;

  SELECT id INTO _cust FROM public.customers
   WHERE organization_id = _org AND auth_user_id = auth.uid() AND merged_into_id IS NULL LIMIT 1;
  IF _cust IS NULL THEN RAISE EXCEPTION 'No guest profile for this property'; END IF;

  SELECT * INTO _item FROM public.menu_items
   WHERE id = _menu_item AND organization_id = _org AND availability = 'available';
  IF _item.id IS NULL THEN RAISE EXCEPTION 'Item is not available'; END IF;

  -- Serialize the first write and any property change for this customer's basket.
  PERFORM pg_advisory_xact_lock(hashtextextended(_cust::text, 72727));
  SELECT * INTO _cart FROM public.carts
   WHERE customer_id = _cust AND organization_id = _org AND status = 'active'
   FOR UPDATE;

  _target_branch := coalesce(_branch, _item.branch_id, _cart.branch_id);
  IF _target_branch IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.branches
     WHERE id = _target_branch AND organization_id = _org AND active IS DISTINCT FROM false
  ) THEN
    RAISE EXCEPTION 'Property is not available';
  END IF;
  IF _item.branch_id IS NOT NULL AND _item.branch_id IS DISTINCT FROM _target_branch THEN
    RAISE EXCEPTION 'Item is not available at this property';
  END IF;

  IF _cart.id IS NULL THEN
    INSERT INTO public.carts (organization_id, customer_id, branch_id, fulfilment_type)
    VALUES (_org, _cust, _target_branch, _fulfilment)
    RETURNING * INTO _cart;
  ELSIF _cart.branch_id IS DISTINCT FROM _target_branch THEN
    IF EXISTS (SELECT 1 FROM public.cart_items WHERE cart_id = _cart.id) THEN
      RAISE EXCEPTION 'Finish or clear the basket at the other property first';
    END IF;
    UPDATE public.carts
       SET branch_id = _target_branch, fulfilment_type = _fulfilment,
           address_id = NULL, zone_id = NULL, promo_code = NULL, scheduled_for = NULL,
           tip_amount = 0, notes = NULL
     WHERE id = _cart.id;
  ELSE
    UPDATE public.carts SET fulfilment_type = _fulfilment
     WHERE id = _cart.id AND fulfilment_type IS DISTINCT FROM _fulfilment;
  END IF;

  INSERT INTO public.cart_items (organization_id, cart_id, menu_item_id, quantity,
                                 special_instructions, allergy_note)
  VALUES (_org, _cart.id, _menu_item, _quantity,
          nullif(btrim(coalesce(_special_instructions,'')),''),
          nullif(btrim(coalesce(_allergy_note,'')),''))
  RETURNING id INTO _line;

  -- prices come from the published catalogue, never from the browser
  INSERT INTO public.cart_item_modifiers (organization_id, cart_item_id, group_id, option_id,
                                          group_name, option_name, extra_charge)
  SELECT _org, _line, g.id, o.id, g.name, o.name, o.extra_charge
  FROM public.modifier_options o
  JOIN public.modifier_groups g ON g.id = o.group_id
  JOIN public.menu_item_modifier_groups mig ON mig.group_id = g.id AND mig.menu_item_id = _menu_item
  WHERE o.id = ANY(coalesce(_options,'{}')) AND o.active AND g.active
    AND o.organization_id = _org;

  RETURN _line;
END $function$;
COMMIT;
