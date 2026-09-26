CREATE OR REPLACE FUNCTION public.neo_finance_post_source(_module text, _source uuid, _silent boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE org uuid := public.current_org_id();
        res jsonb; line uuid; posted int := 0; item record;
        cur text; branch uuid; amount numeric := 0; ref text; occurred date; msg text;
        bill_status text;
BEGIN
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.is_org_admin() OR public.has_permission('finance','edit')
          OR public.has_permission('finance','approve')) AND NOT _silent THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(_module || ':' || _source::text, 0));

  IF EXISTS (SELECT 1 FROM public.finance_posting_receipts
              WHERE organization_id = org AND idempotency_key = _module || ':' || _source::text
                AND status = 'posted') THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_posted');
  END IF;

  IF _module = 'pos' THEN
    SELECT o.branch_id, o.grand_total, o.order_number, (o.created_at)::date
      INTO branch, amount, ref, occurred
      FROM public.pos_orders o WHERE o.id = _source AND o.organization_id = org;
    IF ref IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    res := public.neo_post_pos_order(_source);
    line := nullif(res->>'folio_line_id','')::uuid;

  ELSIF _module = 'laundry' THEN
    SELECT l.branch_id, l.total, l.laundry_number, (l.created_at)::date
      INTO branch, amount, ref, occurred
      FROM public.guest_laundry_orders l WHERE l.id = _source AND l.organization_id = org;
    IF ref IS NULL AND branch IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    res := public.laundry_post_charge(_source);
    line := nullif(res->>'folio_line_id','')::uuid;

  ELSIF _module = 'events' THEN
    SELECT e.branch_id, e.total_amount, coalesce(e.event_reference, e.id::text), e.event_date,
           coalesce(e.billing_status,'not_billed')
      INTO branch, amount, ref, occurred, bill_status
      FROM public.event_bookings e WHERE e.id = _source AND e.organization_id = org;
    IF ref IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    IF bill_status <> 'finalised' THEN
      res := jsonb_build_object('ok', false, 'reason', 'billing_not_finalised',
             'detail', 'Build and finalise the event bill before it can be recognised in Finance.');
    ELSE
      FOR item IN
        SELECT b.* FROM public.event_billing_items b
         WHERE b.organization_id = org AND b.booking_id = _source
           AND b.folio_id IS NOT NULL AND coalesce(b.is_complimentary,false) = false
      LOOP
        line := public.folio_post_charge(item.folio_id, 'event', coalesce(item.description,'Event charge'),
                  coalesce(item.quantity,1), coalesce(item.unit_price,0),
                  round(coalesce(item.line_total,0) * coalesce(item.tax_rate,0) / 100.0, 2), 0, 0,
                  'events', item.id, 'events', 'event-item:' || item.id::text, NULL);
        posted := posted + 1;
      END LOOP;
      res := CASE WHEN posted > 0 THEN jsonb_build_object('ok', true, 'lines', posted)
                  ELSE jsonb_build_object('ok', false, 'reason', 'no_folio',
                       'detail', 'No event billing item is attached to an open folio yet.') END;
    END IF;

  ELSIF _module = 'delivery' THEN
    SELECT d.branch_id, d.grand_total, d.order_number, (d.created_at)::date
      INTO branch, amount, ref, occurred
      FROM public.delivery_orders d WHERE d.id = _source AND d.organization_id = org;
    IF ref IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    SELECT d.pos_order_id INTO line FROM public.delivery_orders d WHERE d.id = _source;
    IF line IS NOT NULL THEN
      res := public.neo_post_pos_order(line);
      line := nullif(res->>'folio_line_id','')::uuid;
    ELSE
      res := jsonb_build_object('ok', true, 'reason', 'settled_on_delivery',
             'detail', 'Delivery settled with the rider — recognised as delivery sales, no folio posting required.');
    END IF;

  ELSE
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_module');
  END IF;

  cur := public.neo_fact_currency(org, branch);
  msg := coalesce(res->>'detail', res->>'reason');

  PERFORM public.neo_record_posting_receipt(
    org, branch, _module, _source, ref,
    CASE WHEN coalesce((res->>'ok')::boolean, false) THEN 'posted' ELSE 'blocked' END,
    amount, cur, line, msg, NULL, occurred);

  RETURN res || jsonb_build_object('module', _module, 'source_id', _source);
EXCEPTION WHEN OTHERS THEN
  PERFORM public.neo_record_posting_receipt(org, branch, _module, _source, ref, 'failed',
    amount, coalesce(cur, 'KES'), NULL, NULL, SQLERRM, occurred);
  IF _silent THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'failed', 'detail', SQLERRM);
  END IF;
  RAISE;
END $fn$;

REVOKE EXECUTE ON FUNCTION public.neo_finance_post_source(text, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_finance_post_source(text, uuid, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_finance_posting_queue(_branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL)
RETURNS TABLE(source_module text, source_id uuid, reference text, source_status text, amount numeric, currency text, occurred_on date, eligible boolean, posting_status text, rule text, required_action text, drill_to text, last_error text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE org uuid := public.current_org_id(); tz text; t date; f date; cur text;
BEGIN
  IF org IS NULL OR NOT (public.is_org_admin() OR public.has_permission('finance','view')) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;
  tz := public.neo_fact_timezone(org, _branch);
  cur := public.neo_fact_currency(org, _branch);
  t := coalesce(_to, (now() AT TIME ZONE tz)::date);
  f := coalesce(_from, t - 29);

  RETURN QUERY
  WITH receipts AS (
    SELECT r.idempotency_key, r.status, r.last_error FROM public.finance_posting_receipts r
     WHERE r.organization_id = org
  ), q AS (
    SELECT 'pos'::text AS m, o.id, o.order_number AS ref, o.status AS st,
           o.grand_total AS amt, (o.created_at AT TIME ZONE tz)::date AS d,
           (o.status IN ('closed','paid','settled','completed') AND o.folio_post_status IS DISTINCT FROM 'posted'
             AND o.folio_id IS NOT NULL) AS ok,
           'A point-of-sale order is revenue once it is closed, paid, settled or completed and attached to a folio.'::text AS rule,
           CASE WHEN o.status NOT IN ('closed','paid','settled','completed')
                  THEN 'Finalise the order in Point of Sale (close, settle or mark paid).'
                WHEN o.folio_id IS NULL
                  THEN 'Attach the order to a guest folio, or settle it as a cash sale.'
                ELSE 'Post to Finance.' END::text AS act,
           '/pos/orders'::text AS drill
      FROM public.pos_orders o
     WHERE o.organization_id = org AND (_branch IS NULL OR o.branch_id = _branch)
       AND (o.created_at AT TIME ZONE tz)::date BETWEEN f AND t
       AND o.status NOT IN ('void','voided','cancelled')
       AND o.folio_post_status IS DISTINCT FROM 'posted'
    UNION ALL
    SELECT 'laundry', l.id, coalesce(l.laundry_number, l.id::text), l.status, l.total,
           (l.created_at AT TIME ZONE tz)::date,
           (l.status IN ('delivered','completed','closed') AND l.posting_status IS DISTINCT FROM 'posted'
             AND (l.folio_id IS NOT NULL OR l.reservation_id IS NOT NULL)),
           'A guest laundry order is revenue once it is delivered or completed and reaches an open folio.',
           CASE WHEN l.status NOT IN ('delivered','completed','closed')
                  THEN 'Complete the laundry order and return the items to the guest.'
                WHEN l.folio_id IS NULL AND l.reservation_id IS NULL
                  THEN 'Link the order to a reservation or folio so the charge has an account.'
                ELSE 'Post to Finance.' END,
           '/laundry'
      FROM public.guest_laundry_orders l
     WHERE l.organization_id = org AND (_branch IS NULL OR l.branch_id = _branch)
       AND (l.created_at AT TIME ZONE tz)::date BETWEEN f AND t
       AND l.status NOT IN ('cancelled')
       AND l.posting_status IS DISTINCT FROM 'posted'
    UNION ALL
    SELECT 'events', e.id, coalesce(e.event_reference, e.id::text), e.status, e.total_amount, e.event_date,
           (e.status IN ('confirmed','completed')
             AND coalesce(e.billing_status,'not_billed') = 'finalised'
             AND EXISTS (
              SELECT 1 FROM public.event_billing_items b
               WHERE b.booking_id = e.id AND b.folio_id IS NOT NULL
                 AND coalesce(b.is_complimentary,false) = false)),
           'An event becomes revenue when the booking is confirmed or completed, its bill is finalised, and its billing items sit on an event folio.',
           CASE WHEN e.status NOT IN ('confirmed','completed')
                  THEN 'Confirm the event booking before it can be recognised.'
                WHEN NOT EXISTS (SELECT 1 FROM public.event_billing_items b WHERE b.booking_id = e.id)
                  THEN 'Build the event bill from the banquet event order.'
                WHEN coalesce(e.billing_status,'not_billed') <> 'finalised'
                  THEN 'Finalise the event bill in Event Billing.'
                ELSE 'Attach the billing items to an open event folio, then post to Finance.' END,
           '/events/bookings'
      FROM public.event_bookings e
     WHERE e.organization_id = org AND (_branch IS NULL OR e.branch_id = _branch)
       AND e.event_date BETWEEN f AND t
       AND e.status NOT IN ('cancelled','lost')
    UNION ALL
    SELECT 'delivery', d.id, d.order_number, d.order_status, d.grand_total,
           (d.created_at AT TIME ZONE tz)::date,
           (d.order_status = 'delivered'),
           'A delivery order is revenue once the rider confirms delivery.',
           CASE WHEN d.order_status <> 'delivered'
                  THEN 'Complete the dispatch and confirm delivery with the recipient PIN.'
                ELSE 'Post to Finance.' END,
           '/delivery'
      FROM public.delivery_orders d
     WHERE d.organization_id = org AND (_branch IS NULL OR d.branch_id = _branch)
       AND (d.created_at AT TIME ZONE tz)::date BETWEEN f AND t
       AND d.order_status NOT IN ('cancelled','rejected','failed')
  )
  SELECT q.m, q.id, q.ref, q.st, coalesce(q.amt,0), cur, q.d, q.ok,
         coalesce(rc.status, 'unposted'), q.rule, q.act, q.drill, rc.last_error
    FROM q LEFT JOIN receipts rc ON rc.idempotency_key = q.m || ':' || q.id::text
   WHERE coalesce(rc.status,'unposted') <> 'posted'
   ORDER BY q.ok DESC, q.d DESC
   LIMIT 500;
END $fn$;

REVOKE EXECUTE ON FUNCTION public.neo_finance_posting_queue(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_finance_posting_queue(uuid, date, date) TO authenticated;