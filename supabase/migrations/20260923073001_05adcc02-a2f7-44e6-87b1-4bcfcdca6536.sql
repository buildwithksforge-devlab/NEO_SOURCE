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
    -- Self-claim of unallocated work: kitchen staff use the kitchen accept
    -- capability, bar staff the bar queue capability on a bar line.
    IF OLD.chef_id IS NULL
       AND NEW.chef_id = auth.uid()
       AND (
         public.has_permission('kitchen', 'ticket.accept')
         OR (
           public.has_permission('bar','queue','edit')
           AND EXISTS (
             SELECT 1 FROM public.station_tickets t
             WHERE t.id = NEW.ticket_id
               AND t.station_id IN (SELECT public.neo_bar_station_ids(t.branch_id))
           )
         )
       ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Kitchen work is allocated by the Kitchen Manager / Head Chef'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;