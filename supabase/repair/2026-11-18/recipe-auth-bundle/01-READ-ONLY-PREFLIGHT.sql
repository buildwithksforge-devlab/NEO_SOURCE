-- Read only. Run in the existing managed project's SQL editor before installation.
SELECT to_regprocedure('public.neo_recipe_sheet_save(jsonb,jsonb,uuid)') AS atomic_save,
       to_regprocedure('public.neo_recipe_activate(uuid,uuid)') AS atomic_approval,
       to_regclass('public.neo_recipe_sheet_attempts') AS retry_history;

-- Installing the unique-active-version guard must not silently remove history.
SELECT organization_id,menu_item_id,count(*) AS active_versions,array_agg(id) AS recipe_ids
FROM public.recipes WHERE status='active' AND menu_item_id IS NOT NULL
GROUP BY organization_id,menu_item_id HAVING count(*)>1;

SELECT r.id,r.name,r.branch_id,r.menu_item_id,r.output_stock_item_id,
       s.name AS mapped_stock_name,m.stock_item_id AS menu_stock_item_id
FROM public.recipes r LEFT JOIN public.stock_items s ON s.id=r.output_stock_item_id
LEFT JOIN public.menu_items m ON m.id=r.menu_item_id
WHERE r.status='active' AND r.recipe_type='direct_sale'
  AND (r.output_stock_item_id IS NULL OR s.id IS NULL OR s.organization_id<>r.organization_id
       OR (s.branch_id IS NOT NULL AND s.branch_id IS DISTINCT FROM r.branch_id)
       OR m.stock_item_id IS DISTINCT FROM r.output_stock_item_id);

SELECT p.oid::regprocedure AS routine,p.prosecdef,pg_get_functiondef(p.oid) AS definition
FROM pg_proc p WHERE p.oid IN (
  to_regprocedure('public.neo_recipe_sheet_save(jsonb,jsonb,uuid)'),
  to_regprocedure('public.neo_recipe_activate(uuid,uuid)'));

-- Review actual sale quantities/units separately from output IDs. A matching
-- stock ID alone does not establish correct depletion or a valid conversion.
SELECT r.id,r.name,r.yield_quantity,r.yield_unit,
       s.id AS stock_item_id,s.base_unit,
       m.id AS menu_item_id,m.consumption_mode,
       m.stock_quantity_per_sale,m.stock_unit
FROM public.recipes r
LEFT JOIN public.stock_items s ON s.id=r.output_stock_item_id
LEFT JOIN public.menu_items m ON m.id=r.menu_item_id
WHERE r.status='active' AND r.recipe_type='direct_sale'
ORDER BY r.organization_id,r.name,r.id;
