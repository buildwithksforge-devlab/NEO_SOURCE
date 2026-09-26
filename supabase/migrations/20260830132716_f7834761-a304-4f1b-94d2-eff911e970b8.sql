-- 1. Canonical source-integrity validation ---------------------------------
CREATE OR REPLACE FUNCTION public.neo_source_integrity(_module text, _source uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE org uuid := public.current_org_id();
        o record; lines int; line_sum numeric; disc numeric; unapproved int;
        issues jsonb := '[]'::jsonb; posted_already boolean;
BEGIN
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'issues', jsonb_build_array(
    jsonb_build_object('code','no_organisation','detail','No active workspace.'))); END IF;

  posted_already := EXISTS (SELECT 1 FROM public.finance_posting_receipts r
     WHERE r.organization_id = org AND r.idempotency_key = _module || ':' || _source::text
       AND r.status = 'posted');

  IF _module IN ('pos','pos_order') THEN
    SELECT * INTO o FROM public.pos_orders p WHERE p.id = _source AND p.organization_id = org;
    IF o.id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'issues', jsonb_build_array(
        jsonb_build_object('code','not_found','detail','The order does not exist in this workspace.')));
    END IF;

    SELECT count(*), coalesce(sum(i.line_total),0), coalesce(sum(i.discount_amount),0),
           count(*) FILTER (WHERE coalesce(i.pricing_type,'normal') <> 'normal' AND i.pricing_approved_at IS NULL)
      INTO lines, line_sum, disc, unapproved
      FROM public.pos_order_items i
     WHERE i.order_id = o.id AND coalesce(i.status,'') NOT IN ('void','voided','cancelled');

    IF lines = 0 THEN
      issues := issues || jsonb_build_object('code','no_valid_lines',
        'detail','The order has no valid (non-void) lines to recognise.');
    END IF;
    IF abs(coalesce(o.subtotal,0) - line_sum) > 0.01 THEN
      issues := issues || jsonb_build_object('code','line_total_mismatch',
        'detail', format('Order subtotal %s does not equal the sum of its valid lines %s.',
                         to_char(coalesce(o.subtotal,0),'FM999999990.00'), to_char(line_sum,'FM999999990.00')));
    END IF;
    IF coalesce(o.grand_total,0) <= 0 THEN
      issues := issues || jsonb_build_object('code','zero_total',
        'detail','The order total is zero, so there is nothing to recognise.');
    END IF;
    IF unapproved > 0 THEN
      issues := issues || jsonb_build_object('code','unapproved_pricing',
        'detail', format('%s line(s) use non-standard pricing that has not been approved.', unapproved));
    END IF;
    IF o.status IN ('void','voided','cancelled') THEN
      issues := issues || jsonb_build_object('code','cancelled_source',
        'detail','A cancelled or voided order can never be recognised as revenue.');
    ELSIF o.status NOT IN ('closed','paid','settled','completed','charged-to-room') THEN
      issues := issues || jsonb_build_object('code','not_finalised',
        'detail', format('The order is still %s. Finalise it in Point of Sale first.', o.status));
    END IF;
    IF o.folio_id IS NULL AND o.corporate_account_id IS NULL
       AND NOT public.neo_pos_settlement_evidence(o.id) THEN
      issues := issues || jsonb_build_object('code','no_settlement',
        'detail','No settlement evidence and no guest folio or corporate account to charge.');
    END IF;
    IF o.folio_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.folios f WHERE f.id = o.folio_id AND f.organization_id = org) THEN
      issues := issues || jsonb_build_object('code','invalid_folio',
        'detail','The order points at a folio that does not exist in this workspace.');
    END IF;
    IF posted_already OR o.folio_post_status = 'posted' THEN
      issues := issues || jsonb_build_object('code','already_posted',
        'detail','This order has already been recognised in Finance.');
    END IF;

    RETURN jsonb_build_object(
      'ok', jsonb_array_length(issues) = 0,
      'module', _module, 'source_id', _source, 'reference', o.order_number,
      'status', o.status, 'lines', lines, 'line_total', line_sum,
      'subtotal', coalesce(o.subtotal,0), 'tax', coalesce(o.tax_total,0),
      'service_charge', coalesce(o.service_charge_total,0), 'discount', coalesce(o.discount_total,0),
      'grand_total', coalesce(o.grand_total,0), 'issues', issues);
  END IF;

  -- Modules without a bespoke rule set are validated only for duplicate posting.
  IF posted_already THEN
    issues := issues || jsonb_build_object('code','already_posted',
      'detail','This record has already been recognised in Finance.');
  END IF;
  RETURN jsonb_build_object('ok', jsonb_array_length(issues) = 0, 'module', _module,
                            'source_id', _source, 'issues', issues);
END $function$;

REVOKE ALL ON FUNCTION public.neo_source_integrity(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_source_integrity(text, uuid) TO authenticated, service_role;

-- 2. Posting refuses a source whose canonical totals disagree ---------------
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
END $function$;

-- 3. Journal register --------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_journal_register(
  _branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL,
  _status text DEFAULT NULL, _module text DEFAULT NULL, _limit int DEFAULT 500)
RETURNS TABLE(
  id uuid, journal_number text, accounting_date date, period_name text, period_status text,
  journal_type text, source_module text, source_document_type text, source_document_id uuid,
  document_number text, description text, currency text,
  total_debit numeric, total_credit numeric, balanced boolean, line_count int,
  status text, branch_id uuid, property text,
  created_by_name text, created_at timestamptz, posted_by_name text, posted_at timestamptz,
  reverses_journal_id uuid, reverses_journal_number text,
  reversed_by_journal_id uuid, reversed_by_journal_number text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE org uuid := public.current_org_id();
BEGIN
  IF org IS NULL OR NOT (public.is_org_admin() OR public.can_read_general_ledger()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT j.id, j.journal_number, j.accounting_date, p.name, p.status,
         j.journal_type, j.source_module, j.source_document_type, j.source_document_id,
         j.document_number, j.description, j.currency,
         coalesce(j.total_debit,0), coalesce(j.total_credit,0),
         abs(coalesce(j.total_debit,0) - coalesce(j.total_credit,0)) < 0.01,
         (SELECT count(*)::int FROM public.journal_entry_lines l WHERE l.journal_id = j.id),
         j.status, j.branch_id, b.name,
         cs.full_name, j.created_at, ps.full_name, j.posted_at,
         j.reverses_journal_id, rj.journal_number,
         j.reversed_by_journal_id, bj.journal_number
    FROM public.journal_entries j
    LEFT JOIN public.accounting_periods p ON p.id = j.period_id
    LEFT JOIN public.branches b ON b.id = j.branch_id
    LEFT JOIN public.staff cs ON cs.user_id = j.created_by
    LEFT JOIN public.staff ps ON ps.user_id = j.posted_by
    LEFT JOIN public.journal_entries rj ON rj.id = j.reverses_journal_id
    LEFT JOIN public.journal_entries bj ON bj.id = j.reversed_by_journal_id
   WHERE j.organization_id = org
     AND (_branch IS NULL OR j.branch_id = _branch)
     AND (_from IS NULL OR j.accounting_date >= _from)
     AND (_to IS NULL OR j.accounting_date <= _to)
     AND (_status IS NULL OR j.status = _status)
     AND (_module IS NULL OR j.source_module = _module)
   ORDER BY j.accounting_date DESC, j.created_at DESC
   LIMIT greatest(1, least(coalesce(_limit,500), 2000));
END $function$;

REVOKE ALL ON FUNCTION public.neo_journal_register(uuid, date, date, text, text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_journal_register(uuid, date, date, text, text, int) TO authenticated, service_role;

-- 4. One authoritative exception register ------------------------------------
CREATE OR REPLACE FUNCTION public.neo_finance_exception_register(
  _branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL)
RETURNS TABLE(
  kind text, module text, reference text, source_id uuid, amount numeric, currency text,
  occurred_on date, age_days int, status text, reason text, detail text,
  responsible text, action text, drill_to text,
  last_attempt timestamptz, attempts int, last_error text, branch_id uuid, property text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE org uuid := public.current_org_id(); today date;
BEGIN
  IF org IS NULL OR NOT (public.is_org_admin() OR public.has_permission('finance','view')
                         OR public.can_read_general_ledger()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;
  today := (now() AT TIME ZONE public.neo_fact_timezone(org, _branch))::date;

  RETURN QUERY
  -- Operational records an eligibility rule is holding back.
  SELECT 'blocked'::text, q.source_module, q.reference, q.source_id, q.amount, q.currency,
         q.occurred_on, greatest(0, today - q.occurred_on)::int, 'blocked'::text,
         q.rule, coalesce(q.last_error, q.required_action),
         CASE q.source_module WHEN 'pos' THEN 'Point of Sale'
                              WHEN 'laundry' THEN 'Laundry'
                              WHEN 'events' THEN 'Events'
                              WHEN 'delivery' THEN 'Delivery'
                              ELSE 'Operations' END,
         q.required_action, q.drill_to, NULL::timestamptz, 0, q.last_error, NULL::uuid, NULL::text
    FROM public.neo_finance_posting_queue(_branch, _from, _to) q
   WHERE q.eligible = false

  UNION ALL
  -- Postings that were attempted and failed.
  SELECT 'failed', r.source_module, coalesce(r.source_reference, r.source_id::text), r.source_id,
         coalesce(r.amount,0), coalesce(r.currency,'KES'), r.occurred_on,
         greatest(0, today - coalesce(r.occurred_on, r.created_at::date))::int, r.status,
         coalesce(r.last_error, 'Posting failed'),
         coalesce(r.detail->>'detail', r.last_error),
         'Finance', 'Review the error, correct the source, then retry the posting.',
         '/finance/posting', coalesce(r.updated_at, r.created_at), coalesce(r.attempts,0),
         r.last_error, r.branch_id, b.name
    FROM public.finance_posting_receipts r
    LEFT JOIN public.branches b ON b.id = r.branch_id
   WHERE r.organization_id = org
     AND r.status = 'failed'
     AND (_branch IS NULL OR r.branch_id = _branch)
     AND (_from IS NULL OR coalesce(r.occurred_on, r.created_at::date) >= _from)
     AND (_to IS NULL OR coalesce(r.occurred_on, r.created_at::date) <= _to)
   ORDER BY 1, 7 DESC;
END $function$;

REVOKE ALL ON FUNCTION public.neo_finance_exception_register(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_finance_exception_register(uuid, date, date) TO authenticated, service_role;