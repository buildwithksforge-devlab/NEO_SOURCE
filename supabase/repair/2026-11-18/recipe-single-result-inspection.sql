-- READ ONLY. One result preserves every check when the editor exports only
-- its last result set. No recipes, stock, passwords or permissions are changed.
SELECT jsonb_build_object(
  'atomic_save',to_regprocedure('public.neo_recipe_sheet_save(jsonb,jsonb,uuid)')::text,
  'atomic_approval',to_regprocedure('public.neo_recipe_activate(uuid,uuid)')::text,
  'retry_history',to_regclass('public.neo_recipe_sheet_attempts')::text,
  'routines',coalesce((SELECT jsonb_agg(jsonb_build_object(
    'signature',p.oid::regprocedure::text,'argument_names',p.proargnames,
    'security_definer',p.prosecdef,
    'staff_execute',has_function_privilege('authenticated',p.oid,'EXECUTE'),
    'anonymous_execute',has_function_privilege('anon',p.oid,'EXECUTE'),
    'definition',pg_get_functiondef(p.oid)))
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('neo_recipe_sheet_save','neo_recipe_activate')),'[]'::jsonb),
  'duplicate_active_menu_versions',coalesce((SELECT jsonb_agg(to_jsonb(d)) FROM (
    SELECT organization_id,menu_item_id,count(*) AS active_versions,array_agg(id) AS recipe_ids
    FROM public.recipes WHERE status='active' AND menu_item_id IS NOT NULL
    GROUP BY organization_id,menu_item_id HAVING count(*)>1
  ) d),'[]'::jsonb),
  'direct_sale_review',coalesce((SELECT jsonb_agg(to_jsonb(d)) FROM (
    SELECT r.id,r.name,r.organization_id,r.branch_id,r.menu_item_id,r.output_stock_item_id,
      s.organization_id AS stock_organization_id,s.branch_id AS stock_branch_id,
      s.name AS stock_name,s.base_unit,r.yield_quantity,r.yield_unit,
      m.organization_id AS menu_organization_id,m.stock_item_id AS menu_stock_item_id,
      m.consumption_mode,m.stock_quantity_per_sale,m.stock_unit,
      (s.id IS NULL) AS missing_stock,
      (s.organization_id IS DISTINCT FROM r.organization_id) AS stock_organization_mismatch,
      (s.branch_id IS NOT NULL AND s.branch_id IS DISTINCT FROM r.branch_id) AS stock_branch_mismatch,
      (m.id IS NULL) AS missing_menu,
      (m.organization_id IS DISTINCT FROM r.organization_id) AS menu_organization_mismatch,
      (m.stock_item_id IS DISTINCT FROM r.output_stock_item_id) AS menu_stock_mismatch
    FROM public.recipes r
    LEFT JOIN public.stock_items s ON s.id=r.output_stock_item_id
    LEFT JOIN public.menu_items m ON m.id=r.menu_item_id
    WHERE r.status='active' AND r.recipe_type='direct_sale'
    ORDER BY r.organization_id,r.name,r.id
  ) d),'[]'::jsonb)
) AS recipe_repair_inspection;
