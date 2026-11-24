BEGIN;

-- Keep the installed department/recipe calculations in one private routine.
-- The two API entry points below apply their own authorization before using it.
DO $install$
DECLARE
  body text;
  start_at integer;
  marker text := ' allow_negative:=public.neo_inventory_allows_negative(org,_branch);';
BEGIN
  SELECT prosrc INTO STRICT body FROM pg_proc
  WHERE oid = 'public.neo_pos_department_menu_availability(uuid,text)'::regprocedure
    AND prosecdef AND provolatile='s';
  start_at := strpos(body,marker);
  IF start_at=0 OR strpos(body,'Menu stock is outside your property or POS access')=0
      OR strpos(body,'recipe_expand_to_stock_kinds')=0
      OR strpos(body,'b.output_location_id')=0
      OR strpos(body,'neo_station_consumption_location')=0 THEN
    RAISE EXCEPTION 'Install the reviewed departmental batch and POS stock routine before the public menu stock update';
  END IF;
  EXECUTE $signature$
    CREATE FUNCTION public.neo_department_menu_stock(
      org uuid, _branch uuid, _channel text, _item uuid DEFAULT NULL, _quantity numeric DEFAULT 1
    )
    RETURNS TABLE(menu_item_id uuid, available boolean, reason text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp
    AS $core$
    DECLARE
      menu public.menu_items; recipe public.recipes;
      location uuid; store text; mode text; portions numeric; prepared numeric;
      components jsonb; missing text; allow_negative boolean;
    BEGIN
  $signature$ || replace(replace(replace(substring(body FROM start_at),
    'm.publish_status=''published''','m.publish_status=''published'' AND (_item IS NULL OR m.id=_item)'),
    'menu.stock_quantity_per_sale,','menu.stock_quantity_per_sale * _quantity,'),
    'portions:=1;','portions:=_quantity;') || '$core$';
END
$install$;
REVOKE ALL ON FUNCTION public.neo_department_menu_stock(uuid,uuid,text,uuid,numeric) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.neo_pos_department_menu_availability(_branch uuid, _channel text)
RETURNS TABLE(menu_item_id uuid, available boolean, reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp
AS $staff$
DECLARE org uuid:=public.current_org_id();
BEGIN
  IF auth.uid() IS NULL OR org IS NULL OR NOT coalesce(public.neo_branch_in_scope(_branch),false)
   OR NOT EXISTS(SELECT 1 FROM public.branches b WHERE b.id=_branch AND b.organization_id=org)
   OR NOT (coalesce(public.has_permission('pos','orders.create'),false)
       OR coalesce(public.has_permission('pos','orders.view'),false) OR coalesce(public.is_org_admin(),false)) THEN
    RAISE EXCEPTION 'Menu stock is outside your property or POS access' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT s.menu_item_id,s.available,s.reason
  FROM public.neo_department_menu_stock(org,_branch,_channel) s;
END;
$staff$;

CREATE FUNCTION public.neo_public_menu_with_stock(_org uuid, _branch uuid, _fulfilment text)
RETURNS TABLE(
  id uuid,name text,description text,base_price numeric,tax_rate numeric,image_url text,
  prep_minutes integer,category_id uuid,category_name text,availability text,branch_id uuid
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp
AS $menu$
  WITH property AS MATERIALIZED (
    SELECT b.id,b.organization_id,
      CASE _fulfilment WHEN 'pickup' THEN 'takeaway' ELSE _fulfilment END AS channel
    FROM public.branches b
    WHERE b.id=_branch AND b.organization_id=_org AND b.active IS TRUE
      AND public.neo_platform_tenant_active(b.organization_id)
      AND _fulfilment IN ('delivery','pickup','room-service')
      AND (
        EXISTS (
          SELECT 1 FROM public.neo_public_experience e
          CROSS JOIN LATERAL (SELECT public.neo_public_property(e.public_slug) AS p) publication
          WHERE e.branch_id=b.id AND e.organization_id=b.organization_id
            AND publication.p->>'branch_id'=b.id::text
            AND publication.p->>'publicly_listed'='true'
            AND publication.p#>>'{doors,stay_dine}' IS DISTINCT FROM 'false'
        ) OR (_fulfilment<>'room-service' AND EXISTS (
          SELECT 1 FROM public.public_workspaces w
          WHERE w.branch_id=b.id AND w.organization_id=b.organization_id
            AND w.app_key='delivery' AND w.published IS TRUE
        ))
      )
  ), shortages AS MATERIALIZED (
    SELECT s.menu_item_id FROM property p
    CROSS JOIN LATERAL public.neo_department_menu_stock(p.organization_id,p.id,p.channel) s
    WHERE s.available IS FALSE
  )
  SELECT m.id,m.name,m.description,m.base_price,m.tax_rate,m.image_url,
    m.prep_minutes,m.category_id,c.name,
    CASE WHEN s.menu_item_id IS NOT NULL THEN 'out-of-stock' ELSE m.availability END,
    m.branch_id
  FROM property p JOIN public.menu_items m
    ON m.organization_id=p.organization_id AND (m.branch_id IS NULL OR m.branch_id=p.id)
  LEFT JOIN public.menu_categories c ON c.id=m.category_id AND c.organization_id=p.organization_id
  LEFT JOIN shortages s ON s.menu_item_id=m.id
  WHERE m.publish_status='published' AND m.availability IN ('available','out-of-stock')
    AND (m.active_from IS NULL OR m.active_from<=current_date)
    AND (m.active_to IS NULL OR m.active_to>=current_date)
    AND CASE _fulfilment
      WHEN 'room-service' THEN m.available_room_service
      WHEN 'pickup' THEN m.available_takeaway
      WHEN 'delivery' THEN m.available_delivery
    END
  ORDER BY c.name NULLS LAST,m.display_order,m.name,m.id;
$menu$;
REVOKE ALL ON FUNCTION public.neo_public_menu_with_stock(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_public_menu_with_stock(uuid,uuid,text) TO anon,authenticated;

-- A stale menu or a direct request must still pass the stock gate at checkout.
CREATE FUNCTION public.neo_guard_public_order_stock()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
AS $guard$
DECLARE sale public.pos_orders; requested numeric;
BEGIN
  SELECT * INTO sale FROM public.pos_orders WHERE id=NEW.order_id AND organization_id=NEW.organization_id;
  IF sale.order_source IS NULL OR sale.order_source NOT IN ('customer-app','guest-app') THEN RETURN NEW; END IF;
  IF NEW.quantity IS NULL OR NEW.quantity<=0 OR NEW.quantity::text IN ('NaN','Infinity','-Infinity')
    OR NOT EXISTS (
      SELECT 1 FROM public.menu_items m
      WHERE m.id=NEW.menu_item_id AND m.organization_id=sale.organization_id
        AND (m.branch_id IS NULL OR m.branch_id=sale.branch_id) AND m.publish_status='published'
        AND m.availability='available'
        AND (m.active_from IS NULL OR m.active_from<=current_date)
        AND (m.active_to IS NULL OR m.active_to>=current_date)
    ) THEN
    RAISE EXCEPTION 'An item is no longer available. Review your cart and try again.' USING ERRCODE='23514';
  END IF;
  SELECT NEW.quantity + coalesce(sum(i.quantity),0) INTO requested
  FROM public.pos_order_items i WHERE i.order_id=NEW.order_id AND i.menu_item_id=NEW.menu_item_id;
  IF EXISTS (SELECT 1 FROM public.neo_department_menu_stock(
    sale.organization_id,sale.branch_id,sale.order_type,NEW.menu_item_id,requested
  ) s WHERE s.available IS FALSE) THEN
    RAISE EXCEPTION 'There is not enough stock for an item in your cart. Adjust the quantity or choose another item.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$guard$;
REVOKE ALL ON FUNCTION public.neo_guard_public_order_stock() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER neo_guard_public_order_stock
BEFORE INSERT ON public.pos_order_items FOR EACH ROW EXECUTE FUNCTION public.neo_guard_public_order_stock();
NOTIFY pgrst,'reload schema';
COMMIT;
