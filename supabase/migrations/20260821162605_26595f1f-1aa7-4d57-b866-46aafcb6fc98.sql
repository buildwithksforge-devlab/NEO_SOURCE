CREATE OR REPLACE FUNCTION public.neo_integrity_repair(
  _org uuid DEFAULT NULL, _apply boolean DEFAULT true
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _rooms_bad int := 0; _rooms_fixed int := 0;
  _items_bad int := 0; _items_fixed int := 0;
  _scope uuid := _org;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    _scope := coalesce(_scope, public.current_org_id());
    IF _scope IS DISTINCT FROM public.current_org_id() OR NOT public.is_org_admin() THEN
      RAISE EXCEPTION 'Not authorised to run the integrity repair for this organisation.';
    END IF;
  END IF;

  SELECT count(*) INTO _rooms_bad FROM public.rooms r
   WHERE (_scope IS NULL OR r.organization_id = _scope)
     AND r.sellable IS DISTINCT FROM public.neo_room_is_sellable(
           r.housekeeping_status, r.maintenance_status, r.occupancy_status, r.status);

  SELECT count(*) INTO _items_bad FROM public.pos_order_items i
   WHERE i.station_id IS NULL AND (_scope IS NULL OR i.organization_id = _scope);

  IF _apply THEN
    WITH fixed AS (
      UPDATE public.rooms r SET updated_at = now()
       WHERE (_scope IS NULL OR r.organization_id = _scope)
         AND r.sellable IS DISTINCT FROM public.neo_room_is_sellable(
               r.housekeeping_status, r.maintenance_status, r.occupancy_status, r.status)
      RETURNING 1
    ) SELECT count(*) INTO _rooms_fixed FROM fixed;

    WITH candidate AS (
      SELECT i.id,
             public.neo_resolve_item_station(i.organization_id, o.branch_id, i.menu_item_id, o.order_type) AS station
        FROM public.pos_order_items i
        JOIN public.pos_orders o ON o.id = i.order_id
       WHERE i.station_id IS NULL
         AND (_scope IS NULL OR i.organization_id = _scope)
    ), fixed AS (
      UPDATE public.pos_order_items i SET station_id = c.station
        FROM candidate c
       WHERE c.id = i.id AND c.station IS NOT NULL
      RETURNING 1
    ) SELECT count(*) INTO _items_fixed FROM fixed;
  END IF;

  RETURN jsonb_build_object(
    'organization_id', _scope,
    'applied', _apply,
    'checked_at', now(),
    'rooms_invalid_sellable', _rooms_bad,
    'rooms_repaired', _rooms_fixed,
    'order_items_unrouted', _items_bad,
    'order_items_routed', _items_fixed,
    'order_items_still_unrouted', greatest(_items_bad - _items_fixed, 0)
  );
END $$;

REVOKE ALL ON FUNCTION public.neo_pos_item_station() FROM PUBLIC, anon;