CREATE OR REPLACE FUNCTION public.neo_finance_post_source(_module text, _source uuid, _silent boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE org uuid := public.current_org_id();
        res jsonb; line uuid; posted int := 0; item record;
        cur text; branch uuid; amount numeric := 0; ref text; occurred date; msg text;
        bill_status text; prior text; folio uuid; integrity jsonb;
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
    SELECT o.branch_id, o.grand_total, o.order_number, (o.created_at)::date, o.folio_id
      INTO branch, amount, ref, occurred, folio
      FROM public.pos_orders o WHERE o.id = _source AND o.organization_id = org;
    IF ref IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;

    -- Canonical source integrity: the order's own figures must agree before
    -- any accounting entry is written from them.
    integrity := public.neo_source_integrity('pos', _source);
    IF NOT coalesce((integrity->>'ok')::boolean, false)
       AND NOT (integrity->'issues' @> '[{"code":"already_posted"}]'::jsonb
                AND jsonb_array_length(integrity->'issues') = 1) THEN
      msg := coalesce((SELECT string_agg(i->>'detail', ' ') FROM jsonb_array_elements(integrity->'issues') i),
                      'Source integrity mismatch.');
      PERFORM public.neo_record_posting_receipt(org, branch, _module, _source, ref, 'blocked',
        amount, public.neo_fact_currency(org, branch), NULL, msg, NULL, occurred);
      RETURN jsonb_build_object('ok', false, 'reason', 'source_integrity_mismatch',
        'detail', 'Posting blocked — source integrity mismatch. ' || msg,
        'integrity', integrity, 'module', _module, 'source_id', _source);
    END IF;

    res := public.neo_finance_post_txn('pos_order', _source, true);
    line := nullif(res->>'folio_line_id','')::uuid;
    IF folio IS NULL AND coalesce((res->>'ok')::boolean, false) THEN
      RETURN res || jsonb_build_object('module', _module, 'source_id', _source);
    END IF;

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
      prior := coalesce(current_setting('neo.system_posting', true), 'off');
      PERFORM set_config('neo.system_posting', 'on', true);
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
      PERFORM set_config('neo.system_posting', prior, true);
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
      res := public.neo_finance_post_txn('pos_order', line, true);
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
END $function$
