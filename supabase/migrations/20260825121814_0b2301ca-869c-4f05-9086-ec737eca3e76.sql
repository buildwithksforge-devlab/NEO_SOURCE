CREATE OR REPLACE FUNCTION public.neo_lifecycle_finalise(_branch uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  org uuid := public.current_org_id();
  b uuid := _branch;
  r record;
  n_pos int := 0; n_tickets int := 0; n_folios int := 0; n_pay int := 0; n_laundry int := 0;
  res jsonb;
  out_json jsonb;
BEGIN
  IF org IS NULL THEN
    RAISE EXCEPTION 'No workspace in context';
  END IF;
  IF NOT (public.is_org_admin() OR public.has_permission('finance', 'post')) THEN
    RAISE EXCEPTION 'You do not have permission to finalise operations';
  END IF;

  -- Settled point-of-sale sales that never reached Finance
  FOR r IN
    SELECT id, folio_id FROM pos_orders o
     WHERE o.organization_id = org AND (b IS NULL OR o.branch_id = b)
       AND o.status IN ('closed','paid','settled','completed')
       AND o.folio_post_status IS DISTINCT FROM 'posted'
     ORDER BY o.created_at LIMIT 2000
  LOOP
    IF r.folio_id IS NOT NULL THEN
      res := public.neo_finance_post_source('pos', r.id, true);
    ELSE
      res := public.neo_finance_post_txn('pos_order', r.id, true);
    END IF;
    IF COALESCE((res->>'ok')::boolean, false) THEN n_pos := n_pos + 1; END IF;
  END LOOP;

  -- Guest laundry returned to the room but never charged
  FOR r IN
    SELECT id FROM guest_laundry_orders l
     WHERE l.organization_id = org AND (b IS NULL OR l.branch_id = b)
       AND l.status IN ('delivered','completed','closed')
       AND COALESCE(l.posting_status,'unposted') <> 'posted'
     ORDER BY l.created_at LIMIT 1000
  LOOP
    res := public.neo_finance_post_source('laundry', r.id, true);
    IF COALESCE((res->>'ok')::boolean, false) THEN n_laundry := n_laundry + 1; END IF;
  END LOOP;

  -- Confirmed money with no journal
  FOR r IN
    SELECT id FROM payments p
     WHERE p.organization_id = org AND (b IS NULL OR p.branch_id = b)
       AND p.status IN ('confirmed','completed','paid','captured')
       AND p.posted_journal_id IS NULL
     ORDER BY p.created_at LIMIT 2000
  LOOP
    res := public.neo_finance_post_txn('folio_payment', r.id, true);
    IF COALESCE((res->>'ok')::boolean, false) THEN n_pay := n_pay + 1; END IF;
  END LOOP;

  -- Kitchen tickets that were served without recording when
  UPDATE station_tickets t
     SET completed_at = COALESCE(t.ready_at, t.updated_at, t.created_at),
         ready_at = COALESCE(t.ready_at, t.updated_at, t.created_at)
   WHERE t.organization_id = org AND (b IS NULL OR t.branch_id = b)
     AND t.status IN ('served','completed','collected')
     AND t.completed_at IS NULL;
  GET DIAGNOSTICS n_tickets = ROW_COUNT;

  -- Zero-balance folios of departed guests
  UPDATE folios f
     SET status = 'settled',
         closed_at = COALESCE(f.closed_at, now()),
         updated_at = now()
   WHERE f.organization_id = org AND (b IS NULL OR f.branch_id = b)
     AND f.status = 'open'
     AND COALESCE(f.balance, 0) <= 0
     AND (EXISTS (SELECT 1 FROM stays s WHERE s.id = f.stay_id AND s.status = 'checked-out')
       OR EXISTS (SELECT 1 FROM reservations rr WHERE rr.id = f.reservation_id AND rr.status = 'checked-out'));
  GET DIAGNOSTICS n_folios = ROW_COUNT;

  out_json := jsonb_build_object(
    'ok', true,
    'branch_id', b,
    'pos_orders_posted', n_pos,
    'laundry_orders_posted', n_laundry,
    'payments_posted', n_pay,
    'tickets_stamped', n_tickets,
    'folios_settled', n_folios,
    'completed_at', now());

  INSERT INTO audit_logs (organization_id, branch_id, user_id, action, module, record_id, new_value, reason)
  VALUES (org, b, auth.uid(), 'lifecycle.finalise', 'operations', NULL, out_json,
          'Completed operations that only required posting or a missing timestamp');

  RETURN out_json || jsonb_build_object('audit', public.neo_lifecycle_audit(b));
END $fn$;

REVOKE ALL ON FUNCTION public.neo_lifecycle_finalise(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_lifecycle_finalise(uuid) TO authenticated, service_role;