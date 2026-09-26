
-- ============ canonical payment attempt register ============
CREATE TABLE IF NOT EXISTS public.payment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid,
  source_module text NOT NULL,
  source_record_id uuid,
  payment_table text NOT NULL,
  payment_id uuid NOT NULL,
  method text NOT NULL DEFAULT 'cash',
  provider_code text,
  environment text,
  amount numeric NOT NULL DEFAULT 0,
  currency text,
  tendered numeric,
  change_due numeric,
  reference text,
  state text NOT NULL DEFAULT 'requested',
  state_detail text,
  manual_tender boolean NOT NULL DEFAULT false,
  verified_by uuid,
  verified_at timestamptz,
  verification_note text,
  posted_journal_id uuid,
  requested_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_attempts_state_check CHECK (state IN
    ('requested','pending','confirmed','posted','failed','cancelled','timed_out','refunded','voided')),
  CONSTRAINT payment_attempts_unique_source UNIQUE (payment_table, payment_id)
);

GRANT SELECT ON public.payment_attempts TO authenticated;
GRANT ALL ON public.payment_attempts TO service_role;
ALTER TABLE public.payment_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "payment_attempts_read_own_org" ON public.payment_attempts
  FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());

CREATE INDEX IF NOT EXISTS payment_attempts_org_idx ON public.payment_attempts (organization_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS payment_attempts_branch_idx ON public.payment_attempts (organization_id, branch_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS payment_attempts_state_idx ON public.payment_attempts (organization_id, state);

CREATE TABLE IF NOT EXISTS public.payment_attempt_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  attempt_id uuid NOT NULL REFERENCES public.payment_attempts(id) ON DELETE CASCADE,
  from_state text,
  to_state text NOT NULL,
  detail text,
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.payment_attempt_events TO authenticated;
GRANT ALL ON public.payment_attempt_events TO service_role;
ALTER TABLE public.payment_attempt_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "payment_attempt_events_read_own_org" ON public.payment_attempt_events
  FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());

CREATE INDEX IF NOT EXISTS payment_attempt_events_attempt_idx ON public.payment_attempt_events (attempt_id, created_at DESC);

-- ============ state vocabulary ============
CREATE OR REPLACE FUNCTION public.neo_payment_state(_status text, _posted boolean DEFAULT false)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN _posted THEN 'posted'
    WHEN lower(coalesce(_status,'')) IN ('confirmed','completed','paid','success','successful','captured','settled') THEN 'confirmed'
    WHEN lower(coalesce(_status,'')) IN ('pending','processing','awaiting','submitted') THEN 'pending'
    WHEN lower(coalesce(_status,'')) IN ('requested','initiated','new') THEN 'requested'
    WHEN lower(coalesce(_status,'')) IN ('failed','declined','error') THEN 'failed'
    WHEN lower(coalesce(_status,'')) IN ('cancelled','canceled') THEN 'cancelled'
    WHEN lower(coalesce(_status,'')) IN ('timeout','timed_out','expired') THEN 'timed_out'
    WHEN lower(coalesce(_status,'')) IN ('refunded','reversed') THEN 'refunded'
    WHEN lower(coalesce(_status,'')) IN ('void','voided') THEN 'voided'
    ELSE 'requested'
  END
$$;

CREATE OR REPLACE FUNCTION public.neo_payment_manual_tender(_method text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT lower(coalesce(_method,'')) IN
    ('cash','card','bank-transfer','bank_transfer','bank','transfer','eft','voucher','corporate-credit','ota-prepaid','room-charge','other')
$$;

CREATE OR REPLACE FUNCTION public.neo_payment_provider_code(_method text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE lower(coalesce(_method,''))
    WHEN 'mpesa' THEN 'daraja'
    WHEN 'mobile' THEN 'daraja'
    WHEN 'mobile_money' THEN 'daraja'
    WHEN 'card-terminal' THEN 'card_terminal'
    WHEN 'qr' THEN 'qr_payments'
    ELSE NULL
  END
$$;

-- ============ upsert used by every mirror trigger ============
CREATE OR REPLACE FUNCTION public.neo_payment_attempt_sync(
  _org uuid, _branch uuid, _module text, _source_record uuid,
  _table text, _payment uuid, _method text, _amount numeric, _currency text,
  _reference text, _state text, _detail text, _environment text,
  _tendered numeric, _change numeric, _journal uuid, _requested timestamptz, _actor uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE prev text; att uuid;
BEGIN
  IF _org IS NULL OR _payment IS NULL THEN RETURN NULL; END IF;

  SELECT id, state INTO att, prev FROM public.payment_attempts
   WHERE payment_table = _table AND payment_id = _payment;

  IF att IS NULL THEN
    INSERT INTO public.payment_attempts (
      organization_id, branch_id, source_module, source_record_id, payment_table, payment_id,
      method, provider_code, environment, amount, currency, tendered, change_due, reference,
      state, state_detail, manual_tender, posted_journal_id, requested_at, confirmed_at, created_by)
    VALUES (_org, _branch, _module, _source_record, _table, _payment,
      coalesce(_method,'cash'), public.neo_payment_provider_code(_method), _environment,
      round(coalesce(_amount,0),2), _currency, _tendered, _change, _reference,
      _state, _detail, public.neo_payment_manual_tender(_method), _journal,
      coalesce(_requested, now()),
      CASE WHEN _state IN ('confirmed','posted') THEN now() END, _actor)
    RETURNING id INTO att;
  ELSE
    UPDATE public.payment_attempts SET
      branch_id = coalesce(_branch, branch_id),
      source_record_id = coalesce(_source_record, source_record_id),
      method = coalesce(_method, method),
      provider_code = coalesce(public.neo_payment_provider_code(_method), provider_code),
      environment = coalesce(_environment, environment),
      amount = round(coalesce(_amount, amount),2),
      currency = coalesce(_currency, currency),
      tendered = coalesce(_tendered, tendered),
      change_due = coalesce(_change, change_due),
      reference = coalesce(_reference, reference),
      state = _state,
      state_detail = coalesce(_detail, state_detail),
      posted_journal_id = coalesce(_journal, posted_journal_id),
      confirmed_at = CASE WHEN _state IN ('confirmed','posted') THEN coalesce(confirmed_at, now()) ELSE confirmed_at END,
      updated_at = now()
    WHERE id = att;
  END IF;

  IF prev IS DISTINCT FROM _state THEN
    INSERT INTO public.payment_attempt_events (organization_id, attempt_id, from_state, to_state, detail, actor_id)
    VALUES (_org, att, prev, _state, _detail, _actor);
  END IF;

  RETURN att;
END;
$$;

REVOKE ALL ON FUNCTION public.neo_payment_attempt_sync(uuid,uuid,text,uuid,text,uuid,text,numeric,text,text,text,text,text,numeric,numeric,uuid,timestamptz,uuid) FROM PUBLIC, anon, authenticated;

-- ============ mirror triggers ============
CREATE OR REPLACE FUNCTION public.trg_payment_attempt_payments()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.neo_payment_attempt_sync(
    NEW.organization_id, NEW.branch_id, coalesce(NEW.source_module,'pms'),
    coalesce(NEW.folio_id, NEW.reservation_id, NEW.source_record_id),
    'payments', NEW.id, NEW.method, NEW.amount, NEW.currency, coalesce(NEW.receipt_number, NEW.external_reference),
    public.neo_payment_state(NEW.status, NEW.posted_journal_id IS NOT NULL), NULL, NULL,
    NULL, NULL, NEW.posted_journal_id, coalesce(NEW.paid_at, NEW.created_at), NEW.received_by);
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS payment_attempt_sync ON public.payments;
CREATE TRIGGER payment_attempt_sync AFTER INSERT OR UPDATE ON public.payments
FOR EACH ROW EXECUTE FUNCTION public.trg_payment_attempt_payments();

CREATE OR REPLACE FUNCTION public.trg_payment_attempt_pos()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.neo_payment_attempt_sync(
    NEW.organization_id, NEW.branch_id, 'pos', NEW.order_id,
    'pos_payments', NEW.id, NEW.method, NEW.amount, NEW.currency,
    coalesce(NEW.receipt_number, NEW.external_reference),
    public.neo_payment_state(NEW.status, false), NEW.provider_status, NULL,
    NEW.tendered, NEW.change_due, NULL, coalesce(NEW.paid_at, NEW.created_at), NEW.cashier_id);
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS payment_attempt_sync ON public.pos_payments;
CREATE TRIGGER payment_attempt_sync AFTER INSERT OR UPDATE ON public.pos_payments
FOR EACH ROW EXECUTE FUNCTION public.trg_payment_attempt_pos();

CREATE OR REPLACE FUNCTION public.trg_payment_attempt_events()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.neo_payment_attempt_sync(
    NEW.organization_id, NEW.branch_id, 'events', NEW.booking_id,
    'event_payments', NEW.id, NEW.method, NEW.amount, NEW.currency, NEW.reference,
    CASE WHEN lower(coalesce(NEW.entry_type,'')) IN ('refund','reversal') THEN 'refunded' ELSE 'confirmed' END,
    NEW.entry_type, NULL, NULL, NULL, NULL, coalesce(NEW.recorded_at, NEW.created_at), NEW.recorded_by);
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS payment_attempt_sync ON public.event_payments;
CREATE TRIGGER payment_attempt_sync AFTER INSERT OR UPDATE ON public.event_payments
FOR EACH ROW EXECUTE FUNCTION public.trg_payment_attempt_events();

CREATE OR REPLACE FUNCTION public.trg_payment_attempt_mpesa()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.neo_payment_attempt_sync(
    NEW.organization_id, NEW.branch_id, coalesce(NEW.source_module,'mpesa'), NEW.source_record_id,
    'mpesa_transactions', NEW.id, 'mpesa', NEW.amount, NULL,
    coalesce(NEW.mpesa_receipt_number, NEW.checkout_request_id),
    public.neo_payment_state(NEW.status, false),
    coalesce(NEW.result_desc, NEW.failure_detail), NEW.environment,
    NULL, NULL, NULL, NEW.created_at, NEW.created_by);
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS payment_attempt_sync ON public.mpesa_transactions;
CREATE TRIGGER payment_attempt_sync AFTER INSERT OR UPDATE ON public.mpesa_transactions
FOR EACH ROW EXECUTE FUNCTION public.trg_payment_attempt_mpesa();

-- ============ bring existing records in, unchanged at source ============
SELECT public.neo_payment_attempt_sync(p.organization_id, p.branch_id, coalesce(p.source_module,'pms'),
  coalesce(p.folio_id, p.reservation_id, p.source_record_id), 'payments', p.id, p.method, p.amount, p.currency,
  coalesce(p.receipt_number, p.external_reference), public.neo_payment_state(p.status, p.posted_journal_id IS NOT NULL),
  NULL, NULL, NULL, NULL, p.posted_journal_id, coalesce(p.paid_at, p.created_at), p.received_by)
FROM public.payments p;

SELECT public.neo_payment_attempt_sync(p.organization_id, p.branch_id, 'pos', p.order_id, 'pos_payments', p.id,
  p.method, p.amount, p.currency, coalesce(p.receipt_number, p.external_reference),
  public.neo_payment_state(p.status, false), p.provider_status, NULL, p.tendered, p.change_due, NULL,
  coalesce(p.paid_at, p.created_at), p.cashier_id)
FROM public.pos_payments p;

SELECT public.neo_payment_attempt_sync(e.organization_id, e.branch_id, 'events', e.booking_id, 'event_payments', e.id,
  e.method, e.amount, e.currency, e.reference,
  CASE WHEN lower(coalesce(e.entry_type,'')) IN ('refund','reversal') THEN 'refunded' ELSE 'confirmed' END,
  e.entry_type, NULL, NULL, NULL, NULL, coalesce(e.recorded_at, e.created_at), e.recorded_by)
FROM public.event_payments e;

SELECT public.neo_payment_attempt_sync(m.organization_id, m.branch_id, coalesce(m.source_module,'mpesa'),
  m.source_record_id, 'mpesa_transactions', m.id, 'mpesa', m.amount, NULL,
  coalesce(m.mpesa_receipt_number, m.checkout_request_id), public.neo_payment_state(m.status, false),
  coalesce(m.result_desc, m.failure_detail), m.environment, NULL, NULL, NULL, m.created_at, m.created_by)
FROM public.mpesa_transactions m;

-- ============ readers and verification ============
CREATE OR REPLACE FUNCTION public.neo_payment_register(
  _branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL,
  _state text DEFAULT NULL, _limit integer DEFAULT 500)
RETURNS TABLE (
  id uuid, branch_id uuid, source_module text, source_record_id uuid, payment_table text, payment_id uuid,
  method text, provider_code text, environment text, amount numeric, currency text,
  tendered numeric, change_due numeric, reference text, state text, state_detail text,
  manual_tender boolean, verified_at timestamptz, posted_journal_id uuid,
  requested_at timestamptz, confirmed_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE org uuid;
BEGIN
  org := public.current_org_id();
  IF org IS NULL THEN RAISE EXCEPTION 'no_organisation' USING ERRCODE = '42501'; END IF;
  IF NOT (public.is_org_admin_for(org) OR public.has_permission('finance','view')
          OR public.has_permission('finance','edit') OR public.has_permission('finance','approve')) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT a.id, a.branch_id, a.source_module, a.source_record_id, a.payment_table, a.payment_id,
         a.method, a.provider_code, a.environment, a.amount, a.currency,
         a.tendered, a.change_due, a.reference, a.state, a.state_detail,
         a.manual_tender, a.verified_at, a.posted_journal_id, a.requested_at, a.confirmed_at
    FROM public.payment_attempts a
   WHERE a.organization_id = org
     AND (_branch IS NULL OR a.branch_id = _branch)
     AND (_from IS NULL OR a.requested_at >= _from::timestamptz)
     AND (_to IS NULL OR a.requested_at < (_to + 1)::timestamptz)
     AND (_state IS NULL OR a.state = _state)
   ORDER BY a.requested_at DESC
   LIMIT greatest(1, least(coalesce(_limit,500), 2000));
END;
$$;

REVOKE ALL ON FUNCTION public.neo_payment_register(uuid,date,date,text,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_payment_register(uuid,date,date,text,integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_payment_attempt_verify(_attempt uuid, _note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE a public.payment_attempts; org uuid;
BEGIN
  org := public.current_org_id();
  SELECT * INTO a FROM public.payment_attempts WHERE id = _attempt AND organization_id = org;
  IF a.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF NOT (public.is_org_admin_for(org) OR public.has_permission('finance','approve')) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;
  IF NOT a.manual_tender THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_manual',
      'detail', 'Only a manually recorded tender is verified by a person; a provider confirms its own payments.');
  END IF;
  IF a.verified_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_verified', 'verified_at', a.verified_at);
  END IF;

  UPDATE public.payment_attempts
     SET verified_by = auth.uid(), verified_at = now(), verification_note = _note, updated_at = now()
   WHERE id = _attempt;

  INSERT INTO public.payment_attempt_events (organization_id, attempt_id, from_state, to_state, detail, actor_id)
  VALUES (org, _attempt, a.state, a.state, coalesce(_note, 'Manual tender verified'), auth.uid());

  RETURN jsonb_build_object('ok', true, 'verified_at', now());
END;
$$;

REVOKE ALL ON FUNCTION public.neo_payment_attempt_verify(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_payment_attempt_verify(uuid,text) TO authenticated;
