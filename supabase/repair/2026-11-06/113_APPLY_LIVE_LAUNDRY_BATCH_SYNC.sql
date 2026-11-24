-- Adapted to inspected live definitions. Code only: does not update existing laundry orders or charges.
BEGIN;
DO $guard$ BEGIN
IF md5(pg_get_functiondef(to_regprocedure('public.neo_laundry_completion_guard()'))) IS DISTINCT FROM '393383daaab3d3fc37cea64a2b9338a2' THEN RAISE EXCEPTION 'Live laundry definition differs: neo_laundry_completion_guard()'; END IF;
IF md5(pg_get_functiondef(to_regprocedure('public.neo_sync_guest_laundry_from_batch()'))) IS DISTINCT FROM '14656917e802f0cdf044f53df801d455' THEN RAISE EXCEPTION 'Live laundry definition differs: neo_sync_guest_laundry_from_batch()'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.neo_laundry_completion_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status IN ('delivered','completed','closed') THEN
    IF coalesce(btrim(NEW.laundry_number), '') = '' THEN
      RAISE EXCEPTION 'This laundry order has no order number yet, so it cannot be completed.'
        USING ERRCODE = '23514';
    END IF;
    IF coalesce(NEW.total, 0) <= 0 OR NEW.total::text IN ('NaN','Infinity','-Infinity') THEN
      RAISE EXCEPTION 'This laundry order has no priced items, so it cannot be completed. Price the items first.'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $function$
;
CREATE OR REPLACE FUNCTION public.neo_sync_guest_laundry_from_batch()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_target text;
  v_previous_setting text;
BEGIN
  IF NEW.batch_kind IS DISTINCT FROM 'guest' OR NEW.guest_order_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Reconcile all active guest batches, including the batch that just changed.
  -- The least advanced batch controls readiness; an older completion can finish
  -- the whole order once the other batches are complete, without a stale jump.
  SELECT CASE min(CASE b.status
    WHEN 'received' THEN 1 WHEN 'washing' THEN 2 WHEN 'drying' THEN 3
    WHEN 'finishing' THEN 4 WHEN 'ready' THEN 5 WHEN 'handed-over' THEN 5
    WHEN 'completed' THEN 5 ELSE 0 END)
    WHEN 1 THEN 'received' WHEN 2 THEN 'washing' WHEN 3 THEN 'drying'
    WHEN 4 THEN 'quality-check' WHEN 5 THEN 'ready-for-delivery' ELSE NULL END
    INTO v_target
    FROM public.laundry_batches b
   WHERE b.organization_id=NEW.organization_id
     AND b.branch_id IS NOT DISTINCT FROM NEW.branch_id
     AND b.guest_order_id=NEW.guest_order_id AND b.batch_kind='guest'
     AND b.status IS DISTINCT FROM 'cancelled';
  IF v_target IS NULL THEN RETURN NEW; END IF;

  v_previous_setting := current_setting('neo.laundry_system_transition', true);
  PERFORM set_config('neo.laundry_system_transition', 'on', true);
  BEGIN
    UPDATE public.guest_laundry_orders g
       SET status = v_target,
           collected_at = CASE
             WHEN v_target = 'received' AND g.collected_at IS NULL THEN now()
             ELSE g.collected_at
           END,
           updated_at = now()
     WHERE g.id = NEW.guest_order_id
       AND g.organization_id = NEW.organization_id
       AND g.branch_id IS NOT DISTINCT FROM NEW.branch_id
       AND g.status NOT IN ('delivered','completed','closed','cancelled','disputed','on-hold')
       AND g.status IS DISTINCT FROM v_target;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('neo.laundry_system_transition', coalesce(v_previous_setting, ''), true);
    RAISE;
  END;
  PERFORM set_config('neo.laundry_system_transition', coalesce(v_previous_setting, ''), true);
  RETURN NEW;
END;
$function$
;
COMMIT;
