-- Weekly stores report: item group -> category -> stock item, with the
-- property's own on-hand balance, the reorder rule that actually applies to
-- that property, and the purchase requests already in flight for the item.
CREATE OR REPLACE FUNCTION public.neo_inventory_weekly_report(_branch uuid DEFAULT NULL)
RETURNS TABLE (
  group_id uuid,
  group_name text,
  category_id uuid,
  category_name text,
  item_id uuid,
  item_name text,
  sku text,
  base_unit text,
  branch_id uuid,
  branch_name text,
  on_hand numeric,
  reorder_point numeric,
  par_level numeric,
  below_reorder boolean,
  pending_request_quantity numeric,
  pending_request_count integer
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH scope AS (
    SELECT b.id, b.name
      FROM branches b
     WHERE b.organization_id = current_org_id()
       AND (_branch IS NULL OR b.id = _branch)
  ),
  balances AS (
    SELECT sl.stock_item_id, loc.branch_id, sum(coalesce(sl.quantity_on_hand, 0)) AS on_hand
      FROM stock_levels sl
      JOIN stock_locations loc ON loc.id = sl.location_id
     WHERE loc.organization_id = current_org_id()
     GROUP BY 1, 2
  ),
  pending AS (
    SELECT prl.stock_item_id, pr.branch_id,
           sum(coalesce(prl.quantity, 0)) AS qty,
           count(DISTINCT pr.id)::int AS cnt
      FROM purchase_request_lines prl
      JOIN purchase_requests pr ON pr.id = prl.request_id
     WHERE pr.organization_id = current_org_id()
       AND pr.status NOT IN ('cancelled', 'rejected', 'closed', 'completed')
     GROUP BY 1, 2
  )
  SELECT g.id, g.name,
         c.id, c.name,
         i.id, i.name, i.sku, i.base_unit,
         s.id, s.name,
         coalesce(bal.on_hand, 0),
         coalesce(t.reorder_point, i.reorder_point),
         coalesce(t.par_level, i.par_level),
         coalesce(t.reorder_point, i.reorder_point) IS NOT NULL
           AND coalesce(bal.on_hand, 0) <= coalesce(t.reorder_point, i.reorder_point),
         coalesce(p.qty, 0),
         coalesce(p.cnt, 0)
    FROM stock_items i
    CROSS JOIN scope s
    LEFT JOIN stock_categories c ON c.id = i.category_id
    LEFT JOIN stock_item_groups g ON g.id = c.group_id
    LEFT JOIN balances bal ON bal.stock_item_id = i.id AND bal.branch_id = s.id
    LEFT JOIN stock_branch_thresholds t ON t.stock_item_id = i.id AND t.branch_id = s.id
    LEFT JOIN pending p ON p.stock_item_id = i.id AND p.branch_id = s.id
   WHERE i.organization_id = current_org_id()
     AND coalesce(i.active, true)
     AND (i.branch_id IS NULL OR i.branch_id = s.id)
   ORDER BY g.name NULLS LAST, c.name NULLS LAST, i.name;
$$;

REVOKE ALL ON FUNCTION public.neo_inventory_weekly_report(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_inventory_weekly_report(uuid) TO authenticated;