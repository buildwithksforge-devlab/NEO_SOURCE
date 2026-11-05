-- NEO P1.5B - GUEST LAUNDRY RESTORATION
-- REVIEW ONLY - DO NOT DEPLOY
--
-- Restore missing AFTER-delivery posting and batch synchronization.
-- Preserve the existing lifecycle and order advancement RPC.
-- No historical laundry records are modified directly.
-- Replace the older BEFORE-UPDATE laundry autopost. Calling Finance from a
-- BEFORE trigger can recursively update the same order. Final delivery is now
-- written first, then posting runs as an AFTER trigger (and the explicit RPC
-- retry remains idempotent).
DROP TRIGGER IF EXISTS guest_laundry_orders_autopost ON public.guest_laundry_orders;

CREATE OR REPLACE FUNCTION public.neo_laundry_autopost_after_delivery()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _res jsonb;
BEGIN
  IF NEW.status IN ('delivered','completed','closed')
     AND COALESCE(NEW.posting_status,'unposted') <> 'posted'
     AND (NEW.status IS DISTINCT FROM OLD.status
          OR NEW.total IS DISTINCT FROM OLD.total
          OR NEW.folio_id IS DISTINCT FROM OLD.folio_id) THEN
    _res := public.neo_finance_post_source('laundry',NEW.id,true);
    IF NOT COALESCE((_res->>'ok')::boolean,false) THEN
      UPDATE public.guest_laundry_orders
         SET posting_status='blocked',
             discrepancy_notes=concat_ws(' ',NULLIF(discrepancy_notes,''),
               COALESCE(_res->>'detail',_res->>'reason','Laundry finance posting failed.'))
       WHERE id=NEW.id AND COALESCE(posting_status,'unposted') <> 'posted';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS neo_laundry_autopost_after_delivery_trg ON public.guest_laundry_orders;
CREATE TRIGGER neo_laundry_autopost_after_delivery_trg
AFTER UPDATE OF status,total,folio_id ON public.guest_laundry_orders
FOR EACH ROW EXECUTE FUNCTION public.neo_laundry_autopost_after_delivery();

-- The guest-order display state follows the real guest batch.  Completing a
-- laundry batch means processing/reconciliation is complete; it does NOT mean
-- the guest has received the garments, so the order remains ready-for-delivery.
CREATE OR REPLACE FUNCTION public.neo_sync_guest_laundry_from_batch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _target text;
BEGIN
  IF NEW.batch_kind <> 'guest' OR NEW.guest_order_id IS NULL THEN
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
     AND g.status NOT IN ('delivered','completed','closed','cancelled')
     AND g.status IS DISTINCT FROM _target;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS neo_sync_guest_laundry_from_batch_trg ON public.laundry_batches;
CREATE TRIGGER neo_sync_guest_laundry_from_batch_trg
AFTER INSERT OR UPDATE OF status ON public.laundry_batches
FOR EACH ROW EXECUTE FUNCTION public.neo_sync_guest_laundry_from_batch();


