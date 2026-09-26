CREATE OR REPLACE FUNCTION public.neo_pos_guard_item_void()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'voided' THEN
    IF NOT (public.has_permission('restaurant','orders.void')
            OR public.has_permission('restaurant','approvals.approve')
            OR public.is_org_admin()) THEN
      RAISE EXCEPTION 'void_requires_authority' USING ERRCODE = '42501',
        DETAIL = 'Voiding an order item requires explicit void authority.';
    END IF;
    INSERT INTO public.audit_logs
      (organization_id, user_id, user_name, action, module, record_id, previous_value, new_value)
    VALUES (NEW.organization_id, auth.uid(), '', 'restaurant.order_item.voided', 'restaurant', NEW.id::text,
      jsonb_build_object('status', OLD.status), jsonb_build_object('status', NEW.status, 'order_id', NEW.order_id));
  END IF;
  RETURN NEW;
END $function$
;

CREATE OR REPLACE FUNCTION public.neo_pos_guard_void_discount()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _may_void boolean := public.has_permission('restaurant','orders.void')
                       OR public.has_permission('restaurant','approvals.approve')
                       OR public.is_org_admin();
  _may_discount boolean := public.has_permission('restaurant','orders.override')
                           OR public.has_permission('restaurant','orders.void')
                           OR public.has_permission('restaurant','approvals.approve')
                           OR public.is_org_admin();
  _old_disc numeric := coalesce(OLD.discount_total, 0) + coalesce(OLD.discount_amount, 0);
  _new_disc numeric := coalesce(NEW.discount_total, 0) + coalesce(NEW.discount_amount, 0);
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('voided','cancelled') THEN
    IF NOT _may_void THEN
      RAISE EXCEPTION 'void_requires_authority' USING ERRCODE = '42501',
        DETAIL = 'Voiding or cancelling a restaurant order requires explicit void authority.';
    END IF;
    INSERT INTO public.audit_logs
      (organization_id, user_id, user_name, action, module, record_id, previous_value, new_value)
    VALUES (NEW.organization_id, auth.uid(), '', 'restaurant.order.' || NEW.status, 'restaurant', NEW.id::text,
      jsonb_build_object('status', OLD.status, 'grand_total', OLD.grand_total),
      jsonb_build_object('status', NEW.status));
  END IF;

  IF _new_disc > _old_disc + 0.0001 THEN
    IF NOT _may_discount THEN
      RAISE EXCEPTION 'discount_requires_authority' USING ERRCODE = '42501',
        DETAIL = 'Applying or increasing a discount requires explicit discount authority.';
    END IF;
    INSERT INTO public.audit_logs
      (organization_id, user_id, user_name, action, module, record_id, previous_value, new_value)
    VALUES (NEW.organization_id, auth.uid(), '', 'restaurant.order.discount', 'restaurant', NEW.id::text,
      jsonb_build_object('discount', _old_disc), jsonb_build_object('discount', _new_disc));
  END IF;

  RETURN NEW;
END $function$
;

CREATE OR REPLACE FUNCTION public.pos_enforce_item_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE allowed text[];
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
  INSERT INTO public.pos_order_status_history (organization_id, order_id, order_item_id, previous_status, new_status, station_id, changed_by)
  VALUES (NEW.organization_id, NEW.order_id, NEW.id, OLD.status, NEW.status, NEW.station_id, auth.uid());
  RETURN NEW;
END; $function$
;

CREATE OR REPLACE FUNCTION public.pos_enforce_order_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE allowed text[];
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  SELECT coalesce(array_agg(v::text), ARRAY[]::text[]) INTO allowed
  FROM jsonb_array_elements_text(coalesce(public.neo_pos_status_rules() -> OLD.status, '[]'::jsonb)) v;
  IF NOT (NEW.status = ANY(allowed)) THEN
    RAISE EXCEPTION 'Invalid order status transition % -> % (allowed from %: %)',
      OLD.status, NEW.status, OLD.status,
      CASE WHEN array_length(allowed, 1) IS NULL THEN 'none' ELSE array_to_string(allowed, ', ') END;
  END IF;
  INSERT INTO public.pos_order_status_history (organization_id, order_id, previous_status, new_status, station_id, changed_by)
  VALUES (NEW.organization_id, NEW.id, OLD.status, NEW.status, NEW.station_id, auth.uid());
  RETURN NEW;
END; $function$
;

CREATE TRIGGER neo_pos_guard_item_void_trg BEFORE UPDATE ON public.pos_order_items FOR EACH ROW EXECUTE FUNCTION neo_pos_guard_item_void();
CREATE TRIGGER neo_pos_guard_void_discount_trg BEFORE UPDATE ON public.pos_orders FOR EACH ROW EXECUTE FUNCTION neo_pos_guard_void_discount()
