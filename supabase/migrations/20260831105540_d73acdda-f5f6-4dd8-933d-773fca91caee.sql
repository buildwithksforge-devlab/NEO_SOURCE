CREATE OR REPLACE FUNCTION public.neo_guest_canonical_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_module text; v_ref text; v_amount numeric := 0; v_currency text := 'KES';
  v_owner text; v_next text; v_state text; v_event text; v_branch uuid; v_customer uuid;
BEGIN
  IF TG_TABLE_NAME = 'delivery_orders' THEN
    v_module := 'delivery';
    v_ref := NEW.order_number;
    v_amount := coalesce(NEW.grand_total, 0);
    v_branch := NEW.branch_id;
    v_customer := NEW.customer_id;
    v_state := coalesce(NEW.order_status, 'pending');
    IF NEW.fulfilment_type = 'room-service' THEN
      v_owner := 'Kitchen'; v_next := 'Prepare and deliver to the room';
      v_event := 'guest.room_service_placed';
    ELSE
      v_owner := 'Delivery'; v_next := 'Accept the order and assign a rider';
      v_event := 'guest.delivery_order_placed';
    END IF;
  ELSIF TG_TABLE_NAME = 'guest_requests' THEN
    v_module := 'guest-services';
    v_ref := coalesce(NEW.request_number, NEW.id::text);
    v_branch := NEW.branch_id;
    v_customer := NEW.customer_id;
    v_state := coalesce(NEW.status, 'new');
    v_owner := initcap(replace(coalesce(NEW.category, 'front-office'), '-', ' '));
    v_next := 'Acknowledge the guest request and assign it';
    v_event := 'guest.request_raised';
  ELSE
    RETURN NEW;
  END IF;

  PERFORM public.neo_canonical_transaction_set(
    _org := NEW.organization_id, _branch := v_branch, _module := v_module,
    _source := NEW.id, _reference := v_ref,
    _operational := v_state, _financial := 'pending',
    _amount := round(coalesce(v_amount, 0), 2), _currency := v_currency,
    _idempotency := v_module || ':' || NEW.id::text, _actor := auth.uid(),
    _owner := v_owner, _next_action := v_next, _blocker := NULL,
    _journal := NULL, _receipt := NULL,
    _downstream := jsonb_build_object(v_event, 'emitted'),
    _metadata := jsonb_build_object('origin', 'guest', 'customer_id', v_customer));

  PERFORM public.emit_domain_event(
    NEW.organization_id, v_branch, v_event, v_module, NEW.id,
    jsonb_build_object('reference', v_ref, 'amount', round(coalesce(v_amount,0),2), 'currency', v_currency),
    v_module || ':' || NEW.id::text || ':created', v_customer);

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- A tracking failure must never silently lose the guest's order.
  RAISE WARNING 'guest canonical sync failed for % %: %', TG_TABLE_NAME, NEW.id, SQLERRM;
  RETURN NEW;
END $$;

REVOKE EXECUTE ON FUNCTION public.neo_guest_canonical_sync() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guest_canonical_delivery ON public.delivery_orders;
CREATE TRIGGER trg_guest_canonical_delivery
AFTER INSERT ON public.delivery_orders
FOR EACH ROW EXECUTE FUNCTION public.neo_guest_canonical_sync();

DROP TRIGGER IF EXISTS trg_guest_canonical_request ON public.guest_requests;
CREATE TRIGGER trg_guest_canonical_request
AFTER INSERT ON public.guest_requests
FOR EACH ROW EXECUTE FUNCTION public.neo_guest_canonical_sync();

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT d.* FROM public.delivery_orders d
            WHERE NOT EXISTS (SELECT 1 FROM public.canonical_transaction_states c
                               WHERE c.organization_id = d.organization_id
                                 AND c.idempotency_key = 'delivery:' || d.id::text)
  LOOP
    PERFORM set_config('neo.system_org', r.organization_id::text, true);
    PERFORM public.neo_canonical_transaction_set(
      _org := r.organization_id, _branch := r.branch_id, _module := 'delivery',
      _source := r.id, _reference := r.order_number,
      _operational := coalesce(r.order_status, 'pending'), _financial := 'pending',
      _amount := round(coalesce(r.grand_total, 0), 2), _currency := 'KES',
      _idempotency := 'delivery:' || r.id::text, _actor := NULL,
      _owner := CASE WHEN r.fulfilment_type = 'room-service' THEN 'Kitchen' ELSE 'Delivery' END,
      _next_action := 'Review the guest order and progress it', _blocker := NULL,
      _journal := NULL, _receipt := NULL, _downstream := '{}'::jsonb,
      _metadata := jsonb_build_object('origin', 'guest', 'customer_id', r.customer_id));
  END LOOP;

  FOR r IN SELECT g.* FROM public.guest_requests g
            WHERE NOT EXISTS (SELECT 1 FROM public.canonical_transaction_states c
                               WHERE c.organization_id = g.organization_id
                                 AND c.idempotency_key = 'guest-services:' || g.id::text)
  LOOP
    PERFORM set_config('neo.system_org', r.organization_id::text, true);
    PERFORM public.neo_canonical_transaction_set(
      _org := r.organization_id, _branch := r.branch_id, _module := 'guest-services',
      _source := r.id, _reference := coalesce(r.request_number, r.id::text),
      _operational := coalesce(r.status, 'new'), _financial := 'not-applicable',
      _amount := 0, _currency := 'KES',
      _idempotency := 'guest-services:' || r.id::text, _actor := NULL,
      _owner := initcap(replace(coalesce(r.category, 'front-office'), '-', ' ')),
      _next_action := 'Acknowledge the guest request and assign it', _blocker := NULL,
      _journal := NULL, _receipt := NULL, _downstream := '{}'::jsonb,
      _metadata := jsonb_build_object('origin', 'guest', 'customer_id', r.customer_id));
  END LOOP;
END $$;