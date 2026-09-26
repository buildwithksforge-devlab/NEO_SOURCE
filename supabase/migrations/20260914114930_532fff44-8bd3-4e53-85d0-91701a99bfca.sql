
CREATE OR REPLACE FUNCTION public.neo_stock_live_board(_branch uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _stores jsonb; _totals jsonb;
BEGIN
  IF _org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF _branch IS NOT NULL AND NOT public.neo_branch_in_scope(_branch) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_permitted');
  END IF;

  WITH lines AS (
    SELECT sl.location_id,
           loc.name AS location_name,
           loc.location_type,
           loc.branch_id,
           sl.stock_item_id,
           i.name AS item_name,
           i.sku,
           i.base_unit,
           coalesce(sl.quantity_on_hand, 0) AS on_hand,
           coalesce(i.min_level, i.reorder_point, 0) AS minimum_stock,
           coalesce(i.average_cost, i.last_cost, 0) AS unit_cost,
           sl.last_movement_at
      FROM public.stock_levels sl
      JOIN public.stock_locations loc ON loc.id = sl.location_id
      JOIN public.stock_items i ON i.id = sl.stock_item_id
     WHERE sl.organization_id = _org
       AND (_branch IS NULL OR loc.branch_id = _branch)
       AND public.neo_branch_in_scope(loc.branch_id)
  )
  SELECT jsonb_agg(store ORDER BY store->>'location_name'), jsonb_build_object(
           'lines', coalesce(sum((store->>'lines')::int), 0),
           'value', coalesce(sum((store->>'value')::numeric), 0),
           'below_minimum', coalesce(sum((store->>'below_minimum')::int), 0),
           'out_of_stock', coalesce(sum((store->>'out_of_stock')::int), 0))
    INTO _stores, _totals
  FROM (
    SELECT jsonb_build_object(
             'location_id', location_id,
             'location_name', location_name,
             'location_type', location_type,
             'branch_id', branch_id,
             'lines', count(*),
             'value', round(sum(on_hand * unit_cost), 2),
             'below_minimum', count(*) FILTER (WHERE minimum_stock > 0 AND on_hand <= minimum_stock AND on_hand > 0),
             'out_of_stock', count(*) FILTER (WHERE on_hand <= 0),
             'last_movement_at', max(last_movement_at),
             'items', jsonb_agg(jsonb_build_object(
                        'stock_item_id', stock_item_id,
                        'name', item_name,
                        'sku', sku,
                        'unit', base_unit,
                        'on_hand', on_hand,
                        'minimum_stock', minimum_stock,
                        'value', round(on_hand * unit_cost, 2),
                        'last_movement_at', last_movement_at)
                      ORDER BY item_name)
           ) AS store
      FROM lines
     GROUP BY location_id, location_name, location_type, branch_id
  ) grouped;

  RETURN jsonb_build_object(
    'ok', true,
    'generated_at', now(),
    'branch_id', _branch,
    'stores', coalesce(_stores, '[]'::jsonb),
    'totals', coalesce(_totals, jsonb_build_object('lines', 0, 'value', 0, 'below_minimum', 0, 'out_of_stock', 0))
  );
END $function$;

REVOKE ALL ON FUNCTION public.neo_stock_live_board(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_stock_live_board(uuid) TO authenticated, service_role;
