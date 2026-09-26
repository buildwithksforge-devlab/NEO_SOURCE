-- 1. Department readiness derived from the real task status ------------------
CREATE OR REPLACE FUNCTION public.neo_event_readiness_from_task(_status text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE lower(coalesce(_status,''))
    WHEN 'completed' THEN 'ready'
    WHEN 'complete' THEN 'ready'
    WHEN 'done' THEN 'ready'
    WHEN 'closed' THEN 'ready'
    WHEN 'in-progress' THEN 'in-progress'
    WHEN 'in_progress' THEN 'in-progress'
    WHEN 'active' THEN 'in-progress'
    WHEN 'started' THEN 'in-progress'
    WHEN 'blocked' THEN 'blocked'
    WHEN 'on-hold' THEN 'blocked'
    WHEN 'cancelled' THEN 'blocked'
    WHEN 'overdue' THEN 'at-risk'
    ELSE 'not-started'
  END
$$;

CREATE OR REPLACE FUNCTION public.neo_event_task_readiness_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  UPDATE public.event_department_requirements r
     SET readiness = public.neo_event_readiness_from_task(NEW.status),
         updated_at = now()
   WHERE r.task_id = NEW.id
     AND coalesce(btrim(r.blocker), '') = ''
     AND r.readiness IS DISTINCT FROM public.neo_event_readiness_from_task(NEW.status);
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.neo_event_readiness_from_task(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_event_task_readiness_sync() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_event_readiness_from_task(text) TO authenticated, service_role;

DROP TRIGGER IF EXISTS tg_neo_event_task_readiness ON public.tasks;
CREATE TRIGGER tg_neo_event_task_readiness
AFTER INSERT OR UPDATE OF status ON public.tasks
FOR EACH ROW EXECUTE FUNCTION public.neo_event_task_readiness_sync();

-- backfill existing linked requirements
UPDATE public.event_department_requirements r
   SET readiness = public.neo_event_readiness_from_task(t.status), updated_at = now()
  FROM public.tasks t
 WHERE t.id = r.task_id
   AND coalesce(btrim(r.blocker), '') = ''
   AND r.readiness IS DISTINCT FROM public.neo_event_readiness_from_task(t.status);

-- 2. Every event money movement posts to the ledger, exactly once -----------
CREATE OR REPLACE FUNCTION public.neo_event_post_payment(_payment uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  p public.event_payments;
  b public.event_bookings;
  org uuid; cur text; occurred date; gross numeric; settle text;
  bucket text; lines jsonb; posting text; res jsonb;
BEGIN
  SELECT * INTO p FROM public.event_payments WHERE id = _payment;
  IF p.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  SELECT * INTO b FROM public.event_bookings WHERE id = p.booking_id;
  IF b.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'booking_not_found'); END IF;

  org := p.organization_id;
  gross := abs(coalesce(p.amount, 0));
  IF gross = 0 THEN RETURN jsonb_build_object('ok', false, 'reason', 'zero_amount'); END IF;

  cur := coalesce(p.currency, public.neo_fact_currency(org, p.branch_id));
  occurred := coalesce(p.recorded_at, p.created_at, now())::date;
  settle := coalesce(public.neo_gl_settlement_code(p.method), '1010');
  -- deposits are held as a liability until the event is earned;
  -- other receipts settle the customer ledger.
  bucket := CASE WHEN p.entry_type = 'deposit' THEN '2030' ELSE '1060' END;
  posting := CASE WHEN coalesce(p.amount,0) < 0 THEN 'refund' ELSE p.entry_type END;

  IF coalesce(p.amount, 0) > 0 THEN
    lines := jsonb_build_array(
      jsonb_build_object('code', settle, 'debit', gross,
                         'description', 'Event receipt ' || coalesce(b.event_reference, '')),
      jsonb_build_object('code', bucket, 'credit', gross,
                         'description', CASE WHEN bucket = '2030'
                              THEN 'Event deposit held' ELSE 'Event customer ledger' END));
  ELSE
    lines := jsonb_build_array(
      jsonb_build_object('code', bucket, 'debit', gross,
                         'description', CASE WHEN bucket = '2030'
                              THEN 'Event deposit released' ELSE 'Event customer ledger' END),
      jsonb_build_object('code', settle, 'credit', gross,
                         'description', 'Event refund ' || coalesce(b.event_reference, '')));
  END IF;

  res := public.neo_gl_post(org, p.branch_id, 'events', 'event_payment', p.id,
                            posting, occurred, cur,
                            'Event payment ' || coalesce(b.event_reference, ''),
                            lines, b.customer_id, NULL);

  PERFORM public.neo_record_posting_receipt(org, p.branch_id, 'event_payment', p.id,
    coalesce(p.reference, b.event_reference), 'posted', gross, cur, NULL,
    CASE WHEN coalesce((res->>'duplicate_prevented')::boolean, false)
         THEN 'Duplicate replay prevented - the existing journal was reused.'
         ELSE 'Posted to journal ' || (res->>'journal_id') END,
    NULL, occurred);

  UPDATE public.finance_posting_receipts
     SET posting_type = posting, journal_id = (res->>'journal_id')::uuid
   WHERE organization_id = org AND source_module = 'event_payment' AND source_id = p.id;

  RETURN res || jsonb_build_object('posting_type', posting, 'amount', gross);
EXCEPTION WHEN OTHERS THEN
  PERFORM public.neo_record_posting_receipt(org, p.branch_id, 'event_payment', p.id,
    coalesce(p.reference, b.event_reference), 'failed', gross, coalesce(cur, 'KES'),
    NULL, NULL, SQLERRM, occurred);
  RETURN jsonb_build_object('ok', false, 'reason', 'failed', 'detail', SQLERRM);
END $$;

CREATE OR REPLACE FUNCTION public.neo_event_payment_autopost()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  PERFORM public.neo_event_post_payment(NEW.id);
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.neo_event_post_payment(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_event_payment_autopost() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_event_post_payment(uuid) TO service_role;

DROP TRIGGER IF EXISTS tg_neo_event_payment_autopost ON public.event_payments;
CREATE TRIGGER tg_neo_event_payment_autopost
AFTER INSERT ON public.event_payments
FOR EACH ROW EXECUTE FUNCTION public.neo_event_payment_autopost();