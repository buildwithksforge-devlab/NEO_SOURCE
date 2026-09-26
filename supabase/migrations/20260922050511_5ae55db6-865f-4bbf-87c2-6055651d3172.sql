CREATE OR REPLACE FUNCTION public.neo_guard_kitchen_allocation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.assigned_chef_id IS DISTINCT FROM OLD.assigned_chef_id
     OR NEW.station_id IS DISTINCT FROM OLD.station_id THEN
    IF COALESCE(current_setting('neo.ticket_allocation', true), 'off') = 'on'
       OR public.neo_can_assign_kitchen_work() THEN
      RETURN NEW;
    END IF;
    -- Self-claim: picking up unallocated work for yourself is production work,
    -- not allocation authority. Reassigning someone else still needs it.
    IF NEW.station_id IS NOT DISTINCT FROM OLD.station_id
       AND OLD.assigned_chef_id IS NULL
       AND NEW.assigned_chef_id = auth.uid()
       AND public.has_permission('kitchen', 'ticket.accept') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Kitchen work is allocated by the Kitchen Manager / Head Chef'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.neo_guard_kitchen_item_allocation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.chef_id IS DISTINCT FROM OLD.chef_id THEN
    IF COALESCE(current_setting('neo.ticket_allocation', true), 'off') = 'on'
       OR public.neo_can_assign_kitchen_work()
       OR NEW.chef_id IS NULL THEN
      RETURN NEW;
    END IF;
    IF OLD.chef_id IS NULL
       AND NEW.chef_id = auth.uid()
       AND public.has_permission('kitchen', 'ticket.accept') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Kitchen work is allocated by the Kitchen Manager / Head Chef'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;