CREATE OR REPLACE FUNCTION public.neo_pos_guard_void_discount()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
END $$;

DROP TRIGGER IF EXISTS neo_pos_guard_void_discount_trg ON public.pos_orders;
CREATE TRIGGER neo_pos_guard_void_discount_trg
BEFORE UPDATE ON public.pos_orders
FOR EACH ROW EXECUTE FUNCTION public.neo_pos_guard_void_discount();

CREATE OR REPLACE FUNCTION public.neo_pos_guard_item_void()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
END $$;

DROP TRIGGER IF EXISTS neo_pos_guard_item_void_trg ON public.pos_order_items;
CREATE TRIGGER neo_pos_guard_item_void_trg
BEFORE UPDATE ON public.pos_order_items
FOR EACH ROW EXECUTE FUNCTION public.neo_pos_guard_item_void();

REVOKE EXECUTE ON FUNCTION public.neo_pos_guard_void_discount() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.neo_pos_guard_item_void() FROM PUBLIC, anon, authenticated;