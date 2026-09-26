
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
  _no_baseline int := 0;
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
    SELECT sl.id, sl.stock_item_id, sl.location_id, sl.opening_balance,
           coalesce(sl.quantity_on_hand, 0) AS stored
      FROM public.stock_levels sl
      JOIN public.stock_locations loc ON loc.id = sl.location_id
     WHERE sl.organization_id = _org
       AND (_branch IS NULL OR loc.branch_id = _branch)
       AND public.neo_branch_in_scope(loc.branch_id)
  ), ledger AS (
    -- The balance a store should hold: its recorded opening balance plus every
    -- movement recorded since. A line with no recorded opening balance has no
    -- baseline to rebuild from, so it is reported and left untouched.
    SELECT s.id, s.stored,
           CASE WHEN s.opening_balance IS NULL THEN NULL
                ELSE s.opening_balance + coalesce((
                  SELECT sum(m.quantity) FROM public.stock_movements m
                   WHERE m.organization_id = _org
                     AND m.stock_item_id = s.stock_item_id
                     AND m.location_id = s.location_id
                     AND m.movement_type <> 'opening'), 0)
           END AS derived
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
    INTO _checked, _no_baseline, _changed, _detail;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, action, module, record_id, new_value)
  VALUES (_org, _branch, auth.uid(), 'inventory.levels.recalculated', 'inventory',
          coalesce(_branch::text, 'all-properties'),
          jsonb_build_object('checked', _checked, 'corrected', _changed,
                             'without_baseline', _no_baseline, 'changes', _detail));

  RETURN jsonb_build_object(
    'ok', true,
    'checked', _checked,
    'corrected', _changed,
    'without_ledger', _no_baseline,
    'changes', _detail,
    'recalculated_at', now());
END $function$;

REVOKE ALL ON FUNCTION public.neo_stock_recalculate_levels(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_stock_recalculate_levels(uuid) TO authenticated, service_role;
