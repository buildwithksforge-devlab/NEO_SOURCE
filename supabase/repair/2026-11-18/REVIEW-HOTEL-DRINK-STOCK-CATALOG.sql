-- READ ONLY: package/variant evidence for the remaining ownership review.
-- Exact-name/SKU inspection found few candidates; this broader list still does
-- not establish interchangeability or authorize changing inventory ownership.
SELECT jsonb_build_object(
  'hotel_stock_candidates',coalesce((
    SELECT jsonb_agg(to_jsonb(s)) FROM (
      SELECT id,organization_id,branch_id,name,sku,base_unit,
        container_type,container_volume_ml
      FROM public.stock_items
      WHERE organization_id='c10e5d20-dc04-4959-9db4-4c2afb9d2f8c'
        AND (branch_id IS NULL OR branch_id='c6169bc5-2123-4f2e-a660-c2aa81b83df2')
        AND name ~* '(amarula|camino|captain|heineken|hennessy|jager|jäger|jameson|walker|cuervo|malibu|moet|moët|monkey|red.?bull|robertson|water|swartland|tusker|versus|beefeater)'
      ORDER BY name,id
    ) s),'[]'::jsonb),
  'affected_menu_items',coalesce((
    SELECT jsonb_agg(to_jsonb(m)) FROM (
      SELECT DISTINCT menu.id,menu.name,menu.stock_item_id,
        menu.stock_quantity_per_sale,menu.stock_unit
      FROM public.menu_items menu JOIN public.recipes recipe ON recipe.menu_item_id=menu.id
      LEFT JOIN public.stock_items stock ON stock.id=recipe.output_stock_item_id
      WHERE recipe.organization_id='c10e5d20-dc04-4959-9db4-4c2afb9d2f8c'
        AND recipe.branch_id='c6169bc5-2123-4f2e-a660-c2aa81b83df2'
        AND recipe.status='active' AND recipe.recipe_type='direct_sale'
        AND (stock.organization_id IS DISTINCT FROM recipe.organization_id
          OR menu.stock_item_id IS DISTINCT FROM recipe.output_stock_item_id)
      ORDER BY menu.name,menu.id
    ) m),'[]'::jsonb)
) AS hotel_drink_stock_review;
