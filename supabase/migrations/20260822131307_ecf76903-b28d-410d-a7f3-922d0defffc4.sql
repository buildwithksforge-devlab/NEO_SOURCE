-- Everything that could become Finance revenue in the window, with its rule.
CREATE OR REPLACE FUNCTION public.neo_finance_posting_queue(
  _branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL)
RETURNS TABLE (
  source_module text, source_id uuid, reference text, source_status text,
  amount numeric, currency text, occurred_on date, eligible boolean,
  posting_status text, rule text, required_action text, drill_to text, last_error text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
           (e.status IN ('confirmed','completed') AND EXISTS (
              SELECT 1 FROM public.event_billing_items b
               WHERE b.booking_id = e.id AND b.folio_id IS NOT NULL
                 AND coalesce(b.is_complimentary,false) = false)),
           'An event becomes revenue when the booking is confirmed or completed and its billing items sit on an event folio.',
           CASE WHEN e.status NOT IN ('confirmed','completed')
                  THEN 'Confirm the event booking before it can be recognised.'
                WHEN NOT EXISTS (SELECT 1 FROM public.event_billing_items b WHERE b.booking_id = e.id)
                  THEN 'Add billing items to the banquet event order.'
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
END $$;

REVOKE ALL ON FUNCTION public.neo_finance_posting_queue(uuid,date,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_finance_posting_queue(uuid,date,date) TO authenticated, service_role;

-- Bounded batch posting. Each item is idempotent and records its own receipt.
CREATE OR REPLACE FUNCTION public.neo_finance_post_eligible(
  _branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL,
  _module text DEFAULT NULL, _limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE item record; posted int := 0; blocked int := 0; failed int := 0; res jsonb;
        cap int := least(greatest(coalesce(_limit,50), 1), 200);
BEGIN
  IF NOT (public.is_org_admin() OR public.has_permission('finance','edit')
          OR public.has_permission('finance','approve')) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  FOR item IN
    SELECT * FROM public.neo_finance_posting_queue(_branch, _from, _to) qq
     WHERE qq.eligible AND (_module IS NULL OR qq.source_module = _module)
     LIMIT cap
  LOOP
    res := public.neo_finance_post_source(item.source_module, item.source_id, true);
    IF coalesce((res->>'ok')::boolean, false) THEN posted := posted + 1;
    ELSIF res->>'reason' = 'failed' THEN failed := failed + 1;
    ELSE blocked := blocked + 1; END IF;
  END LOOP;

  RETURN jsonb_build_object('posted', posted, 'blocked', blocked, 'failed', failed,
                            'limit', cap, 'ran_at', now());
END $$;

REVOKE ALL ON FUNCTION public.neo_finance_post_eligible(uuid,date,date,text,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_finance_post_eligible(uuid,date,date,text,integer) TO authenticated, service_role;

-- Visible receipts.
CREATE OR REPLACE FUNCTION public.neo_posting_receipts(
  _branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL, _status text DEFAULT NULL)
RETURNS SETOF public.finance_posting_receipts
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT r.* FROM public.finance_posting_receipts r
   WHERE r.organization_id = public.current_org_id()
     AND (public.is_org_admin() OR public.has_permission('finance','view'))
     AND (_branch IS NULL OR r.branch_id = _branch)
     AND (_from IS NULL OR coalesce(r.occurred_on, r.created_at::date) >= _from)
     AND (_to IS NULL OR coalesce(r.occurred_on, r.created_at::date) <= _to)
     AND (_status IS NULL OR r.status = _status)
   ORDER BY r.updated_at DESC
   LIMIT 500;
$$;

REVOKE ALL ON FUNCTION public.neo_posting_receipts(uuid,date,date,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_posting_receipts(uuid,date,date,text) TO authenticated, service_role;

-- Why is this figure zero? The operational records behind one metric.
CREATE OR REPLACE FUNCTION public.neo_eligibility_drilldown(
  _metric text, _branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL)
RETURNS TABLE (
  source_module text, source_id uuid, reference text, source_status text,
  amount numeric, currency text, occurred_on date, eligible boolean,
  posting_status text, rule text, required_action text, drill_to text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE modules text[];
BEGIN
  modules := CASE
    WHEN _metric LIKE 'operational.pos%' THEN ARRAY['pos']
    WHEN _metric LIKE 'operational.delivery%' THEN ARRAY['delivery']
    WHEN _metric LIKE 'events.%' THEN ARRAY['events']
    WHEN _metric LIKE 'operational.%folio%' THEN ARRAY['laundry','events','pos']
    ELSE ARRAY['pos','laundry','events','delivery'] END;

  RETURN QUERY
  SELECT q.source_module, q.source_id, q.reference, q.source_status, q.amount, q.currency,
         q.occurred_on, q.eligible, q.posting_status, q.rule, q.required_action, q.drill_to
    FROM public.neo_finance_posting_queue(_branch, _from, _to) q
   WHERE q.source_module = ANY(modules)
   ORDER BY q.eligible DESC, q.occurred_on DESC
   LIMIT 200;
END $$;

REVOKE ALL ON FUNCTION public.neo_eligibility_drilldown(text,uuid,date,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_eligibility_drilldown(text,uuid,date,date) TO authenticated, service_role;

-- Reconciliation, one row per property and currency.
CREATE OR REPLACE FUNCTION public.neo_reconciliation_export(
  _branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL)
RETURNS TABLE (
  property text, currency text, stream text, operational_eligible numeric, posted numeric,
  reversals numeric, net_recognised numeric, collected numeric, outstanding_receivable numeric,
  unmatched_records integer, period_from date, period_to date)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE org uuid := public.current_org_id(); b record; facts jsonb;
BEGIN
  IF org IS NULL THEN RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501'; END IF;

  FOR b IN
    SELECT br.id, br.name FROM public.branches br
     WHERE br.organization_id = org AND (_branch IS NULL OR br.id = _branch)
       AND br.id = ANY(coalesce(public.current_branch_ids(), ARRAY[br.id]))
     ORDER BY br.name
  LOOP
    facts := public.neo_facts(b.id, _from, _to);
    CONTINUE WHEN NOT coalesce((facts->>'monetary_authorised')::boolean, false);

    RETURN QUERY
    SELECT b.name,
           coalesce(facts#>>'{scope,currency}', 'KES'),
           r.stream, r.operational_eligible, r.posted, r.reversals, r.net_recognised,
           r.collected, r.outstanding_receivable, r.unmatched_records,
           (facts#>>'{period,from}')::date, (facts#>>'{period,to}')::date
      FROM public.neo_fact_reconciliation(b.id, _from, _to) r;
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.neo_reconciliation_export(uuid,date,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_reconciliation_export(uuid,date,date) TO authenticated, service_role;

-- Automatic, transactional handoff. Runs at the moment of finalisation and
-- can never post twice: the receipt and the source posting flag both guard it.
CREATE OR REPLACE FUNCTION public.neo_autopost_on_finalise()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'pos_orders' THEN
    IF NEW.status IN ('closed','paid','settled','completed')
       AND NEW.status IS DISTINCT FROM OLD.status
       AND NEW.folio_id IS NOT NULL
       AND NEW.folio_post_status IS DISTINCT FROM 'posted' THEN
      PERFORM public.neo_finance_post_source('pos', NEW.id, true);
    END IF;
  ELSIF TG_TABLE_NAME = 'guest_laundry_orders' THEN
    IF NEW.status IN ('delivered','completed','closed')
       AND NEW.status IS DISTINCT FROM OLD.status
       AND NEW.posting_status IS DISTINCT FROM 'posted' THEN
      PERFORM public.neo_finance_post_source('laundry', NEW.id, true);
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS pos_orders_autopost ON public.pos_orders;
CREATE TRIGGER pos_orders_autopost
  AFTER UPDATE ON public.pos_orders
  FOR EACH ROW EXECUTE FUNCTION public.neo_autopost_on_finalise();

DROP TRIGGER IF EXISTS guest_laundry_orders_autopost ON public.guest_laundry_orders;
CREATE TRIGGER guest_laundry_orders_autopost
  AFTER UPDATE ON public.guest_laundry_orders
  FOR EACH ROW EXECUTE FUNCTION public.neo_autopost_on_finalise();