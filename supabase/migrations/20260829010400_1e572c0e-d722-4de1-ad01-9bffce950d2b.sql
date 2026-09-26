-- ============================================================
-- PHASE 1A FOLLOW-UP — Kitchen assignment governance
-- Read/visibility (neo_kitchen_visible_station_ids, station_tickets_production_read)
-- and the canonical sender are untouched.
-- ============================================================

-- Explicit allocation authority. `has_permission` matches by action class, so
-- an ordinary chef's `kitchen.edit` satisfied `kitchen.production.edit` and
-- `kitchen.chef.assign`. Allocation must be an exact grant.
CREATE OR REPLACE FUNCTION public.neo_can_assign_kitchen_work()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT auth.uid() IS NOT NULL
     AND (
       public.is_org_admin_for(public.current_org_id())
       OR public.has_exact_permission('kitchen', '*', 'chef.assign')
       OR public.has_exact_permission('kitchen', 'chef', 'assign')
       OR public.has_exact_permission('kitchen', '*', 'item.reassign')
       OR public.has_exact_permission('kitchen', 'item', 'reassign')
       OR public.has_exact_permission('kitchen', '*', 'production.manage')
       OR public.has_exact_permission('kitchen', 'production', 'manage')
     );
$$;

REVOKE ALL ON FUNCTION public.neo_can_assign_kitchen_work() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_can_assign_kitchen_work() TO authenticated, service_role;

-- Assignment RPC: replace the class-matched gate with the exact authority.
CREATE OR REPLACE FUNCTION public.neo_kitchen_assign_chef(_ticket uuid, _chef uuid, _item uuid DEFAULT NULL::uuid, _reason text DEFAULT NULL::text)
RETURNS station_tickets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_row public.station_tickets;
BEGIN
  IF NOT public.neo_can_assign_kitchen_work() THEN
    RAISE EXCEPTION 'Kitchen work is allocated by the Kitchen Manager / Head Chef' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row FROM public.station_tickets WHERE id = _ticket AND organization_id = current_org_id();
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'Kitchen order not found'; END IF;

  PERFORM set_config('neo.ticket_allocation', 'on', true);

  IF _item IS NULL THEN
    UPDATE public.station_tickets SET assigned_chef_id = _chef, updated_at = now()
    WHERE id = _ticket RETURNING * INTO v_row;
    UPDATE public.station_ticket_items SET chef_id = _chef, updated_at = now()
    WHERE ticket_id = _ticket AND COALESCE(status, 'new') NOT IN ('served', 'cancelled', 'completed');
  ELSE
    UPDATE public.station_ticket_items SET chef_id = _chef, updated_at = now()
    WHERE id = _item AND ticket_id = _ticket;
  END IF;

  INSERT INTO public.ticket_assignments (
    organization_id, branch_id, ticket_id, ticket_item_id, station_id, chef_id, assigned_by, method, reason
  ) VALUES (
    current_org_id(), v_row.branch_id, _ticket, _item, v_row.station_id, _chef, auth.uid(), 'manual', nullif(btrim(_reason), '')
  );

  PERFORM set_config('neo.ticket_allocation', 'off', true);
  RETURN v_row;
END; $function$;

-- The bar keeps its own governance: an attendant may claim an unclaimed bar
-- ticket in their configured bar stations; only a Bar Manager may hand a bar
-- ticket to somebody else. Both routines already gate themselves, so they mark
-- the write as an authorised allocation.
CREATE OR REPLACE FUNCTION public.neo_bar_accept_ticket(_ticket uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _t record; _org uuid := public.current_org_id();
BEGIN
  IF NOT public.has_permission('bar','queue','edit') THEN
    RAISE EXCEPTION 'You are not permitted to work the bar queue' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO _t FROM public.station_tickets
   WHERE id = _ticket AND organization_id = _org
     AND station_id IN (SELECT public.neo_bar_station_ids(NULL))
   FOR UPDATE;
  IF _t.id IS NULL THEN RAISE EXCEPTION 'Bar ticket not found'; END IF;
  IF _t.assigned_chef_id IS NOT NULL AND _t.assigned_chef_id <> auth.uid() THEN
    RAISE EXCEPTION 'Ticket % is already assigned to another attendant', _t.ticket_number
      USING ERRCODE = '42501';
  END IF;
  IF _t.status NOT IN ('new','accepted') THEN
    RAISE EXCEPTION 'Ticket % is % and cannot be accepted', _t.ticket_number, _t.status;
  END IF;

  PERFORM set_config('neo.ticket_allocation', 'on', true);
  UPDATE public.station_tickets
     SET assigned_chef_id = auth.uid(),
         status = 'accepted',
         accepted_at = COALESCE(accepted_at, now()),
         updated_at = now()
   WHERE id = _ticket;
  PERFORM set_config('neo.ticket_allocation', 'off', true);

  PERFORM public.emit_domain_event(_org, _t.branch_id, 'bar.ticket.accepted', 'bar', _ticket,
    jsonb_build_object('ticket_number', _t.ticket_number, 'accepted_by', auth.uid()), NULL, NULL);

  RETURN jsonb_build_object('ticket_id', _ticket, 'status', 'accepted');
END;
$function$;

CREATE OR REPLACE FUNCTION public.neo_bar_reassign_ticket(_ticket uuid, _to_user uuid, _reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _t record; _org uuid := public.current_org_id();
BEGIN
  IF NOT public.has_permission('bar','queue','create') THEN
    RAISE EXCEPTION 'Only the Bar Manager may reassign bar orders' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(btrim(_reason), '') = '' THEN
    RAISE EXCEPTION 'A reason is required to reassign a bar order';
  END IF;
  SELECT * INTO _t FROM public.station_tickets
   WHERE id = _ticket AND organization_id = _org
     AND station_id IN (SELECT public.neo_bar_station_ids(NULL));
  IF _t.id IS NULL THEN RAISE EXCEPTION 'Bar ticket not found'; END IF;
  IF _t.status IN ('completed','cancelled') THEN
    RAISE EXCEPTION 'Ticket % is already % and cannot be reassigned', _t.ticket_number, _t.status;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = _to_user AND p.organization_id = _org) THEN
    RAISE EXCEPTION 'The chosen attendant is not a member of this organisation';
  END IF;

  PERFORM set_config('neo.ticket_allocation', 'on', true);
  UPDATE public.station_tickets
     SET assigned_chef_id = _to_user, updated_at = now()
   WHERE id = _ticket;
  PERFORM set_config('neo.ticket_allocation', 'off', true);

  PERFORM public.emit_domain_event(_org, _t.branch_id, 'bar.ticket.reassigned', 'bar', _ticket,
    jsonb_build_object('from', _t.assigned_chef_id, 'to', _to_user, 'reason', _reason,
                       'ticket_number', _t.ticket_number), NULL, NULL);

  RETURN jsonb_build_object('ticket_id', _ticket, 'assigned_to', _to_user);
END;
$function$;

-- Backstop: the allocation columns cannot be written by a direct table update
-- from anyone without allocation authority, whatever the broad write policy
-- allows. Status/timer/progress columns are untouched, so execution keeps working.
CREATE OR REPLACE FUNCTION public.neo_guard_kitchen_allocation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.assigned_chef_id IS DISTINCT FROM OLD.assigned_chef_id
     OR NEW.station_id IS DISTINCT FROM OLD.station_id THEN
    IF COALESCE(current_setting('neo.ticket_allocation', true), 'off') = 'on'
       OR public.neo_can_assign_kitchen_work() THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Kitchen work is allocated by the Kitchen Manager / Head Chef'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS neo_guard_kitchen_allocation ON public.station_tickets;
CREATE TRIGGER neo_guard_kitchen_allocation
  BEFORE UPDATE ON public.station_tickets
  FOR EACH ROW EXECUTE FUNCTION public.neo_guard_kitchen_allocation();

CREATE OR REPLACE FUNCTION public.neo_guard_kitchen_item_allocation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.chef_id IS DISTINCT FROM OLD.chef_id THEN
    IF COALESCE(current_setting('neo.ticket_allocation', true), 'off') = 'on'
       OR public.neo_can_assign_kitchen_work()
       OR NEW.chef_id IS NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Kitchen work is allocated by the Kitchen Manager / Head Chef'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS neo_guard_kitchen_item_allocation ON public.station_ticket_items;
CREATE TRIGGER neo_guard_kitchen_item_allocation
  BEFORE UPDATE ON public.station_ticket_items
  FOR EACH ROW EXECUTE FUNCTION public.neo_guard_kitchen_item_allocation();

-- The assignment audit trail follows the same authority.
DROP POLICY IF EXISTS ticket_assignments_write ON public.ticket_assignments;
CREATE POLICY ticket_assignments_write ON public.ticket_assignments
  FOR ALL TO authenticated
  USING (organization_id = public.current_org_id() AND public.neo_can_assign_kitchen_work())
  WITH CHECK (organization_id = public.current_org_id() AND public.neo_can_assign_kitchen_work());