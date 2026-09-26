-- Final certification: guest laundry lifecycle must converge through the actual
-- laundry batch before a guest order can be delivered.  A browser status edit
-- must never be enough to manufacture processing or delivery evidence.

CREATE OR REPLACE FUNCTION public.neo_laundry_completion_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _system_transition boolean := current_setting('neo.laundry_system_transition', true) = 'on';
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
     ORDER BY b.created_at DESC
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

DROP TRIGGER IF EXISTS neo_laundry_completion_guard_trg ON public.guest_laundry_orders;
CREATE TRIGGER neo_laundry_completion_guard_trg
BEFORE INSERT OR UPDATE ON public.guest_laundry_orders
FOR EACH ROW EXECUTE FUNCTION public.neo_laundry_completion_guard();


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

-- Final guest handover is explicit, actor-attributed and idempotent. Processing
-- is not advanced here: it must already have converged through the guest batch.
CREATE OR REPLACE FUNCTION public.neo_laundry_order_advance(
  _order uuid,
  _status text,
  _note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _row public.guest_laundry_orders%ROWTYPE;
  _posting jsonb;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'No organisation context'; END IF;
  IF NOT (
    public.has_permission('laundry','orders','edit') OR
    public.has_permission('laundry','orders','approve') OR
    public.is_org_admin()
  ) THEN
    RAISE EXCEPTION 'Not permitted to update guest laundry' USING ERRCODE='42501';
  END IF;

  SELECT * INTO _row
    FROM public.guest_laundry_orders
   WHERE id=_order AND organization_id=_org
   FOR UPDATE;
  IF _row.id IS NULL THEN RAISE EXCEPTION 'Laundry order not found'; END IF;

  IF _status = _row.status THEN
    RETURN jsonb_build_object('ok',true,'idempotent',true,'status',_row.status,
      'posting_status',_row.posting_status);
  END IF;

  IF _status = 'delivered' THEN
    UPDATE public.guest_laundry_orders
       SET status='delivered',
           delivered_at=COALESCE(delivered_at,now()),
           delivery_confirmed_by=COALESCE(delivery_confirmed_by,auth.uid()),
           discrepancy_notes=concat_ws(' ',NULLIF(discrepancy_notes,''),NULLIF(btrim(_note),'')),
           updated_at=now()
     WHERE id=_order;

    -- Delivery and accounting are separate facts.  Retry the canonical Finance
    -- posting and leave the order visibly blocked when the guest/folio/payment
    -- context is not sufficient rather than pretending it was billed.
    _posting := public.neo_laundry_retry_posting(_order);

    SELECT * INTO _row FROM public.guest_laundry_orders WHERE id=_order;
    PERFORM public.log_audit_event(
      _org,'laundry.order.delivered','laundry',_order::text,
      jsonb_build_object('status','ready-for-delivery'),
      jsonb_build_object('status',_row.status,'delivered_at',_row.delivered_at,
                         'posting_status',_row.posting_status,'posting',_posting),
      COALESCE(NULLIF(btrim(_note),''),'Guest laundry handed back'));

    RETURN jsonb_build_object('ok',true,'status',_row.status,
      'delivered_at',_row.delivered_at,'posting_status',_row.posting_status,
      'posting',_posting);
  END IF;

  IF _status = 'completed' THEN
    UPDATE public.guest_laundry_orders
       SET status='completed',updated_at=now()
     WHERE id=_order;
    RETURN jsonb_build_object('ok',true,'status','completed');
  END IF;

  UPDATE public.guest_laundry_orders
     SET status=_status,
         collected_at=CASE WHEN _status='collected' AND collected_at IS NULL THEN now() ELSE collected_at END,
         discrepancy_notes=CASE WHEN _status IN ('on-hold','disputed')
           THEN concat_ws(' ',NULLIF(discrepancy_notes,''),NULLIF(btrim(_note),''))
           ELSE discrepancy_notes END,
         updated_at=now()
   WHERE id=_order;

  RETURN jsonb_build_object('ok',true,'status',_status);
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_laundry_order_advance(uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_laundry_order_advance(uuid,text,text) TO authenticated, service_role;
