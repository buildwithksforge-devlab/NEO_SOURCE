CREATE OR REPLACE FUNCTION public.neo_autopost_on_finalise()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _res jsonb; _room text; _changed boolean;
BEGIN
  IF TG_TABLE_NAME = 'pos_orders' THEN
    _changed := (TG_OP = 'INSERT') OR (NEW.status IS DISTINCT FROM OLD.status);
    IF NEW.status IN ('closed','paid','settled','completed')
       AND _changed
       AND NEW.folio_id IS NOT NULL
       AND NEW.folio_post_status IS DISTINCT FROM 'posted' THEN
      PERFORM public.neo_finance_post_source('pos', NEW.id, true);
    END IF;

  ELSIF TG_TABLE_NAME = 'guest_laundry_orders' THEN
    _changed := (TG_OP = 'INSERT')
      OR NEW.status IS DISTINCT FROM OLD.status
      OR NEW.total IS DISTINCT FROM OLD.total
      OR NEW.folio_id IS DISTINCT FROM OLD.folio_id;
    IF NEW.status IN ('delivered','completed','closed')
       AND COALESCE(NEW.posting_status,'unposted') IS DISTINCT FROM 'posted'
       AND _changed THEN
      _res := public.neo_finance_post_source('laundry', NEW.id, true);
      IF NOT COALESCE((_res->>'ok')::boolean, false) THEN
        NEW.posting_status := 'blocked';
        SELECT room_number INTO _room FROM public.rooms WHERE id = NEW.room_id;
        PERFORM public.neo_notify(
          NEW.organization_id, NULL, NEW.branch_id, 'operational-alert',
          format('Guest laundry %s is not billed', COALESCE(NEW.laundry_number, '')),
          COALESCE(_res->>'detail', 'The laundry charge could not reach a guest folio.')
            || CASE WHEN _room IS NOT NULL THEN ' Room ' || _room || '.' ELSE '' END,
          '/laundry?order=' || NEW.id::text, 'high', true,
          'laundry', NEW.id, 'laundry.posting_blocked',
          'laundry-blocked:' || NEW.id::text || ':' || COALESCE(NEW.total,0)::text);
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $function$
