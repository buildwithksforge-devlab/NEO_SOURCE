CREATE OR REPLACE FUNCTION public.pos_enforce_order_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE allowed text[];
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  allowed := CASE OLD.status
    WHEN 'draft' THEN ARRAY['held','confirmed','sent','cancelled']
    WHEN 'held' THEN ARRAY['draft','confirmed','cancelled']
    WHEN 'confirmed' THEN ARRAY['sent','cancelled']
    WHEN 'sent' THEN ARRAY['accepted','in-preparation','partially-ready','ready','cancelled','void-pending']
    WHEN 'accepted' THEN ARRAY['in-preparation','partially-ready','ready','void-pending']
    WHEN 'in-preparation' THEN ARRAY['partially-ready','ready','void-pending']
    WHEN 'partially-ready' THEN ARRAY['ready','partially-served','void-pending']
    WHEN 'ready' THEN ARRAY['partially-served','served','void-pending']
    WHEN 'partially-served' THEN ARRAY['served','awaiting-payment','void-pending']
    WHEN 'served' THEN ARRAY['awaiting-payment','void-pending']
    WHEN 'awaiting-payment' THEN ARRAY['paid','charged-to-room','credit','void-pending']
    WHEN 'paid' THEN ARRAY['closed','void-pending']
    WHEN 'charged-to-room' THEN ARRAY['closed','void-pending']
    WHEN 'credit' THEN ARRAY['closed','void-pending']
    WHEN 'closed' THEN ARRAY['awaiting-payment']
    WHEN 'void-pending' THEN ARRAY['voided','served','awaiting-payment']
    ELSE ARRAY[]::text[]
  END;
  IF NOT (NEW.status = ANY(allowed)) THEN
    RAISE EXCEPTION 'Invalid order status transition % -> %', OLD.status, NEW.status;
  END IF;
  INSERT INTO public.pos_order_status_history (organization_id, order_id, previous_status, new_status, station_id, changed_by)
  VALUES (NEW.organization_id, NEW.id, OLD.status, NEW.status, NEW.station_id, auth.uid());
  RETURN NEW;
END; $function$;