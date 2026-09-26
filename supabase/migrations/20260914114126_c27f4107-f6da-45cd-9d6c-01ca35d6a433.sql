
-- Live stock per store, read as the signed-in user (RLS applies through the views it reads).
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
           coalesce(i.minimum_stock, 0) AS minimum_stock,
           coalesce(i.standard_cost, 0) AS unit_cost,
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

-- Rebuilds each store balance from the movement ledger.
CREATE OR REPLACE FUNCTION public.neo_stock_recalculate_levels(_branch uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _changed int := 0;
  _checked int := 0;
  _no_ledger int := 0;
  _detail jsonb := '[]'::jsonb;
BEGIN
  IF _org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.has_permission('inventory','stock.manage') OR public.is_org_admin()) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_permitted',
      'detail', 'Recalculating stock needs permission to manage stock.');
  END IF;
  IF _branch IS NOT NULL AND NOT public.neo_branch_in_scope(_branch) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_permitted');
  END IF;

  WITH scoped AS (
    SELECT sl.id, sl.stock_item_id, sl.location_id, coalesce(sl.quantity_on_hand, 0) AS stored
      FROM public.stock_levels sl
      JOIN public.stock_locations loc ON loc.id = sl.location_id
     WHERE sl.organization_id = _org
       AND (_branch IS NULL OR loc.branch_id = _branch)
       AND public.neo_branch_in_scope(loc.branch_id)
  ), ledger AS (
    SELECT s.id, s.stored,
           (SELECT sum(m.quantity) FROM public.stock_movements m
             WHERE m.organization_id = _org
               AND m.stock_item_id = s.stock_item_id
               AND m.location_id = s.location_id) AS derived
      FROM scoped s
  ), applied AS (
    UPDATE public.stock_levels sl
       SET quantity_on_hand = round(l.derived, 4),
           last_movement_at = coalesce(
             (SELECT max(m.created_at) FROM public.stock_movements m
               WHERE m.organization_id = _org
                 AND m.stock_item_id = sl.stock_item_id
                 AND m.location_id = sl.location_id),
             sl.last_movement_at),
           updated_at = now()
      FROM ledger l
     WHERE sl.id = l.id
       AND l.derived IS NOT NULL
       AND round(l.derived, 4) IS DISTINCT FROM round(l.stored, 4)
    RETURNING sl.id, sl.stock_item_id, sl.location_id, l.stored AS was, sl.quantity_on_hand AS now_is
  )
  SELECT (SELECT count(*) FROM ledger),
         (SELECT count(*) FROM ledger WHERE derived IS NULL),
         (SELECT count(*) FROM applied),
         coalesce((SELECT jsonb_agg(jsonb_build_object(
                     'stock_item_id', a.stock_item_id,
                     'location_id', a.location_id,
                     'was', a.was,
                     'now', a.now_is)) FROM applied a), '[]'::jsonb)
    INTO _checked, _no_ledger, _changed, _detail;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, action, module, record_id, new_value)
  VALUES (_org, _branch, auth.uid(), 'inventory.levels.recalculated', 'inventory',
          coalesce(_branch::text, 'all-properties'),
          jsonb_build_object('checked', _checked, 'corrected', _changed,
                             'without_ledger', _no_ledger, 'changes', _detail));

  RETURN jsonb_build_object(
    'ok', true,
    'checked', _checked,
    'corrected', _changed,
    'without_ledger', _no_ledger,
    'changes', _detail,
    'recalculated_at', now());
END $function$;

REVOKE ALL ON FUNCTION public.neo_stock_recalculate_levels(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_stock_recalculate_levels(uuid) TO authenticated, service_role;
