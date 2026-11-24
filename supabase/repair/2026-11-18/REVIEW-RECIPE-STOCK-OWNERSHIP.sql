-- READ ONLY. This does not clone inventory, transfer ownership or guess links.
-- A name/SKU match is a review candidate, not proof of the correct physical stock.
SELECT jsonb_build_object('mapping_review',coalesce(jsonb_agg(to_jsonb(review)),'[]'::jsonb)) AS result
FROM (
  SELECT r.id AS recipe_id,r.name AS recipe_name,r.organization_id,r.branch_id,
    r.menu_item_id,r.output_stock_item_id AS current_recipe_stock_id,
    original.name AS current_recipe_stock_name,
    original.organization_id AS current_recipe_stock_owner,
    original.sku AS current_recipe_stock_sku,
    m.stock_item_id AS current_menu_stock_id,
    menu_stock.organization_id AS current_menu_stock_owner,
    (r.organization_id IS DISTINCT FROM original.organization_id) AS foreign_recipe_stock,
    (m.stock_item_id IS DISTINCT FROM r.output_stock_item_id) AS recipe_menu_disagree,
    (SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id',candidate.id,'name',candidate.name,'sku',candidate.sku,
      'branch_id',candidate.branch_id,'base_unit',candidate.base_unit)), '[]'::jsonb)
     FROM public.stock_items candidate
     WHERE candidate.organization_id=r.organization_id
       AND (candidate.branch_id IS NULL OR candidate.branch_id=r.branch_id)
       AND (
         (nullif(btrim(original.sku),'') IS NOT NULL AND lower(btrim(candidate.sku))=lower(btrim(original.sku)))
         OR lower(btrim(candidate.name))=lower(btrim(original.name))
         OR candidate.id=m.stock_item_id
       )) AS in_scope_candidates
  FROM public.recipes r
  LEFT JOIN public.stock_items original ON original.id=r.output_stock_item_id
  LEFT JOIN public.menu_items m ON m.id=r.menu_item_id
  LEFT JOIN public.stock_items menu_stock ON menu_stock.id=m.stock_item_id
  WHERE r.status='active' AND r.recipe_type='direct_sale'
    AND (original.id IS NULL OR original.organization_id IS DISTINCT FROM r.organization_id
      OR (original.branch_id IS NOT NULL AND original.branch_id IS DISTINCT FROM r.branch_id)
      OR m.stock_item_id IS DISTINCT FROM r.output_stock_item_id)
  ORDER BY r.organization_id,r.name,r.id
) review;
