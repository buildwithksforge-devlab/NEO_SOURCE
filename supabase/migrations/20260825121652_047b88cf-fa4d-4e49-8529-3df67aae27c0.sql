-- Lifecycle audit: does every operation reach its real end state?
CREATE OR REPLACE FUNCTION public.neo_lifecycle_audit(_branch uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  org uuid := public.current_org_id();
  rows jsonb := '[]'::jsonb;
  b uuid := _branch;

  FUNCTION_PLACEHOLDER text;
BEGIN
  IF org IS NULL THEN
    RETURN jsonb_build_object('generated_at', now(), 'status', 'unknown', 'modules', '[]'::jsonb);
  END IF;

  WITH m AS (
    SELECT 'front-office' AS module, 'Reservation → stay → departure' AS label, '/pms/reservations' AS route,
           (SELECT count(*) FROM reservations r WHERE r.organization_id = org AND (b IS NULL OR r.branch_id = b)) AS total,
           (SELECT count(*) FROM reservations r WHERE r.organization_id = org AND (b IS NULL OR r.branch_id = b)
              AND r.status IN ('checked-out','cancelled','no-show')) AS complete,
           (SELECT count(*) FROM reservations r WHERE r.organization_id = org AND (b IS NULL OR r.branch_id = b)
              AND r.status = 'checked-in' AND r.departure_date < current_date) AS incomplete,
           'A departed reservation is still shown in house.' AS detail
    UNION ALL
    SELECT 'guest-ledger', 'Folio → settlement → close', '/finance/folios',
           (SELECT count(*) FROM folios f WHERE f.organization_id = org AND (b IS NULL OR f.branch_id = b)),
           (SELECT count(*) FROM folios f WHERE f.organization_id = org AND (b IS NULL OR f.branch_id = b)
              AND f.status IN ('closed','settled','void')),
           (SELECT count(*) FROM folios f WHERE f.organization_id = org AND (b IS NULL OR f.branch_id = b)
              AND f.status = 'open'
              AND (EXISTS (SELECT 1 FROM stays s WHERE s.id = f.stay_id AND s.status = 'checked-out')
                OR EXISTS (SELECT 1 FROM reservations r WHERE r.id = f.reservation_id AND r.status = 'checked-out'))),
           'The guest has departed but the folio is still open.'
    UNION ALL
    SELECT 'point-of-sale', 'Order → settle → Finance', '/pos/orders',
           (SELECT count(*) FROM pos_orders o WHERE o.organization_id = org AND (b IS NULL OR o.branch_id = b)),
           (SELECT count(*) FROM pos_orders o WHERE o.organization_id = org AND (b IS NULL OR o.branch_id = b)
              AND (o.status IN ('void','voided','cancelled') OR o.folio_post_status = 'posted')),
           (SELECT count(*) FROM pos_orders o WHERE o.organization_id = org AND (b IS NULL OR o.branch_id = b)
              AND o.status IN ('closed','paid','settled','completed')
              AND o.folio_post_status IS DISTINCT FROM 'posted'),
           'A finalised sale has not reached the general ledger.'
    UNION ALL
    SELECT 'kitchen', 'Ticket → prepare → served', '/kitchen/tickets',
           (SELECT count(*) FROM station_tickets t WHERE t.organization_id = org AND (b IS NULL OR t.branch_id = b)),
           (SELECT count(*) FROM station_tickets t WHERE t.organization_id = org AND (b IS NULL OR t.branch_id = b)
              AND t.status IN ('served','completed','collected','cancelled','voided')),
           (SELECT count(*) FROM station_tickets t WHERE t.organization_id = org AND (b IS NULL OR t.branch_id = b)
              AND ((t.status IN ('served','completed','collected') AND t.completed_at IS NULL)
                OR (t.status IN ('new','accepted','preparing','ready') AND t.created_at < now() - interval '1 day'))),
           'A ticket never recorded when it finished, or is still open from a previous service.'
    UNION ALL
    SELECT 'housekeeping', 'Job → clean → inspected', '/housekeeping/jobs',
           (SELECT count(*) FROM housekeeping_jobs h WHERE h.organization_id = org AND (b IS NULL OR h.branch_id = b)),
           (SELECT count(*) FROM housekeeping_jobs h WHERE h.organization_id = org AND (b IS NULL OR h.branch_id = b)
              AND h.status IN ('completed','cancelled','skipped')),
           (SELECT count(*) FROM housekeeping_jobs h WHERE h.organization_id = org AND (b IS NULL OR h.branch_id = b)
              AND h.status NOT IN ('completed','cancelled','skipped')
              AND COALESCE(h.due_at, h.created_at) < now() - interval '1 day'),
           'A cleaning job is past its due time and has not been completed.'
    UNION ALL
    SELECT 'laundry', 'Guest order → deliver → bill', '/laundry',
           (SELECT count(*) FROM guest_laundry_orders l WHERE l.organization_id = org AND (b IS NULL OR l.branch_id = b)),
           (SELECT count(*) FROM guest_laundry_orders l WHERE l.organization_id = org AND (b IS NULL OR l.branch_id = b)
              AND (l.status = 'cancelled' OR l.posting_status = 'posted')),
           (SELECT count(*) FROM guest_laundry_orders l WHERE l.organization_id = org AND (b IS NULL OR l.branch_id = b)
              AND ((l.status IN ('completed','delivered','closed') AND COALESCE(l.posting_status,'unposted') <> 'posted')
                OR (l.status NOT IN ('completed','delivered','closed','cancelled') AND l.created_at < now() - interval '2 days'))),
           'A returned guest order has not been charged, or an order is still in the laundry.'
    UNION ALL
    SELECT 'linen', 'Linen batch → wash → return', '/laundry/linen',
           (SELECT count(*) FROM laundry_batches lb WHERE lb.organization_id = org AND (b IS NULL OR lb.branch_id = b)),
           (SELECT count(*) FROM laundry_batches lb WHERE lb.organization_id = org AND (b IS NULL OR lb.branch_id = b)
              AND lb.status IN ('completed','returned','cancelled')),
           (SELECT count(*) FROM laundry_batches lb WHERE lb.organization_id = org AND (b IS NULL OR lb.branch_id = b)
              AND lb.status NOT IN ('completed','returned','cancelled') AND lb.created_at < now() - interval '2 days'),
           'A linen batch has not come back from the wash cycle.'
    UNION ALL
    SELECT 'delivery', 'Order → dispatch → delivered & paid', '/delivery/orders',
           (SELECT count(*) FROM delivery_orders d WHERE d.organization_id = org AND (b IS NULL OR d.branch_id = b)),
           (SELECT count(*) FROM delivery_orders d WHERE d.organization_id = org AND (b IS NULL OR d.branch_id = b)
              AND (d.order_status IN ('delivered','completed') AND d.payment_status = 'paid' OR d.order_status IN ('cancelled','rejected'))),
           (SELECT count(*) FROM delivery_orders d WHERE d.organization_id = org AND (b IS NULL OR d.branch_id = b)
              AND ((d.order_status IN ('delivered','completed') AND d.payment_status <> 'paid')
                OR (d.order_status NOT IN ('delivered','completed','cancelled','rejected') AND d.created_at < now() - interval '1 day'))),
           'A delivered order is unpaid, or a rider run never closed.'
    UNION ALL
    SELECT 'events', 'Booking → deliver → bill', '/events/bookings',
           (SELECT count(*) FROM event_bookings e WHERE e.organization_id = org AND (b IS NULL OR e.branch_id = b)),
           (SELECT count(*) FROM event_bookings e WHERE e.organization_id = org AND (b IS NULL OR e.branch_id = b)
              AND e.status IN ('completed','closed','cancelled')),
           (SELECT count(*) FROM event_bookings e WHERE e.organization_id = org AND (b IS NULL OR e.branch_id = b)
              AND ((e.status = 'confirmed' AND e.event_date < current_date)
                OR (e.status = 'completed' AND NOT EXISTS (SELECT 1 FROM event_billing_items i WHERE i.booking_id = e.id)))),
           'An event has passed without being closed off, or was closed without billing.'
    UNION ALL
    SELECT 'stores', 'Requisition → issue → receipt', '/stores/requisitions',
           (SELECT count(*) FROM internal_requisitions q WHERE q.organization_id = org AND (b IS NULL OR q.branch_id = b)),
           (SELECT count(*) FROM internal_requisitions q WHERE q.organization_id = org AND (b IS NULL OR q.branch_id = b)
              AND (q.received_at IS NOT NULL OR q.status IN ('cancelled','rejected','closed'))),
           (SELECT count(*) FROM internal_requisitions q WHERE q.organization_id = org AND (b IS NULL OR q.branch_id = b)
              AND q.status NOT IN ('cancelled','rejected','closed') AND q.received_at IS NULL
              AND q.created_at < now() - interval '2 days'),
           'Stock left the store but the department never confirmed receipt.'
    UNION ALL
    SELECT 'procurement', 'Request → order → receive', '/procurement/orders',
           (SELECT count(*) FROM purchase_requests p WHERE p.organization_id = org AND (b IS NULL OR p.branch_id = b)),
           (SELECT count(*) FROM purchase_requests p WHERE p.organization_id = org AND (b IS NULL OR p.branch_id = b)
              AND p.status IN ('ordered','received','closed','rejected','cancelled')),
           (SELECT count(*) FROM purchase_requests p WHERE p.organization_id = org AND (b IS NULL OR p.branch_id = b)
              AND p.status = 'approved' AND NOT EXISTS (SELECT 1 FROM purchase_orders o WHERE o.request_id = p.id))
           + (SELECT count(*) FROM purchase_orders o WHERE o.organization_id = org AND (b IS NULL OR o.branch_id = b)
              AND o.status IN ('sent','acknowledged','partially-received')
              AND o.created_at < now() - interval '30 days'),
           'An approved request was never ordered, or an order was never fully received.'
    UNION ALL
    SELECT 'payments', 'Payment → confirm → journal', '/finance/payments',
           (SELECT count(*) FROM payments p WHERE p.organization_id = org AND (b IS NULL OR p.branch_id = b)),
           (SELECT count(*) FROM payments p WHERE p.organization_id = org AND (b IS NULL OR p.branch_id = b)
              AND (p.posted_journal_id IS NOT NULL OR p.status IN ('void','voided','failed','cancelled'))),
           (SELECT count(*) FROM payments p WHERE p.organization_id = org AND (b IS NULL OR p.branch_id = b)
              AND p.status IN ('confirmed','completed','paid','captured') AND p.posted_journal_id IS NULL),
           'Money was received but never recognised in the ledger.'
    UNION ALL
    SELECT 'finance', 'Journal → post → period close', '/finance/journals',
           (SELECT count(*) FROM journal_entries j WHERE j.organization_id = org AND (b IS NULL OR j.branch_id = b)),
           (SELECT count(*) FROM journal_entries j WHERE j.organization_id = org AND (b IS NULL OR j.branch_id = b)
              AND j.status IN ('posted','reversed')),
           (SELECT count(*) FROM journal_entries j WHERE j.organization_id = org AND (b IS NULL OR j.branch_id = b)
              AND j.status NOT IN ('posted','reversed','void') AND j.created_at < now() - interval '1 day'),
           'A journal is still a draft and is not in the accounts.'
    UNION ALL
    SELECT 'crm', 'Feedback → respond → resolve', '/crm/feedback',
           (SELECT count(*) FROM customer_feedback c WHERE c.organization_id = org AND (b IS NULL OR c.branch_id = b)),
           (SELECT count(*) FROM customer_feedback c WHERE c.organization_id = org AND (b IS NULL OR c.branch_id = b)
              AND c.status IN ('resolved','closed')),
           (SELECT count(*) FROM customer_feedback c WHERE c.organization_id = org AND (b IS NULL OR c.branch_id = b)
              AND c.status NOT IN ('resolved','closed')
              AND COALESCE(c.resolution_due_at, c.received_at + interval '3 days') < now()),
           'Guest feedback is past its resolution promise.'
    UNION ALL
    SELECT 'human-resources', 'Exit → clearance → offboarded', '/hr/employees',
           (SELECT count(*) FROM employee_exit_clearances x WHERE x.organization_id = org),
           (SELECT count(*) FROM employee_exit_clearances x WHERE x.organization_id = org AND x.status = 'completed'),
           (SELECT count(*) FROM employee_exit_clearances x WHERE x.organization_id = org
              AND x.status <> 'completed' AND COALESCE(x.last_working_day, x.notice_date) < current_date),
           'A leaver has passed their last working day without clearance.'
    UNION ALL
    SELECT 'maintenance', 'Fault → repair → verified', '/maintenance/work-orders',
           (SELECT count(*) FROM maintenance_work_orders w WHERE w.organization_id = org AND (b IS NULL OR w.branch_id = b)),
           (SELECT count(*) FROM maintenance_work_orders w WHERE w.organization_id = org AND (b IS NULL OR w.branch_id = b)
              AND w.status IN ('closed','cancelled')),
           (SELECT count(*) FROM maintenance_work_orders w WHERE w.organization_id = org AND (b IS NULL OR w.branch_id = b)
              AND ((w.status = 'completed' AND w.verified_at IS NULL AND w.completed_at < now() - interval '3 days')
                OR (w.status IN ('new','acknowledged','in-progress','on-hold') AND w.reported_at < now() - interval '7 days'))),
           'A repair was never verified, or a fault has been open for over a week.'
    UNION ALL
    SELECT 'marketing', 'Campaign → send → measure', '/marketing/campaigns',
           (SELECT count(*) FROM campaigns c WHERE c.organization_id = org AND (b IS NULL OR c.branch_id = b)),
           (SELECT count(*) FROM campaigns c WHERE c.organization_id = org AND (b IS NULL OR c.branch_id = b)
              AND c.status IN ('completed','sent','closed','cancelled')),
           (SELECT count(*) FROM campaigns c WHERE c.organization_id = org AND (b IS NULL OR c.branch_id = b)
              AND ((c.status = 'scheduled' AND c.send_at < now())
                OR (c.status IN ('running','live') AND c.ends_at < now()))),
           'A campaign passed its send or end time without completing.'
    UNION ALL
    SELECT 'approvals', 'Request → decide → execute', '/approvals',
           (SELECT count(*) FROM approval_requests a WHERE a.organization_id = org AND (b IS NULL OR a.branch_id = b)),
           (SELECT count(*) FROM approval_requests a WHERE a.organization_id = org AND (b IS NULL OR a.branch_id = b)
              AND a.status IN ('completed','rejected','cancelled','expired')),
           (SELECT count(*) FROM approval_requests a WHERE a.organization_id = org AND (b IS NULL OR a.branch_id = b)
              AND ((a.status IN ('pending_approval','pending','in_review') AND a.created_at < now() - interval '3 days')
                OR (a.status = 'completed' AND a.execution_status = 'not_started'))),
           'A decision is overdue, or an approved action was never carried out.'
    UNION ALL
    SELECT 'transport', 'Request → assign → complete', '/transport',
           (SELECT count(*) FROM transport_requests t WHERE t.organization_id = org AND (b IS NULL OR t.branch_id = b)),
           (SELECT count(*) FROM transport_requests t WHERE t.organization_id = org AND (b IS NULL OR t.branch_id = b)
              AND t.status IN ('completed','cancelled')),
           (SELECT count(*) FROM transport_requests t WHERE t.organization_id = org AND (b IS NULL OR t.branch_id = b)
              AND t.status NOT IN ('completed','cancelled') AND t.pickup_at < now() - interval '1 day'),
           'A journey is past its pick-up time and was never closed off.'
  )
  SELECT jsonb_agg(jsonb_build_object(
           'module', m.module, 'label', m.label, 'route', m.route,
           'total', m.total, 'complete', m.complete,
           'in_flight', greatest(m.total - m.complete - m.incomplete, 0),
           'incomplete', m.incomplete,
           'detail', m.detail,
           'status', CASE WHEN m.total = 0 THEN 'unknown' WHEN m.incomplete = 0 THEN 'ready' ELSE 'attention' END
         ) ORDER BY m.module)
    INTO rows FROM m;

  RETURN jsonb_build_object(
    'branch_id', b,
    'generated_at', now(),
    'incomplete', (SELECT COALESCE(sum((x->>'incomplete')::int), 0) FROM jsonb_array_elements(COALESCE(rows,'[]'::jsonb)) x),
    'status', CASE WHEN (SELECT COALESCE(sum((x->>'incomplete')::int), 0)
                           FROM jsonb_array_elements(COALESCE(rows,'[]'::jsonb)) x) = 0
                   THEN 'ready' ELSE 'attention' END,
    'modules', COALESCE(rows, '[]'::jsonb));
END $fn$;

REVOKE ALL ON FUNCTION public.neo_lifecycle_audit(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_lifecycle_audit(uuid) TO authenticated, service_role;