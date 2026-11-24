CREATE OR REPLACE FUNCTION public.neo_laundry_stamp_delivered()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status IN ('delivered','completed') AND NEW.delivered_at IS NULL THEN
    NEW.delivered_at := now();
  END IF;
  RETURN NEW;
END $function$
