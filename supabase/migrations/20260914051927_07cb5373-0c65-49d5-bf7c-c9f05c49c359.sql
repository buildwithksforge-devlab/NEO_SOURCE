CREATE OR REPLACE FUNCTION public.neo_pos_guard_item_void()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'voided' THEN
    -- A cancelled/refunded delivery reverses its own lines. That decision was
    -- already taken on the delivery order, so the system reversal is allowed
    -- here; a person voiding a line by hand still needs void authority.
    IF COALESCE(current_setting('neo.delivery_reversal', true), '') <> 'on'
       AND NOT (public.has_permission('restaurant','orders.void')
            OR public.has_permission('restaurant','approvals.approve')
            OR public.is_org_admin()) THEN
      RAISE EXCEPTION 'void_requires_authority' USING ERRCODE = '42501',
        DETAIL = 'Voiding an order item requires explicit void authority.';
    END IF;
    INSERT INTO public.audit_logs
      (organization_id, user_id, user_name, action, module, record_id, previous_value, new_value)
    VALUES (NEW.organization_id, auth.uid(), '', 'restaurant.order_item.voided', 'restaurant', NEW.id::text,
      jsonb_build_object('status', OLD.status),
      jsonb_build_object('status', NEW.status, 'order_id', NEW.order_id,
        'system_reversal', COALESCE(current_setting('neo.delivery_reversal', true), '') = 'on'));
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.neo_delivery_fulfilment_stock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_fulfilled boolean; v_undone boolean;
BEGIN
  IF NEW.pos_order_id IS NULL THEN RETURN NEW; END IF;

  v_fulfilled := lower(COALESCE(NEW.order_status,'')) IN ('delivered','collected','completed')
                 AND lower(COALESCE(OLD.order_status,'')) IS DISTINCT FROM lower(COALESCE(NEW.order_status,''));

  v_undone := (lower(COALESCE(NEW.order_status,'')) IN ('cancelled','refunded')
               OR lower(COALESCE(NEW.payment_status,'')) = 'refunded')
              AND (lower(COALESCE(OLD.order_status,'')) IS DISTINCT FROM lower(COALESCE(NEW.order_status,''))
                   OR lower(COALESCE(OLD.payment_status,'')) IS DISTINCT FROM lower(COALESCE(NEW.payment_status,'')));

  IF v_fulfilled THEN
    UPDATE pos_order_items
       SET status = 'ready'
     WHERE order_id = NEW.pos_order_id
       AND COALESCE(status,'') IN ('sent','accepted','preparing');

    UPDATE pos_order_items
       SET status = 'served',
           served_at = COALESCE(served_at, now())
     WHERE order_id = NEW.pos_order_id
       AND COALESCE(status,'') IN ('ready','cancel-pending');
    RETURN NEW;
  END IF;

  IF v_undone THEN
    PERFORM set_config('neo.delivery_reversal', 'on', true);

    UPDATE pos_order_items
       SET status = 'cancel-pending'
     WHERE order_id = NEW.pos_order_id
       AND COALESCE(status,'') IN ('sent','accepted','preparing','ready','served');

    UPDATE pos_order_items
       SET status = 'voided'
     WHERE order_id = NEW.pos_order_id
       AND COALESCE(status,'') = 'cancel-pending';

    UPDATE pos_order_items
       SET status = 'cancelled'
     WHERE order_id = NEW.pos_order_id
       AND COALESCE(status,'') = 'draft';

    PERFORM set_config('neo.delivery_reversal', 'off', true);
  END IF;

  RETURN NEW;
END;
$function$;