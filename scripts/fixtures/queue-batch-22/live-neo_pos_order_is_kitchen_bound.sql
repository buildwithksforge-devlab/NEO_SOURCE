CREATE OR REPLACE FUNCTION public.neo_pos_order_is_kitchen_bound(_order uuid, _org uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.pos_order_items oi
     WHERE oi.order_id = _order
       AND oi.organization_id = _org
       AND oi.held = false
       AND coalesce(oi.status,'draft') NOT IN ('cancelled','voided')
  );
$function$
