BEGIN;
DO $guard$ BEGIN
 IF to_regprocedure('public.neo_pos_sellable_menu_guard()') IS NOT NULL OR to_regprocedure('public.neo_menu_remove_item(uuid,text,text)') IS NOT NULL THEN RAISE EXCEPTION 'Menu sale/removal repair already exists; use postcheck, not reinstall'; END IF;
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='menu_items' AND column_name='publish_status') THEN RAISE EXCEPTION 'Menu schema differs'; END IF;
END $guard$;
CREATE FUNCTION public.neo_pos_sellable_menu_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE item public.menu_items; sale public.pos_orders; menu public.menus; property_today date; property_time time;
BEGIN
 IF NEW.menu_item_id IS NULL OR NEW.status IN ('cancelled','voided') THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND NEW.menu_item_id IS NOT DISTINCT FROM OLD.menu_item_id AND NEW.quantity<=OLD.quantity AND NOT (OLD.status='draft' AND NEW.status='sent') THEN RETURN NEW; END IF;
 SELECT * INTO sale FROM public.pos_orders WHERE id=NEW.order_id AND organization_id=NEW.organization_id FOR UPDATE;
 IF sale.id IS NULL THEN RAISE EXCEPTION 'The order could not be verified'; END IF;
 SELECT * INTO item FROM public.menu_items WHERE id=NEW.menu_item_id AND organization_id=NEW.organization_id FOR SHARE;
 IF item.id IS NULL OR (item.branch_id IS NOT NULL AND item.branch_id IS DISTINCT FROM sale.branch_id) THEN RAISE EXCEPTION 'Menu item does not belong to this order property'; END IF;
 IF item.availability IS DISTINCT FROM 'available' OR item.publish_status IS DISTINCT FROM 'published' THEN RAISE EXCEPTION 'This menu item is disabled, unavailable or unpublished. Refresh the menu before ordering.' USING ERRCODE='23514'; END IF;
 SELECT (now() AT TIME ZONE coalesce(nullif(btrim(b.timezone),''),'Africa/Nairobi'))::date,(now() AT TIME ZONE coalesce(nullif(btrim(b.timezone),''),'Africa/Nairobi'))::time INTO property_today,property_time FROM public.branches b WHERE b.id=sale.branch_id AND b.organization_id=sale.organization_id;
 IF property_today IS NULL THEN RAISE EXCEPTION 'Order property clock could not be verified'; END IF;
 IF (item.active_from IS NOT NULL AND property_today<item.active_from) OR (item.active_to IS NOT NULL AND property_today>item.active_to) THEN RAISE EXCEPTION 'This menu item is outside its selling dates'; END IF;
 IF item.category_id IS NOT NULL THEN
  SELECT m.* INTO menu FROM public.menus m JOIN public.menu_categories c ON c.menu_id=m.id AND c.organization_id=m.organization_id WHERE c.id=item.category_id AND m.organization_id=item.organization_id FOR SHARE OF m;
  IF menu.id IS NOT NULL THEN
   IF menu.status IS DISTINCT FROM 'active' OR (menu.branch_id IS NOT NULL AND menu.branch_id IS DISTINCT FROM sale.branch_id) OR (menu.valid_from IS NOT NULL AND property_today<menu.valid_from) OR (menu.valid_to IS NOT NULL AND property_today>menu.valid_to) OR NOT (extract(dow FROM property_today)::int=ANY(menu.valid_days)) THEN RAISE EXCEPTION 'The parent menu is inactive or outside its selling schedule'; END IF;
   IF menu.valid_time_from IS NOT NULL AND menu.valid_time_to IS NOT NULL AND NOT (CASE WHEN menu.valid_time_from<=menu.valid_time_to THEN property_time BETWEEN menu.valid_time_from AND menu.valid_time_to ELSE property_time>=menu.valid_time_from OR property_time<=menu.valid_time_to END) THEN RAISE EXCEPTION 'The parent menu is outside its serving hours'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.neo_pos_sellable_menu_guard() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER neo_pos_sellable_menu_guard_trg BEFORE INSERT OR UPDATE OF menu_item_id,quantity,status ON public.pos_order_items FOR EACH ROW EXECUTE FUNCTION public.neo_pos_sellable_menu_guard();
CREATE FUNCTION public.neo_menu_remove_item(_item uuid,_mode text DEFAULT 'archive',_reason text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE org uuid:=public.current_org_id(); item public.menu_items; ref record; used boolean;
BEGIN
 IF auth.uid() IS NULL OR org IS NULL OR NOT (public.has_permission('restaurant','menu','delete') OR public.is_org_admin()) THEN RAISE EXCEPTION 'Not permitted to remove menu items' USING ERRCODE='42501'; END IF;
 IF _mode NOT IN ('archive','delete-draft') OR nullif(btrim(_reason),'') IS NULL THEN RAISE EXCEPTION 'Select removal mode and provide a reason'; END IF;
 SELECT * INTO item FROM public.menu_items WHERE id=_item AND organization_id=org FOR UPDATE;
 IF item.id IS NULL OR NOT coalesce(public.neo_branch_in_scope(item.branch_id),false) THEN RAISE EXCEPTION 'Menu item not found in your property scope' USING ERRCODE='42501'; END IF;
 IF _mode='archive' THEN
  IF item.publish_status='archived' AND item.availability='disabled' THEN RETURN jsonb_build_object('ok',true,'item_id',_item,'mode',_mode,'idempotent',true); END IF;
  UPDATE public.menu_items SET publish_status='archived',availability='disabled',updated_at=now() WHERE id=_item AND organization_id=org;
 ELSE
  IF item.publish_status IS DISTINCT FROM 'draft' OR item.published_at IS NOT NULL THEN RAISE EXCEPTION 'Only an unused, unpublished draft can be permanently deleted. Archive this item instead.'; END IF;
  FOR ref IN SELECT c.conrelid::regclass AS target,a.attname AS column_name FROM pg_constraint c CROSS JOIN LATERAL unnest(c.conkey,c.confkey) AS keys(child,parent) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=keys.child JOIN pg_attribute p ON p.attrelid=c.confrelid AND p.attnum=keys.parent WHERE c.contype='f' AND c.confrelid='public.menu_items'::regclass AND p.attname='id' LOOP
   EXECUTE format('SELECT EXISTS(SELECT 1 FROM %s WHERE %I=$1)',ref.target,ref.column_name) INTO used USING _item;
   IF used THEN RAISE EXCEPTION 'This item has linked sales or configuration. Archive it to preserve history.'; END IF;
  END LOOP;
  DELETE FROM public.menu_items WHERE id=_item AND organization_id=org;
 END IF;
 INSERT INTO public.audit_logs(organization_id,branch_id,user_id,user_name,action,module,record_id,previous_value,new_value,reason) VALUES(org,item.branch_id,auth.uid(),'','restaurant.menu.item_removed','restaurant',_item::text,to_jsonb(item),jsonb_build_object('mode',_mode),btrim(_reason));
 RETURN jsonb_build_object('ok',true,'item_id',_item,'mode',_mode);
END $function$;
REVOKE ALL ON FUNCTION public.neo_menu_remove_item(uuid,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.neo_menu_remove_item(uuid,text,text) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
