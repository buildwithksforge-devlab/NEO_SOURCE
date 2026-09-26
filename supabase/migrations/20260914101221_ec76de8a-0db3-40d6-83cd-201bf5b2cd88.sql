-- ============================ configuration health, per property ==========
CREATE OR REPLACE FUNCTION public.neo_configuration_health(_branch uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  org uuid := public.current_org_id();
  props jsonb := '[]'::jsonb;
  b record;
  checks jsonb;
  n_stations int; n_stores int; n_unmapped int; n_items int;
  n_mode_unset int; n_direct int; n_recipe int; n_bottle int; n_menu int;
  mpesa_ok boolean; n_providers int;
BEGIN
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;

  SELECT coalesce(bool_or(enabled), false) INTO mpesa_ok
    FROM public.mpesa_settings WHERE organization_id = org;
  SELECT count(*) INTO n_providers
    FROM public.provider_connections
   WHERE organization_id = org AND coalesce(enabled, false) AND coalesce(status,'') <> 'failed';

  FOR b IN
    SELECT id, name FROM public.branches
     WHERE organization_id = org
       AND coalesce(active, true)
       AND (_branch IS NULL OR id = _branch)
       AND public.neo_branch_in_scope(id)
     ORDER BY name
  LOOP
    checks := '[]'::jsonb;

    SELECT count(*) INTO n_stations FROM public.operational_stations
     WHERE branch_id = b.id AND coalesce(active, true);
    SELECT count(*) INTO n_stores FROM public.stock_locations
     WHERE branch_id = b.id AND coalesce(active, true);
    SELECT count(*) INTO n_unmapped FROM public.operational_stations s
     WHERE s.branch_id = b.id AND coalesce(s.active, true)
       AND NOT EXISTS (SELECT 1 FROM public.stock_locations l
                        WHERE l.station_id = s.id AND coalesce(l.active, true));
    SELECT count(*) INTO n_items FROM public.stock_items
     WHERE branch_id = b.id AND coalesce(active, true);
    SELECT count(*) INTO n_menu FROM public.menu_items WHERE branch_id = b.id;
    SELECT count(*) INTO n_mode_unset FROM public.menu_items
     WHERE branch_id = b.id AND consumption_mode IS NULL;
    SELECT count(*) INTO n_direct FROM public.menu_items
     WHERE branch_id = b.id AND consumption_mode = 'direct_stock' AND stock_item_id IS NULL;
    SELECT count(*) INTO n_recipe FROM public.menu_items m
     WHERE m.branch_id = b.id AND m.consumption_mode = 'recipe'
       AND NOT EXISTS (
         SELECT 1 FROM public.recipes r
          JOIN public.recipe_ingredients ri ON ri.recipe_id = r.id
         WHERE r.menu_item_id = m.id AND coalesce(r.status,'active') <> 'archived');
    SELECT count(*) INTO n_bottle FROM public.stock_items
     WHERE branch_id = b.id AND coalesce(active, true)
       AND (coalesce(may_open_for_pours, false) OR container_type = 'bottle')
       AND container_volume_ml IS NULL;

    IF n_stations = 0 THEN
      checks := checks || jsonb_build_object('code','stations','label','No stations set up',
        'detail','This property has no kitchen, bar or service stations, so orders cannot be routed.',
        'count', 0, 'severity','critical','fix_route','/kitchen/settings','fix_label','Set up stations');
    END IF;
    IF n_stores = 0 THEN
      checks := checks || jsonb_build_object('code','stores','label','No stores set up',
        'detail','Nothing can be stocked, issued or deducted until this property has at least one store.',
        'count', 0, 'severity','critical','fix_route','/kitchen/stores','fix_label','Set up stores');
    ELSIF n_unmapped > 0 THEN
      checks := checks || jsonb_build_object('code','station_store','label','Stations without a store',
        'detail','These stations have no store to draw from, so their sales cannot deduct stock.',
        'count', n_unmapped, 'severity','warning','fix_route','/kitchen/stores','fix_label','Link stores');
    END IF;
    IF n_items = 0 THEN
      checks := checks || jsonb_build_object('code','stock_items','label','No stock items',
        'detail','This property holds no stock items, so no sale can reduce a balance.',
        'count', 0, 'severity','critical','fix_route','/inventory/items','fix_label','Add stock items');
    END IF;
    IF n_mode_unset > 0 THEN
      checks := checks || jsonb_build_object('code','menu_mode','label','Menu items with no stock behaviour',
        'detail','Each item must say whether it takes no stock, a direct item, a recipe or a batch.',
        'count', n_mode_unset, 'severity','warning','fix_route','/pos/menu','fix_label','Set stock behaviour');
    END IF;
    IF n_direct > 0 THEN
      checks := checks || jsonb_build_object('code','direct_stock','label','Direct-stock items with no stock item',
        'detail','These menu items sell a packaged product but are not linked to the product they take.',
        'count', n_direct, 'severity','critical','fix_route','/pos/menu','fix_label','Link stock items');
    END IF;
    IF n_recipe > 0 THEN
      checks := checks || jsonb_build_object('code','recipes','label','Recipe items with no recipe',
        'detail','These menu items are set to consume a recipe, but no recipe with ingredients exists.',
        'count', n_recipe, 'severity','critical','fix_route','/kitchen/recipes','fix_label','Write recipes');
    END IF;
    IF n_bottle > 0 THEN
      checks := checks || jsonb_build_object('code','bottle_sizes','label','Bottles with no container size',
        'detail','Tots and cocktails cannot be measured until each bottle records its volume.',
        'count', n_bottle, 'severity','critical','fix_route','/inventory/items','fix_label','Enter bottle sizes');
    END IF;
    IF NOT mpesa_ok AND n_providers = 0 THEN
      checks := checks || jsonb_build_object('code','payments','label','No payment integration connected',
        'detail','No mobile-money or card provider is connected, so only manual tenders can be taken.',
        'count', 0, 'severity','warning','fix_route','/platform/integrations','fix_label','Connect a provider');
    END IF;

    props := props || jsonb_build_array(jsonb_build_object(
      'branch_id', b.id, 'branch_name', b.name,
      'stations', n_stations, 'stores', n_stores, 'stock_items', n_items, 'menu_items', n_menu,
      'issues', jsonb_array_length(checks), 'checks', checks));
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'properties', props,
    'mpesa_enabled', mpesa_ok, 'provider_connections', n_providers);
END; $$;
REVOKE EXECUTE ON FUNCTION public.neo_configuration_health(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_configuration_health(uuid) TO authenticated;

-- ============== a verified PIN is stamped expired as well as consumed ======
CREATE OR REPLACE FUNCTION public.neo_delivery_pin_expire_on_consume()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.consumed_at IS NOT NULL AND OLD.consumed_at IS NULL THEN
    NEW.expires_at := least(coalesce(NEW.expires_at, NEW.consumed_at), NEW.consumed_at);
    NEW.pin_secret := NULL;
    NEW.pin := '';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS delivery_order_pins_expire_on_consume ON public.delivery_order_pins;
CREATE TRIGGER delivery_order_pins_expire_on_consume
  BEFORE UPDATE ON public.delivery_order_pins
  FOR EACH ROW EXECUTE FUNCTION public.neo_delivery_pin_expire_on_consume();