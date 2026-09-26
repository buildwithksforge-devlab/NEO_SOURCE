-- Unified guest view: one scoped read that assembles the guest's stays,
-- folios, spend by revenue area and recent transactions from the canonical
-- source records, without duplicating any financial data into the CRM.
CREATE OR REPLACE FUNCTION public.neo_customer_360(_customer uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE org uuid := public.current_org_id(); result jsonb;
BEGIN
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.has_permission('crm','view') OR public.has_permission('crm','edit')
          OR public.has_permission('pms','view') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to view guest history' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.customers c
                  WHERE c.id = _customer AND c.organization_id = org) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  SELECT jsonb_build_object(
    'ok', true,
    'stays', COALESCE((
      SELECT jsonb_agg(x ORDER BY x->>'arrival_date' DESC) FROM (
        SELECT jsonb_build_object(
                 'id', r.id, 'confirmation_number', r.confirmation_number, 'status', r.status,
                 'arrival_date', r.arrival_date, 'departure_date', r.departure_date,
                 'room_number', rm.room_number, 'total_amount', r.total_amount, 'balance', r.balance) AS x,
               r.arrival_date
          FROM public.reservations r
          LEFT JOIN public.rooms rm ON rm.id = r.room_id
         WHERE r.organization_id = org AND r.customer_id = _customer
         ORDER BY r.arrival_date DESC LIMIT 50) s
    ), '[]'::jsonb),
    'folios', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', f.id, 'folio_number', f.folio_number, 'status', f.status,
               'total_charges', f.total_charges, 'total_payments', f.total_payments,
               'balance', f.balance, 'created_at', f.created_at))
        FROM public.folios f
       WHERE f.organization_id = org
         AND (f.customer_id = _customer
              OR f.reservation_id IN (SELECT id FROM public.reservations
                                       WHERE organization_id = org AND customer_id = _customer))
    ), '[]'::jsonb),
    'spend_by_area', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('area', area, 'amount', amount) ORDER BY amount DESC)
        FROM (
          SELECT COALESCE(NULLIF(l.category, ''), 'other') AS area, sum(l.net_amount) AS amount
            FROM public.folio_lines l
           WHERE l.organization_id = org
             AND COALESCE(l.line_type, 'charge') = 'charge'
             AND (l.customer_id = _customer
                  OR l.folio_id IN (SELECT f.id FROM public.folios f
                                     WHERE f.organization_id = org
                                       AND (f.customer_id = _customer
                                            OR f.reservation_id IN (SELECT id FROM public.reservations
                                                                     WHERE organization_id = org AND customer_id = _customer))))
           GROUP BY 1) g
    ), '[]'::jsonb),
    'transactions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', l.id, 'date', l.created_at, 'category', l.category,
               'description', l.description, 'amount', l.net_amount,
               'source', l.source_module, 'type', l.line_type)
             ORDER BY l.created_at DESC)
        FROM (
          SELECT l.* FROM public.folio_lines l
           WHERE l.organization_id = org
             AND (l.customer_id = _customer
                  OR l.folio_id IN (SELECT f.id FROM public.folios f
                                     WHERE f.organization_id = org
                                       AND (f.customer_id = _customer
                                            OR f.reservation_id IN (SELECT id FROM public.reservations
                                                                     WHERE organization_id = org AND customer_id = _customer))))
           ORDER BY l.created_at DESC LIMIT 100) l
    ), '[]'::jsonb),
    'restaurant_orders', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', o.id, 'order_number', o.order_number,
               'status', o.status, 'total', o.grand_total, 'date', o.created_at)
             ORDER BY o.created_at DESC)
        FROM (SELECT * FROM public.pos_orders p
               WHERE p.organization_id = org AND p.customer_id = _customer
               ORDER BY p.created_at DESC LIMIT 25) o
    ), '[]'::jsonb),
    'events', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', e.id, 'reference', e.event_reference,
               'status', e.status, 'event_date', e.event_date, 'total', e.total_amount)
             ORDER BY e.event_date DESC)
        FROM (SELECT * FROM public.event_bookings b
               WHERE b.organization_id = org AND b.customer_id = _customer
               ORDER BY b.event_date DESC LIMIT 25) e
    ), '[]'::jsonb),
    'laundry_orders', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', gl.id, 'laundry_number', gl.laundry_number,
               'status', gl.status, 'total', gl.total, 'posting_status', gl.posting_status,
               'date', gl.requested_at) ORDER BY gl.requested_at DESC)
        FROM (SELECT g.* FROM public.guest_laundry_orders g
               WHERE g.organization_id = org
                 AND (g.customer_id = _customer
                      OR g.reservation_id IN (SELECT id FROM public.reservations
                                               WHERE organization_id = org AND customer_id = _customer))
               ORDER BY g.requested_at DESC LIMIT 25) gl
    ), '[]'::jsonb)
  ) INTO result;

  RETURN result || jsonb_build_object(
    'totals', jsonb_build_object(
      'stays', jsonb_array_length(result->'stays'),
      'nights', COALESCE((SELECT sum(GREATEST(0, (r.departure_date - r.arrival_date)))
                            FROM public.reservations r
                           WHERE r.organization_id = org AND r.customer_id = _customer
                             AND r.status IN ('checked-in','checked-out','departed','completed')), 0),
      'charges', COALESCE((SELECT sum((e->>'amount')::numeric)
                             FROM jsonb_array_elements(result->'spend_by_area') e), 0),
      'open_balance', COALESCE((SELECT sum((f->>'balance')::numeric)
                                  FROM jsonb_array_elements(result->'folios') f
                                 WHERE f->>'status' = 'open'), 0),
      'last_visit', (SELECT max(r.departure_date) FROM public.reservations r
                      WHERE r.organization_id = org AND r.customer_id = _customer)
    ));
END $$;

REVOKE ALL ON FUNCTION public.neo_customer_360(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_customer_360(uuid) TO authenticated;