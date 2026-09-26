CREATE OR REPLACE FUNCTION public.pos_enforce_item_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE allowed text[]; _actor uuid;
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  allowed := CASE OLD.status
    WHEN 'draft' THEN ARRAY['sent','cancelled']
    WHEN 'sent' THEN ARRAY['accepted','preparing','ready','cancel-pending']
    WHEN 'accepted' THEN ARRAY['preparing','ready','cancel-pending']
    WHEN 'preparing' THEN ARRAY['ready','cancel-pending']
    WHEN 'ready' THEN ARRAY['served','cancel-pending']
    WHEN 'served' THEN ARRAY['cancel-pending']
    WHEN 'cancel-pending' THEN ARRAY['cancelled','voided','served','ready']
    ELSE ARRAY[]::text[]
  END;
  IF NOT (NEW.status = ANY(allowed)) THEN
    RAISE EXCEPTION 'Invalid item status transition % -> %', OLD.status, NEW.status;
  END IF;
  IF NEW.status = 'ready' AND NEW.ready_at IS NULL THEN NEW.ready_at := now(); END IF;
  IF NEW.status = 'served' AND NEW.served_at IS NULL THEN NEW.served_at := now(); END IF;
  -- Customer-app orders have no staff profile behind them; the staff actor stays NULL.
  SELECT p.id INTO _actor FROM public.profiles p WHERE p.id = auth.uid();
  INSERT INTO public.pos_order_status_history (organization_id, order_id, order_item_id, previous_status, new_status, station_id, changed_by)
  VALUES (NEW.organization_id, NEW.order_id, NEW.id, OLD.status, NEW.status, NEW.station_id, _actor);
  RETURN NEW;
END; $function$;

CREATE OR REPLACE FUNCTION public.pos_enforce_order_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE allowed text[]; _actor uuid;
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  SELECT coalesce(array_agg(v::text), ARRAY[]::text[]) INTO allowed
  FROM jsonb_array_elements_text(coalesce(public.neo_pos_status_rules() -> OLD.status, '[]'::jsonb)) v;
  IF NOT (NEW.status = ANY(allowed)) THEN
    RAISE EXCEPTION 'Invalid order status transition % -> % (allowed from %: %)',
      OLD.status, NEW.status, OLD.status,
      CASE WHEN array_length(allowed, 1) IS NULL THEN 'none' ELSE array_to_string(allowed, ', ') END;
  END IF;
  SELECT p.id INTO _actor FROM public.profiles p WHERE p.id = auth.uid();
  INSERT INTO public.pos_order_status_history (organization_id, order_id, previous_status, new_status, station_id, changed_by)
  VALUES (NEW.organization_id, NEW.id, OLD.status, NEW.status, NEW.station_id, _actor);
  RETURN NEW;
END; $function$;