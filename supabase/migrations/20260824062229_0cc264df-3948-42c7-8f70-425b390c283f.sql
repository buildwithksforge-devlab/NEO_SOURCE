CREATE OR REPLACE FUNCTION public.neo_pos_guard_void_discount()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  _system boolean := auth.uid() IS NULL
                     AND coalesce(current_setting('neo.void_maintenance', true),'off') = 'on';
  _may_void boolean := _system OR public.has_permission('restaurant','orders.void')
                       OR public.has_permission('restaurant','approvals.approve')
                       OR public.is_org_admin();
  _may_discount boolean := _system OR public.has_permission('restaurant','orders.override')
                           OR public.has_permission('restaurant','orders.void')
                           OR public.has_permission('restaurant','approvals.approve')
                           OR public.is_org_admin();
  _old_disc numeric := coalesce(OLD.discount_total, 0);
  _new_disc numeric := coalesce(NEW.discount_total, 0);
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('voided','cancelled') THEN
    IF NOT _may_void THEN
      RAISE EXCEPTION 'void_requires_authority' USING ERRCODE = '42501',
        DETAIL = 'Voiding or cancelling a restaurant order requires explicit void authority.';
    END IF;
    INSERT INTO public.audit_logs
      (organization_id, user_id, user_name, action, module, record_id, previous_value, new_value)
    VALUES (NEW.organization_id, auth.uid(), CASE WHEN _system THEN 'System Cleanup' ELSE '' END,
      'restaurant.order.' || NEW.status, 'restaurant', NEW.id::text,
      jsonb_build_object('status', OLD.status, 'grand_total', OLD.grand_total),
      jsonb_build_object('status', NEW.status));
  END IF;

  IF _new_disc > _old_disc + 0.0001 THEN
    IF NOT _may_discount THEN
      RAISE EXCEPTION 'discount_requires_authority' USING ERRCODE = '42501',
        DETAIL = 'Applying or increasing a discount requires explicit override authority.';
    END IF;
    INSERT INTO public.audit_logs
      (organization_id, user_id, user_name, action, module, record_id, previous_value, new_value)
    VALUES (NEW.organization_id, auth.uid(), '', 'restaurant.order.discount', 'restaurant', NEW.id::text,
      jsonb_build_object('discount_total', _old_disc),
      jsonb_build_object('discount_total', _new_disc));
  END IF;

  RETURN NEW;
END $function$;