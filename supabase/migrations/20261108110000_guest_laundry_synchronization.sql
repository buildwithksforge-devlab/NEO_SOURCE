-- Code-only repair. Does not advance or post any existing laundry order.
BEGIN;
DO $guard$ BEGIN
 IF to_regprocedure('public.neo_laundry_completion_guard()') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.neo_laundry_completion_guard()'))) IS DISTINCT FROM 'bca04ff7823b1a89e3757d8437b91b65' THEN RAISE EXCEPTION 'Laundry definition differs: neo_laundry_completion_guard(); inspect before installation'; END IF;
 IF to_regprocedure('public.neo_sync_guest_laundry_from_batch()') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.neo_sync_guest_laundry_from_batch()'))) IS DISTINCT FROM '4c67521489083db30da3c0fa2adba596' THEN RAISE EXCEPTION 'Laundry definition differs: neo_sync_guest_laundry_from_batch(); inspect before installation'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.guest_laundry_orders') AND tgfoid=to_regprocedure('public.neo_laundry_completion_guard()') AND tgenabled IN ('O','A'))
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.laundry_batches') AND tgfoid=to_regprocedure('public.neo_sync_guest_laundry_from_batch()') AND tgenabled IN ('O','A'))
 THEN RAISE EXCEPTION 'Laundry lifecycle triggers are missing or disabled; inspect before installation'; END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.neo_laundry_completion_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _system_transition boolean := coalesce(current_setting('neo.laundry_system_transition', true),'off') = 'on';
  _batch_status text;
BEGIN
  IF NEW.status IN ('received','washing','drying','ironing','quality-check','packaged',
                    'ready-for-delivery','delivered','completed','closed') THEN
    SELECT b.status INTO _batch_status
      FROM public.laundry_batches b
     WHERE b.organization_id = NEW.organization_id
       AND b.branch_id = NEW.branch_id
       AND b.guest_order_id = NEW.id
       AND b.batch_kind = 'guest'
     ORDER BY b.created_at DESC, b.id DESC
     LIMIT 1;

    IF _batch_status IS NULL THEN
      RAISE EXCEPTION 'Receive this guest laundry into a guest batch before moving it into processing or delivery.'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.status IN ('delivered','completed','closed') THEN
    IF coalesce(btrim(NEW.laundry_number), '') = '' THEN
      RAISE EXCEPTION 'This laundry order has no order number yet, so it cannot be completed.'
        USING ERRCODE = '23514';
    END IF;
    IF coalesce(NEW.total, 0) <= 0 THEN
      RAISE EXCEPTION 'This laundry order has no priced items, so it cannot be completed. Price the items first.'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.customer_id IS NULL AND NEW.reservation_id IS NULL THEN
      RAISE EXCEPTION 'Link the laundry to its customer or stay before delivery.'
        USING ERRCODE = '23514';
    END IF;
    IF _batch_status <> 'completed' THEN
      RAISE EXCEPTION 'Reconcile the guest garment batch before confirming delivery.'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.delivered_at IS NULL OR NEW.delivery_confirmed_by IS NULL THEN
      RAISE EXCEPTION 'Laundry delivery needs the delivery time and confirming staff member.'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.status IN ('completed','closed') AND COALESCE(NEW.posting_status,'unposted') <> 'posted' THEN
    RAISE EXCEPTION 'Post the delivered laundry charge before closing the laundry order.'
      USING ERRCODE = '23514';
  END IF;

  -- Batch synchronisation is the canonical writer for processing states.  All
  -- other callers have a deliberately small transition graph.
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status AND NOT _system_transition THEN
    IF NOT (
      (OLD.status IN ('requested','awaiting-collection') AND NEW.status IN ('collected','on-hold','cancelled')) OR
      (OLD.status = 'collected' AND NEW.status IN ('received','on-hold','disputed','cancelled')) OR
      (OLD.status = 'ready-for-delivery' AND NEW.status IN ('delivered','on-hold','disputed')) OR
      (OLD.status = 'delivered' AND NEW.status IN ('completed','disputed')) OR
      (OLD.status = 'on-hold' AND NEW.status IN ('requested','awaiting-collection','collected','disputed','cancelled')) OR
      (OLD.status = 'disputed' AND NEW.status IN ('on-hold','ready-for-delivery','cancelled'))
    ) THEN
      RAISE EXCEPTION 'Laundry status % cannot move directly to %. Use the guest batch workflow for processing states.',
        OLD.status, NEW.status USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.neo_sync_guest_laundry_from_batch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _target text;
  _prior text := coalesce(current_setting('neo.laundry_system_transition',true),'off');
  _latest uuid;
BEGIN
  IF NEW.batch_kind IS DISTINCT FROM 'guest' OR NEW.guest_order_id IS NULL THEN
    RETURN NEW;
  END IF;

  _target := CASE NEW.status
    WHEN 'received' THEN 'received'
    WHEN 'washing' THEN 'washing'
    WHEN 'drying' THEN 'drying'
    WHEN 'finishing' THEN 'quality-check'
    WHEN 'ready' THEN 'ready-for-delivery'
    WHEN 'handed-over' THEN 'ready-for-delivery'
    WHEN 'completed' THEN 'ready-for-delivery'
    ELSE NULL
  END;

  IF _target IS NULL THEN RETURN NEW; END IF;
  SELECT b.id INTO _latest FROM public.laundry_batches b
   WHERE b.organization_id=NEW.organization_id AND b.branch_id=NEW.branch_id
    AND b.guest_order_id=NEW.guest_order_id AND b.batch_kind='guest'
   ORDER BY b.created_at DESC,b.id DESC LIMIT 1;
  IF NEW.id IS DISTINCT FROM _latest THEN RETURN NEW; END IF;

  PERFORM set_config('neo.laundry_system_transition','on',true);
  UPDATE public.guest_laundry_orders g
     SET status = _target,
         collected_at = CASE
           WHEN _target = 'received' AND g.collected_at IS NULL THEN now()
           ELSE g.collected_at
         END,
         updated_at = now()
   WHERE g.id = NEW.guest_order_id
     AND g.organization_id = NEW.organization_id
     AND g.branch_id = NEW.branch_id
     AND g.status NOT IN ('delivered','completed','closed','cancelled','on-hold','disputed')
     AND g.status IS DISTINCT FROM _target;

  PERFORM set_config('neo.laundry_system_transition',_prior,true);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('neo.laundry_system_transition',_prior,true);
  RAISE;
END;
$function$;
COMMIT;
