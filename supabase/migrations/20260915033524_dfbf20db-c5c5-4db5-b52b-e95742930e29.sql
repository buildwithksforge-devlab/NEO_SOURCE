-- 1. Retire folios left open after departure (balances untouched, audit recorded)
WITH stale AS (
  SELECT f.id, f.organization_id, f.branch_id, f.folio_number, f.status, f.balance
    FROM public.folios f
    JOIN public.reservations r ON r.id = f.reservation_id
   WHERE r.status = 'checked-out' AND f.status <> 'closed' AND f.balance <> 0
), logged AS (
  INSERT INTO public.audit_logs (organization_id, branch_id, user_name, action, module, record_id, previous_value, new_value, reason)
  SELECT organization_id, branch_id, 'System (release retirement)', 'folio.retired', 'finance', id::text,
         jsonb_build_object('status', status, 'balance', balance),
         jsonb_build_object('status', 'closed', 'balance', balance),
         'Retired 2026-09-15: historic folio left open after departure; balance preserved for receivables follow-up.'
    FROM stale
  RETURNING 1
)
UPDATE public.folios f
   SET status = 'closed', closed_at = COALESCE(f.closed_at, now()), updated_at = now()
  FROM stale s WHERE f.id = s.id;

-- 2. Retire maintenance jobs stuck without a technician, and closed jobs never verified
WITH stale AS (
  SELECT id, organization_id, branch_id, work_order_number, status
    FROM public.maintenance_work_orders
   WHERE (status IN ('assigned','in-progress') AND assigned_to IS NULL)
      OR (status = 'closed' AND verified_by IS NULL)
), logged AS (
  INSERT INTO public.audit_logs (organization_id, branch_id, user_name, action, module, record_id, previous_value, new_value, reason)
  SELECT organization_id, branch_id, 'System (release retirement)', 'work-order.retired', 'maintenance', id::text,
         jsonb_build_object('status', status),
         jsonb_build_object('status', 'cancelled'),
         'Retired 2026-09-15: seeded or certification work order with no technician or verifier; cancelled rather than attributed.'
    FROM stale
  RETURNING 1
)
UPDATE public.maintenance_work_orders w
   SET status = 'cancelled',
       completion_notes = COALESCE(NULLIF(w.completion_notes, ''), '') ||
         CASE WHEN COALESCE(w.completion_notes,'') = '' THEN '' ELSE E'\n' END ||
         'Retired 2026-09-15: no technician or verifier on record.',
       updated_at = now()
  FROM stale s WHERE w.id = s.id;

-- 3. Banquet event order for every confirmed booking
CREATE OR REPLACE FUNCTION public.neo_beo_ensure_for_booking(_booking uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  b public.event_bookings;
  existing uuid;
  new_id uuid;
BEGIN
  SELECT * INTO b FROM public.event_bookings WHERE id = _booking;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT id INTO existing FROM public.banquet_event_orders WHERE booking_id = b.id LIMIT 1;
  IF existing IS NOT NULL THEN RETURN existing; END IF;

  INSERT INTO public.banquet_event_orders (
    organization_id, branch_id, booking_id, beo_number, revision, status,
    start_at, end_at, guaranteed_guests, change_summary
  ) VALUES (
    b.organization_id, b.branch_id, b.id,
    'BEO-' || COALESCE(b.event_reference, left(b.id::text, 8)), 1, 'draft',
    b.start_at, b.end_at, b.expected_guests,
    'Created automatically when the booking was confirmed. Complete setup, menu and department instructions before publishing.'
  )
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$;

REVOKE ALL ON FUNCTION public.neo_beo_ensure_for_booking(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_beo_ensure_for_booking(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_beo_on_booking_confirmed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IN ('confirmed','in-planning','ready','in-progress','completed') THEN
    PERFORM public.neo_beo_ensure_for_booking(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_neo_beo_on_booking_confirmed ON public.event_bookings;
CREATE TRIGGER trg_neo_beo_on_booking_confirmed
AFTER INSERT OR UPDATE OF status ON public.event_bookings
FOR EACH ROW EXECUTE FUNCTION public.neo_beo_on_booking_confirmed();

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT b.id FROM public.event_bookings b
            WHERE b.status IN ('confirmed','in-planning','ready','in-progress','completed')
              AND NOT EXISTS (SELECT 1 FROM public.banquet_event_orders o WHERE o.booking_id = b.id)
  LOOP
    PERFORM public.neo_beo_ensure_for_booking(r.id);
  END LOOP;
END $$;

-- 4. A shortage on an active requisition raises a purchase request automatically
CREATE OR REPLACE FUNCTION public.neo_requisition_shortage_to_purchase()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  pr_id uuid;
  doc text;
BEGIN
  IF COALESCE(NEW.shortage_notes, '') = '' OR NEW.purchase_request_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.status IN ('rejected','cancelled','closed') THEN
    RETURN NEW;
  END IF;

  BEGIN
    SELECT public.next_document_number('purchase-request') INTO doc;
  EXCEPTION WHEN OTHERS THEN doc := NULL;
  END;

  INSERT INTO public.purchase_requests (
    organization_id, branch_id, department_id, request_number, title,
    justification, source, source_reference, status, priority, requested_by
  ) VALUES (
    NEW.organization_id, NEW.branch_id, NEW.department_id, doc,
    'Stores shortage — ' || COALESCE(NEW.request_number, 'requisition'),
    NEW.shortage_notes, 'stores-shortage', NEW.request_number, 'submitted',
    COALESCE(NEW.priority, 'normal'), NEW.requested_by
  )
  RETURNING id INTO pr_id;

  NEW.purchase_request_id := pr_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_neo_requisition_shortage_to_purchase ON public.internal_requisitions;
CREATE TRIGGER trg_neo_requisition_shortage_to_purchase
BEFORE INSERT OR UPDATE OF shortage_notes ON public.internal_requisitions
FOR EACH ROW EXECUTE FUNCTION public.neo_requisition_shortage_to_purchase();

-- 5. Retire the certification test departments
UPDATE public.departments
   SET active = false, department_status = 'archived', updated_at = now()
 WHERE name ILIKE 'CERT TEST Department%';
