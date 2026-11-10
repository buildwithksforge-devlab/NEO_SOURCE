CREATE OR REPLACE FUNCTION public.neo_menu_validation_states(_branch uuid DEFAULT NULL::uuid)
 RETURNS TABLE(item_id uuid, branch_id uuid, name text, state text, issues text[])
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT mi.*
      FROM public.menu_items mi
     WHERE mi.organization_id = public.current_org_id()
       AND (_branch IS NULL OR mi.branch_id IS NULL OR mi.branch_id = _branch)
  ), flagged AS (
    SELECT s.id,
           s.branch_id,
           s.name,
           ARRAY_REMOVE(ARRAY[
             CASE WHEN s.station_id IS NULL THEN 'missing-station' END,
             CASE WHEN s.category_id IS NULL THEN 'missing-category' END,
             CASE WHEN COALESCE(s.image_url, '') = '' THEN 'missing-image' END,
             CASE WHEN NOT EXISTS (
               SELECT 1 FROM public.recipes r
                WHERE r.menu_item_id = s.id
                  AND r.status IN ('active', 'approved')
             ) THEN 'missing-recipe' END,
             CASE WHEN EXISTS (
               SELECT 1 FROM public.recipes r
                WHERE r.menu_item_id = s.id
                  AND r.status IN ('active', 'approved')
                  AND NOT EXISTS (SELECT 1 FROM public.recipe_ingredients ri WHERE ri.recipe_id = r.id)
             ) THEN 'incomplete-recipe' END,
             CASE WHEN s.base_price <= 0 THEN 'missing-price' END,
             CASE WHEN s.publish_status = 'draft' THEN 'draft' END
           ], NULL) AS issues
      FROM scoped s
  )
  SELECT f.id,
         f.branch_id,
         f.name,
         CASE
           WHEN CARDINALITY(f.issues) = 0 THEN 'ready'
           WHEN 'draft' = ANY(f.issues) THEN 'draft'
           WHEN 'missing-price' = ANY(f.issues) THEN 'invalid-relationship'
           WHEN 'missing-station' = ANY(f.issues) OR 'missing-category' = ANY(f.issues) THEN 'missing-mapping'
           WHEN 'missing-recipe' = ANY(f.issues) OR 'incomplete-recipe' = ANY(f.issues) THEN 'missing-recipe'
           ELSE 'missing-image'
         END,
         f.issues
    FROM flagged f;
$function$
