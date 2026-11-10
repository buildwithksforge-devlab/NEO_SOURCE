CREATE OR REPLACE FUNCTION public.neo_kitchen_route_order_item(_order_item uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _r record;
BEGIN
  SELECT oi.organization_id AS org, o.branch_id AS branch, oi.menu_item_id AS menu_item,
         mi.category_id AS category, o.order_type AS order_type, oi.station_id AS persisted
    INTO _r
  FROM public.pos_order_items oi
  JOIN public.pos_orders o ON o.id = oi.order_id
  LEFT JOIN public.menu_items mi ON mi.id = oi.menu_item_id
  WHERE oi.id = _order_item;

  IF _r IS NULL THEN
    RETURN jsonb_build_object('station_id', NULL, 'source', 'missing-order-item', 'missing', true);
  END IF;

  RETURN public.neo_kitchen_resolve_station(_r.org, _r.branch, _r.menu_item, _r.category, _r.order_type, _r.persisted);
END $function$
