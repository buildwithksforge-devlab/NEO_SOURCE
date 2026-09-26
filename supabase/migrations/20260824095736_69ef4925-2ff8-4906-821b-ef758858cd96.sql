CREATE OR REPLACE FUNCTION public.neo_public_menu(_org uuid, _branch uuid DEFAULT NULL, _fulfilment text DEFAULT 'delivery')
 RETURNS TABLE (
   id uuid, name text, description text, base_price numeric, tax_rate numeric,
   image_url text, prep_minutes integer, category_id uuid, category_name text,
   availability text, branch_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT mi.id, mi.name, mi.description, mi.base_price, mi.tax_rate, mi.image_url,
         mi.prep_minutes, mi.category_id, mc.name, mi.availability, mi.branch_id
  FROM public.menu_items mi
  LEFT JOIN public.menu_categories mc ON mc.id = mi.category_id
  WHERE mi.organization_id = _org
    AND (_branch IS NULL OR mi.branch_id IS NULL OR mi.branch_id = _branch)
    AND COALESCE(mi.publish_status, 'published') = 'published'
    AND mi.availability = 'available'
    AND (mi.active_from IS NULL OR mi.active_from <= current_date)
    AND (mi.active_to IS NULL OR mi.active_to >= current_date)
    AND CASE _fulfilment
          WHEN 'room-service' THEN COALESCE(mi.available_room_service, false)
          WHEN 'pickup' THEN COALESCE(mi.available_takeaway, false)
          ELSE COALESCE(mi.available_delivery, false)
        END
  ORDER BY mc.name NULLS LAST, mi.display_order, mi.name;
$function$;

REVOKE ALL ON FUNCTION public.neo_public_menu(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_public_menu(uuid, uuid, text) TO anon, authenticated;