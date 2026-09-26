CREATE TABLE IF NOT EXISTS public.finance_posting_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid,
  source_module text NOT NULL,
  source_id uuid NOT NULL,
  source_reference text,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  amount numeric NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'KES',
  folio_line_id uuid,
  detail text,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  requested_by uuid,
  posted_at timestamptz,
  occurred_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS finance_posting_receipts_key
  ON public.finance_posting_receipts (organization_id, idempotency_key);
CREATE INDEX IF NOT EXISTS finance_posting_receipts_scope
  ON public.finance_posting_receipts (organization_id, branch_id, occurred_on DESC);

GRANT SELECT, INSERT, UPDATE ON public.finance_posting_receipts TO authenticated;
GRANT ALL ON public.finance_posting_receipts TO service_role;

ALTER TABLE public.finance_posting_receipts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS finance_posting_receipts_read ON public.finance_posting_receipts;
CREATE POLICY finance_posting_receipts_read ON public.finance_posting_receipts
  FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id()
         AND (public.is_org_admin() OR public.has_permission('finance','view')));

DROP POLICY IF EXISTS finance_posting_receipts_write ON public.finance_posting_receipts;
CREATE POLICY finance_posting_receipts_write ON public.finance_posting_receipts
  FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id()
              AND (public.is_org_admin() OR public.has_permission('finance','edit')));

DROP POLICY IF EXISTS finance_posting_receipts_update ON public.finance_posting_receipts;
CREATE POLICY finance_posting_receipts_update ON public.finance_posting_receipts
  FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id()
         AND (public.is_org_admin() OR public.has_permission('finance','edit')))
  WITH CHECK (organization_id = public.current_org_id());

DROP TRIGGER IF EXISTS finance_posting_receipts_touch ON public.finance_posting_receipts;
CREATE TRIGGER finance_posting_receipts_touch
  BEFORE UPDATE ON public.finance_posting_receipts
  FOR EACH ROW EXECUTE FUNCTION public.fin_touch_updated_at();

-- Records the outcome of one posting attempt. One row per source record, ever.
CREATE OR REPLACE FUNCTION public.neo_record_posting_receipt(
  _org uuid, _branch uuid, _module text, _source uuid, _reference text,
  _status text, _amount numeric, _currency text, _folio_line uuid,
  _detail text, _error text, _occurred date)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _key text := _module || ':' || _source::text; _id uuid;
BEGIN
  INSERT INTO public.finance_posting_receipts AS r
    (organization_id, branch_id, source_module, source_id, source_reference, idempotency_key,
     status, amount, currency, folio_line_id, detail, attempts, last_error, requested_by,
     posted_at, occurred_on)
  VALUES (_org, _branch, _module, _source, _reference, _key, _status, coalesce(_amount,0),
          coalesce(_currency,'KES'), _folio_line, _detail, 1, _error, auth.uid(),
          CASE WHEN _status = 'posted' THEN now() END, _occurred)
  ON CONFLICT (organization_id, idempotency_key) DO UPDATE
     SET status = CASE WHEN r.status = 'posted' THEN 'posted' ELSE excluded.status END,
         amount = excluded.amount,
         currency = excluded.currency,
         folio_line_id = coalesce(r.folio_line_id, excluded.folio_line_id),
         detail = excluded.detail,
         attempts = r.attempts + 1,
         last_error = excluded.last_error,
         requested_by = coalesce(excluded.requested_by, r.requested_by),
         posted_at = coalesce(r.posted_at, excluded.posted_at),
         occurred_on = coalesce(r.occurred_on, excluded.occurred_on)
  RETURNING r.id INTO _id;
  RETURN _id;
END $$;

REVOKE ALL ON FUNCTION public.neo_record_posting_receipt(uuid,uuid,text,uuid,text,text,numeric,text,uuid,text,text,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_record_posting_receipt(uuid,uuid,text,uuid,text,text,numeric,text,uuid,text,text,date) TO authenticated, service_role;

-- Posts one operational record into Finance. Idempotent: a source that already
-- has a posted receipt, or an already-posted source row, is never posted twice.
CREATE OR REPLACE FUNCTION public.neo_finance_post_source(_module text, _source uuid, _silent boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE org uuid := public.current_org_id();
        res jsonb; line uuid; posted int := 0; item record;
        cur text; branch uuid; amount numeric := 0; ref text; occurred date; msg text;
BEGIN
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.is_org_admin() OR public.has_permission('finance','edit')
          OR public.has_permission('finance','approve')) AND NOT _silent THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  -- Serialise concurrent attempts for the same source record.
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
    SELECT e.branch_id, e.total_amount, coalesce(e.event_reference, e.id::text), e.event_date
      INTO branch, amount, ref, occurred
      FROM public.event_bookings e WHERE e.id = _source AND e.organization_id = org;
    IF ref IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
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
END $$;

REVOKE ALL ON FUNCTION public.neo_finance_post_source(text,uuid,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_finance_post_source(text,uuid,boolean) TO authenticated, service_role;