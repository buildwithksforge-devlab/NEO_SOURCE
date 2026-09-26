-- 1. Room sellability derivation ------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_room_is_sellable(
  _hk text, _mt text, _occ text, _status text
) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = public
AS $$
  SELECT coalesce(lower(_status),'active') = 'active'
     AND coalesce(lower(_hk),'clean') IN ('clean','inspected')
     AND coalesce(lower(_mt),'operational') = 'operational'
     AND coalesce(lower(_occ),'vacant') = 'vacant';
$$;

CREATE OR REPLACE FUNCTION public.neo_rooms_sellable_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.sellable := public.neo_room_is_sellable(
    NEW.housekeeping_status, NEW.maintenance_status, NEW.occupancy_status, NEW.status);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS neo_rooms_sellable_guard_trg ON public.rooms;
CREATE TRIGGER neo_rooms_sellable_guard_trg
BEFORE INSERT OR UPDATE ON public.rooms
FOR EACH ROW EXECUTE FUNCTION public.neo_rooms_sellable_guard();

-- 2. Integrity scan / repair ------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_integrity_repair(
  _org uuid DEFAULT NULL, _apply boolean DEFAULT true
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _rooms_bad int := 0; _rooms_fixed int := 0;
  _items_bad int := 0; _items_fixed int := 0;
  _scope uuid := _org;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    _scope := coalesce(_scope, public.current_org_id());
    IF _scope IS DISTINCT FROM public.current_org_id() OR NOT public.is_org_admin() THEN
      RAISE EXCEPTION 'Not authorised to run the integrity repair for this organisation.';
    END IF;
  END IF;

  SELECT count(*) INTO _rooms_bad FROM public.rooms r
   WHERE (_scope IS NULL OR r.organization_id = _scope)
     AND r.sellable IS DISTINCT FROM public.neo_room_is_sellable(
           r.housekeeping_status, r.maintenance_status, r.occupancy_status, r.status);

  SELECT count(*) INTO _items_bad FROM public.pos_order_items i
   WHERE i.station_id IS NULL AND (_scope IS NULL OR i.organization_id = _scope);

  IF _apply THEN
    WITH fixed AS (
      UPDATE public.rooms r SET updated_at = now()
       WHERE (_scope IS NULL OR r.organization_id = _scope)
         AND r.sellable IS DISTINCT FROM public.neo_room_is_sellable(
               r.housekeeping_status, r.maintenance_status, r.occupancy_status, r.status)
      RETURNING 1
    ) SELECT count(*) INTO _rooms_fixed FROM fixed;

    WITH fixed AS (
      UPDATE public.pos_order_items i
         SET station_id = public.neo_resolve_item_station(
               i.organization_id, i.branch_id, i.menu_item_id, NULL)
       WHERE i.station_id IS NULL
         AND (_scope IS NULL OR i.organization_id = _scope)
         AND public.neo_resolve_item_station(
               i.organization_id, i.branch_id, i.menu_item_id, NULL) IS NOT NULL
      RETURNING 1
    ) SELECT count(*) INTO _items_fixed FROM fixed;
  END IF;

  RETURN jsonb_build_object(
    'organization_id', _scope,
    'applied', _apply,
    'checked_at', now(),
    'rooms_invalid_sellable', _rooms_bad,
    'rooms_repaired', _rooms_fixed,
    'order_items_unrouted', _items_bad,
    'order_items_routed', _items_fixed,
    'order_items_still_unrouted', greatest(_items_bad - _items_fixed, 0)
  );
END $$;

REVOKE ALL ON FUNCTION public.neo_integrity_repair(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_integrity_repair(uuid, boolean) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.neo_room_is_sellable(text,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_room_is_sellable(text,text,text,text) TO authenticated, service_role;

-- 3. Notification template catalogue ---------------------------------------
CREATE TABLE IF NOT EXISTS public.notification_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  category text NOT NULL,
  priority text NOT NULL DEFAULT 'normal',
  action_required boolean NOT NULL DEFAULT false,
  source_module text NOT NULL DEFAULT 'operations',
  title_template text NOT NULL,
  body_template text NOT NULL DEFAULT '',
  link_template text,
  description text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS notification_templates_global_uidx
  ON public.notification_templates (event_type) WHERE organization_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS notification_templates_org_uidx
  ON public.notification_templates (organization_id, event_type) WHERE organization_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.notification_templates TO authenticated;
GRANT ALL ON public.notification_templates TO service_role;
ALTER TABLE public.notification_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "notification_templates read" ON public.notification_templates;
CREATE POLICY "notification_templates read" ON public.notification_templates
FOR SELECT TO authenticated
USING (organization_id IS NULL OR organization_id = public.current_org_id());

DROP POLICY IF EXISTS "notification_templates insert" ON public.notification_templates;
CREATE POLICY "notification_templates insert" ON public.notification_templates
FOR INSERT TO authenticated
WITH CHECK (organization_id = public.current_org_id()
  AND (public.is_org_admin() OR public.has_permission('automation','create')));

DROP POLICY IF EXISTS "notification_templates update" ON public.notification_templates;
CREATE POLICY "notification_templates update" ON public.notification_templates
FOR UPDATE TO authenticated
USING (organization_id = public.current_org_id()
  AND (public.is_org_admin() OR public.has_permission('automation','edit')))
WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "notification_templates delete" ON public.notification_templates;
CREATE POLICY "notification_templates delete" ON public.notification_templates
FOR DELETE TO authenticated
USING (organization_id = public.current_org_id()
  AND (public.is_org_admin() OR public.has_permission('automation','delete')));

CREATE OR REPLACE FUNCTION public.notification_templates_touch()
RETURNS trigger LANGUAGE plpgsql SET search_path = public
AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS notification_templates_touch_trg ON public.notification_templates;
CREATE TRIGGER notification_templates_touch_trg
BEFORE UPDATE ON public.notification_templates
FOR EACH ROW EXECUTE FUNCTION public.notification_templates_touch();

INSERT INTO public.notification_templates
  (organization_id, event_type, category, priority, action_required, source_module,
   title_template, body_template, link_template, description)
VALUES
 (NULL,'pos.ticket_routed','tasks','normal',true,'kitchen','Order {{reference}} — new ticket','{{count}} item(s) routed to {{station}}.','/kitchen?order={{record}}','Order submitted → assigned preparation station'),
 (NULL,'kitchen.item_ready','tasks','high',true,'restaurant','Item ready — order {{reference}}','{{item}} is ready for service.','/restaurant/orders?order={{record}}','Item ready → assigned waiter'),
 (NULL,'housekeeping.job_created','tasks','high',true,'housekeeping','Departure clean required — room {{room}}','The room is out of inventory until it is cleaned and inspected.','/housekeeping?job={{record}}','Checkout → assigned housekeeping team'),
 (NULL,'housekeeping.awaiting_inspection','approvals','high',true,'housekeeping','Inspection required — room {{room}}','Cleaning is complete and awaiting supervisor inspection.','/housekeeping?job={{record}}','Cleaning submitted → housekeeping supervisor'),
 (NULL,'housekeeping.inspection_passed','operational-alert','normal',false,'front-office','Room {{room}} is sellable','Inspection passed. The room is back in inventory.','/front-office/rooms?room={{room_id}}','Inspection passed → front office'),
 (NULL,'housekeeping.inspection_failed','tasks','high',true,'housekeeping','Re-clean required — room {{room}}','Inspection failed. The room stays out of inventory.','/housekeeping?job={{record}}','Inspection failed → assigned cleaner'),
 (NULL,'maintenance.fault_reported','tasks','high',true,'maintenance','Maintenance fault — {{location}}','{{summary}}','/maintenance?order={{record}}','Maintenance fault → assigned maintenance team'),
 (NULL,'inventory.stock_shortage','operational-alert','high',true,'inventory','Stock shortage — {{item}}','Available {{available}} against required {{required}}.','/inventory/stock?item={{record}}','Stock shortage → assigned storekeeper'),
 (NULL,'procurement.request_raised','approvals','high',true,'procurement','Purchase request {{reference}} needs approval','{{summary}}','/procurement/requests?request={{record}}','Purchase request → authorised approver'),
 (NULL,'procurement.stock_unavailable','operational-alert','high',true,'procurement','Procurement required — {{item}}','Requested stock is unavailable and needs sourcing.','/procurement/requests?item={{record}}','Unavailable stock → procurement'),
 (NULL,'procurement.goods_received','workflow','normal',false,'procurement','Goods received — {{reference}}','Stock increased and a supplier liability was raised.','/procurement/receipts?grn={{record}}','GRN → stores and finance'),
 (NULL,'delivery.ready_for_dispatch','tasks','high',true,'delivery','Order {{reference}} ready for dispatch','Packed and waiting for a rider assignment.','/delivery?order={{record}}','Delivery ready → dispatcher'),
 (NULL,'delivery.rider_assigned','tasks','high',true,'delivery','Delivery assigned — {{reference}}','Pick up from {{location}}.','/rider?order={{record}}','Rider assignment → assigned rider'),
 (NULL,'workflow.escalation','operational-alert','urgent',true,'operations','Escalation — {{summary}}','A workflow step is delayed or has failed.','{{link}}','Delayed/failed workflow → escalation recipient'),
 (NULL,'finance.void_requested','approvals','high',true,'finance','Void/refund approval — {{reference}}','{{summary}}','/approvals?request={{record}}','Void/refund/discount request → independent approver')
ON CONFLICT DO NOTHING;

-- 4. Template-driven notification helper -----------------------------------
CREATE OR REPLACE FUNCTION public.neo_notify_event(
  _org uuid, _user uuid, _branch uuid, _event text,
  _record uuid DEFAULT NULL, _vars jsonb DEFAULT '{}'::jsonb, _idem text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _t public.notification_templates; _title text; _body text; _link text; _k text;
BEGIN
  IF _org IS NULL OR _event IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO _t FROM public.notification_templates
   WHERE event_type = _event AND active
     AND (organization_id = _org OR organization_id IS NULL)
   ORDER BY organization_id NULLS LAST LIMIT 1;
  IF _t.id IS NULL THEN RETURN NULL; END IF;

  _title := _t.title_template; _body := _t.body_template; _link := _t.link_template;
  _vars := coalesce(_vars,'{}'::jsonb) || jsonb_build_object('record', coalesce(_record::text,''));
  FOR _k IN SELECT jsonb_object_keys(_vars) LOOP
    _title := replace(_title, '{{'||_k||'}}', coalesce(_vars->>_k,''));
    _body  := replace(_body,  '{{'||_k||'}}', coalesce(_vars->>_k,''));
    _link  := replace(coalesce(_link,''), '{{'||_k||'}}', coalesce(_vars->>_k,''));
  END LOOP;

  RETURN public.neo_notify(_org, _user, _branch, _t.category, _title, _body,
    nullif(_link,''), _t.priority, _t.action_required, _t.source_module, _record, _event,
    coalesce(_idem, _event || ':' || coalesce(_record::text,'') || ':' || coalesce(_user::text,'all')));
END $$;

REVOKE ALL ON FUNCTION public.neo_notify_event(uuid,uuid,uuid,text,uuid,jsonb,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_notify_event(uuid,uuid,uuid,text,uuid,jsonb,text) TO authenticated, service_role;