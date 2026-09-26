
CREATE TABLE IF NOT EXISTS public.station_consumption_stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid,
  station_id uuid NOT NULL REFERENCES public.operational_stations(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.stock_locations(id) ON DELETE CASCADE,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (station_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.station_consumption_stores TO authenticated;
GRANT ALL ON public.station_consumption_stores TO service_role;

ALTER TABLE public.station_consumption_stores ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members read station stores"
  ON public.station_consumption_stores FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());

CREATE POLICY "Inventory settings manage station stores"
  ON public.station_consumption_stores FOR ALL TO authenticated
  USING (organization_id = public.current_org_id()
         AND (public.has_permission('inventory','settings.manage') OR public.is_org_admin_for(organization_id)))
  WITH CHECK (organization_id = public.current_org_id()
         AND (public.has_permission('inventory','settings.manage') OR public.is_org_admin_for(organization_id)));

CREATE OR REPLACE FUNCTION public.station_consumption_stores_touch()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $fn$;

CREATE TRIGGER station_consumption_stores_touch
  BEFORE UPDATE ON public.station_consumption_stores
  FOR EACH ROW EXECUTE FUNCTION public.station_consumption_stores_touch();

CREATE OR REPLACE FUNCTION public.neo_station_consumption_location(_org uuid, _station uuid, _branch uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    -- 1. Explicit station → store mapping.
    (SELECT sl.id FROM station_consumption_stores m
       JOIN stock_locations sl ON sl.id = m.location_id AND sl.active
      WHERE m.station_id = _station AND m.organization_id = _org),
    -- 2. A store dedicated to this station.
    (SELECT sl.id FROM stock_locations sl
      WHERE sl.organization_id = _org AND sl.active AND _station IS NOT NULL
        AND sl.station_id = _station
      ORDER BY sl.created_at LIMIT 1),
    -- 3. A store assigned to the station's own department, same property.
    (SELECT sl.id FROM stock_locations sl
      JOIN operational_stations s ON s.id = _station
     WHERE sl.organization_id = _org AND sl.active
       AND sl.department_id IS NOT NULL AND sl.department_id = s.department_id
       AND (sl.branch_id IS NOT DISTINCT FROM s.branch_id OR sl.branch_id IS NULL)
     ORDER BY (sl.branch_id IS NOT DISTINCT FROM s.branch_id) DESC, sl.created_at
     LIMIT 1),
    -- 4. Only an item with no production station at all may use a property store.
    (SELECT sl.id FROM stock_locations sl
      WHERE _station IS NULL AND sl.organization_id = _org AND sl.active
        AND sl.station_id IS NULL
        AND ((_branch IS NOT NULL AND (sl.branch_id = _branch OR sl.branch_id IS NULL))
             OR (_branch IS NULL AND sl.branch_id IS NULL))
      ORDER BY (sl.branch_id IS NOT DISTINCT FROM _branch) DESC,
               (sl.location_type = 'kitchen') DESC, sl.is_main DESC, sl.created_at
      LIMIT 1)
  );
$function$;

DROP FUNCTION IF EXISTS public.neo_station_store_gaps(uuid);
CREATE OR REPLACE FUNCTION public.neo_station_store_gaps(_branch uuid DEFAULT NULL)
 RETURNS TABLE(station_id uuid, station_name text, station_type text,
               department_id uuid, department_name text, branch_id uuid, store_id uuid, store_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT s.id, s.name, s.station_type, s.department_id, d.name, s.branch_id,
         public.neo_station_consumption_location(s.organization_id, s.id, s.branch_id),
         (SELECT sl.name FROM stock_locations sl
           WHERE sl.id = public.neo_station_consumption_location(s.organization_id, s.id, s.branch_id))
    FROM operational_stations s
    LEFT JOIN departments d ON d.id = s.department_id
   WHERE s.organization_id = public.current_org_id()
     AND (_branch IS NULL OR s.branch_id = _branch)
     AND public.neo_branch_in_scope(s.branch_id)
   ORDER BY d.name NULLS LAST, s.name;
$function$;

GRANT EXECUTE ON FUNCTION public.neo_station_store_gaps(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_pos_route_tickets_internal(_order uuid, _org uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _o public.pos_orders; _it record; _station uuid; _ticket uuid; _target int;
  _created int := 0; _reused int := 0; _tickets int := 0; _unassigned int := 0;
  _consumes boolean; _gap text[] := ARRAY[]::text[]; _station_name text;
BEGIN
  SELECT * INTO _o FROM public.pos_orders WHERE id = _order AND organization_id = _org;
  IF _o.id IS NULL THEN RAISE EXCEPTION 'order_not_found' USING ERRCODE = 'P0002'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(_order::text, 42));

  FOR _it IN
    SELECT oi.* FROM public.pos_order_items oi
     WHERE oi.order_id = _order AND oi.organization_id = _org
       AND oi.held = false AND coalesce(oi.status,'draft') NOT IN ('cancelled','voided')
     ORDER BY oi.created_at
  LOOP
    IF EXISTS (SELECT 1 FROM public.station_ticket_items sti
                WHERE sti.order_item_id = _it.id AND sti.remake_of_id IS NULL) THEN
      _reused := _reused + 1; CONTINUE;
    END IF;

    _station := nullif(public.neo_kitchen_route_order_item(_it.id)->>'station_id','')::uuid;
    IF _station IS NULL THEN
      _unassigned := _unassigned + 1;
      CONTINUE;
    END IF;

    SELECT COALESCE(mi.consumption_mode,'none') <> 'none'
           OR EXISTS (SELECT 1 FROM public.recipes r
                       WHERE r.organization_id = _org AND r.menu_item_id = _it.menu_item_id
                         AND r.recipe_type IN ('menu_item','direct_sale') AND r.status = 'active')
      INTO _consumes
      FROM public.menu_items mi WHERE mi.id = _it.menu_item_id;

    IF COALESCE(_consumes,false)
       AND public.neo_station_consumption_location(_org, _station, _o.branch_id) IS NULL THEN
      SELECT s.name INTO _station_name FROM public.operational_stations s WHERE s.id = _station;
      IF NOT (COALESCE(_station_name, _station::text) = ANY (_gap)) THEN
        _gap := _gap || COALESCE(_station_name, _station::text);
      END IF;
      CONTINUE;
    END IF;

    IF _station IS DISTINCT FROM _it.station_id THEN
      UPDATE public.pos_order_items SET station_id = _station WHERE id = _it.id;
    END IF;

    SELECT COALESCE(
      (SELECT pt.target_minutes FROM public.preparation_targets pt
        WHERE pt.organization_id = _org AND pt.active
          AND (pt.branch_id IS NULL OR pt.branch_id = _o.branch_id)
          AND ((pt.scope='menu-item' AND pt.menu_item_id = _it.menu_item_id)
            OR (pt.scope='station' AND pt.station_id = _station)
            OR (pt.scope='order-type' AND pt.order_type = _o.order_type)
            OR (pt.scope='branch'))
        ORDER BY CASE pt.scope WHEN 'menu-item' THEN 1 WHEN 'station' THEN 2 WHEN 'order-type' THEN 3 ELSE 4 END
        LIMIT 1),
      (SELECT mi.prep_minutes FROM public.menu_items mi WHERE mi.id = _it.menu_item_id),
      15) INTO _target;

    INSERT INTO public.station_tickets (
      organization_id, branch_id, department_id, order_id, station_id, ticket_number, course,
      priority, status, target_minutes, received_at, created_by, routing_note)
    VALUES (_org, _o.branch_id,
      (SELECT s.department_id FROM public.operational_stations s WHERE s.id = _station),
      _order, _station,
      'KT-' || upper(substr(replace(_order::text,'-',''),1,6)) || '-' ||
        upper(substr(md5(_station::text || _it.course), 1, 4)),
      _it.course, COALESCE(_o.order_type,'dine-in'), 'new', _target, now(), auth.uid(), NULL)
    ON CONFLICT (order_id, COALESCE(station_id, '00000000-0000-0000-0000-000000000000'::uuid), course)
      DO NOTHING;
    IF FOUND THEN _tickets := _tickets + 1; END IF;

    SELECT id INTO _ticket FROM public.station_tickets
      WHERE order_id = _order AND course = _it.course
        AND COALESCE(station_id,'00000000-0000-0000-0000-000000000000'::uuid) = _station;
    IF _ticket IS NULL THEN CONTINUE; END IF;

    BEGIN
      INSERT INTO public.station_ticket_items (organization_id, ticket_id, order_item_id, status)
      VALUES (_org, _ticket, _it.id, 'new');
      _created := _created + 1;
    EXCEPTION WHEN unique_violation THEN
      _reused := _reused + 1;
    END;

    UPDATE public.pos_order_items
       SET status = CASE WHEN status IN ('draft','new','held') THEN 'sent' ELSE status END,
           sent_at = COALESCE(sent_at, now())
     WHERE id = _it.id;
  END LOOP;

  IF array_length(_gap, 1) > 0 THEN
    RAISE EXCEPTION 'store_unmapped: % has no consumption store for this property', array_to_string(_gap, ', ')
      USING ERRCODE = '22023';
  END IF;

  IF _unassigned > 0 THEN
    RAISE EXCEPTION 'routing_unresolved: % item(s) have no production station configured for this property', _unassigned
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.pos_orders
     SET status = 'sent', sent_at = COALESCE(sent_at, now())
   WHERE id = _order AND (status IS NULL OR status IN ('draft','open','new','draft-sent','confirmed'));

  RETURN jsonb_build_object('ok', true, 'order_id', _order, 'tickets_created', _tickets,
                            'items_created', _created, 'items_reused', _reused,
                            'unassigned_station', 0);
END;
$function$;
