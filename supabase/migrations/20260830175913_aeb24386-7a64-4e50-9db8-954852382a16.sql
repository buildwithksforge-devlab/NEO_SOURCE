CREATE TABLE IF NOT EXISTS public.financial_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid,
  source_module text NOT NULL,
  source_id uuid NOT NULL,
  source_reference text,
  operational_status text,
  financial_status text NOT NULL DEFAULT 'pending'
    CHECK (financial_status IN ('not-applicable','pending','eligible','blocked','failed','posted','reversed')),
  reason text,
  amount numeric NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'KES',
  accounting_date date,
  period_id uuid,
  journal_id uuid,
  receipt_id uuid,
  attempts integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  last_error text,
  actor_id uuid,
  posted_at timestamptz,
  reversed_at timestamptz,
  reverses_state_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_module, source_id)
);

GRANT SELECT ON public.financial_states TO authenticated;
GRANT ALL ON public.financial_states TO service_role;

ALTER TABLE public.financial_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members read financial states in their organisation"
ON public.financial_states FOR SELECT TO authenticated
USING (organization_id = public.current_org_id());

CREATE INDEX IF NOT EXISTS financial_states_org_idx ON public.financial_states (organization_id, branch_id, accounting_date);
CREATE INDEX IF NOT EXISTS financial_states_status_idx ON public.financial_states (organization_id, financial_status);
CREATE INDEX IF NOT EXISTS financial_states_module_idx ON public.financial_states (source_module, source_id);

CREATE TRIGGER financial_states_touch
BEFORE UPDATE ON public.financial_states
FOR EACH ROW EXECUTE FUNCTION public.fin_touch_updated_at();

-- Single writer for the register. Every module funnels through here so the
-- vocabulary can never diverge between callers.
CREATE OR REPLACE FUNCTION public.neo_financial_state_set(
  _org uuid,
  _branch uuid,
  _module text,
  _source uuid,
  _reference text,
  _operational text,
  _financial text,
  _reason text,
  _amount numeric,
  _currency text,
  _accounting_date date,
  _journal uuid,
  _receipt uuid,
  _last_error text,
  _actor uuid,
  _detail jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _id uuid;
BEGIN
  IF _org IS NULL OR _source IS NULL OR _module IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.financial_states AS fs (
    organization_id, branch_id, source_module, source_id, source_reference,
    operational_status, financial_status, reason, amount, currency,
    accounting_date, journal_id, receipt_id, last_error, actor_id,
    posted_at, reversed_at, detail, attempts, last_attempt_at
  ) VALUES (
    _org, _branch, _module, _source, _reference,
    _operational, COALESCE(_financial, 'pending'), _reason, COALESCE(_amount, 0), COALESCE(_currency, 'KES'),
    _accounting_date, _journal, _receipt, _last_error, _actor,
    CASE WHEN _financial = 'posted' THEN now() END,
    CASE WHEN _financial = 'reversed' THEN now() END,
    COALESCE(_detail, '{}'::jsonb), 0, now()
  )
  ON CONFLICT (source_module, source_id) DO UPDATE SET
    branch_id = COALESCE(EXCLUDED.branch_id, fs.branch_id),
    source_reference = COALESCE(EXCLUDED.source_reference, fs.source_reference),
    operational_status = COALESCE(EXCLUDED.operational_status, fs.operational_status),
    financial_status = EXCLUDED.financial_status,
    reason = EXCLUDED.reason,
    amount = EXCLUDED.amount,
    currency = COALESCE(EXCLUDED.currency, fs.currency),
    accounting_date = COALESCE(EXCLUDED.accounting_date, fs.accounting_date),
    journal_id = COALESCE(EXCLUDED.journal_id, fs.journal_id),
    receipt_id = COALESCE(EXCLUDED.receipt_id, fs.receipt_id),
    last_error = EXCLUDED.last_error,
    actor_id = COALESCE(EXCLUDED.actor_id, fs.actor_id),
    posted_at = CASE WHEN EXCLUDED.financial_status = 'posted' THEN COALESCE(fs.posted_at, now()) ELSE fs.posted_at END,
    reversed_at = CASE WHEN EXCLUDED.financial_status = 'reversed' THEN COALESCE(fs.reversed_at, now()) ELSE fs.reversed_at END,
    detail = COALESCE(EXCLUDED.detail, fs.detail),
    attempts = fs.attempts + CASE WHEN EXCLUDED.financial_status IN ('failed','blocked') THEN 1 ELSE 0 END,
    last_attempt_at = now()
  RETURNING fs.id INTO _id;

  RETURN _id;
END;
$$;

REVOKE ALL ON FUNCTION public.neo_financial_state_set(uuid,uuid,text,uuid,text,text,text,text,numeric,text,date,uuid,uuid,text,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_financial_state_set(uuid,uuid,text,uuid,text,text,text,text,numeric,text,date,uuid,uuid,text,uuid,jsonb) TO authenticated, service_role;

-- Posting receipts are the existing engine's own record of an attempt.
CREATE OR REPLACE FUNCTION public.neo_financial_state_from_receipt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _status text;
BEGIN
  _status := CASE lower(COALESCE(NEW.status, 'pending'))
    WHEN 'posted' THEN 'posted'
    WHEN 'failed' THEN 'failed'
    WHEN 'blocked' THEN 'blocked'
    WHEN 'reversed' THEN 'reversed'
    WHEN 'eligible' THEN 'eligible'
    ELSE 'pending'
  END;

  PERFORM public.neo_financial_state_set(
    NEW.organization_id, NEW.branch_id, NEW.source_module, NEW.source_id,
    NEW.source_reference, NULL, _status,
    CASE WHEN _status IN ('failed','blocked') THEN NEW.last_error ELSE NEW.detail END,
    NEW.amount, NEW.currency, NEW.occurred_on::date, NEW.journal_id, NEW.id,
    NEW.last_error, NEW.requested_by, '{}'::jsonb
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS financial_state_from_receipt ON public.finance_posting_receipts;
CREATE TRIGGER financial_state_from_receipt
AFTER INSERT OR UPDATE ON public.finance_posting_receipts
FOR EACH ROW EXECUTE FUNCTION public.neo_financial_state_from_receipt();

-- A goods receipt keeps its operational status; its accounting consequence is
-- tracked independently so "received" can never be read as "posted".
CREATE OR REPLACE FUNCTION public.neo_financial_state_from_grn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _status text;
  _reason text;
BEGIN
  IF NEW.reversed_at IS NOT NULL THEN
    _status := 'reversed';
    _reason := COALESCE(NEW.reversal_reason, 'Receipt reversed');
  ELSIF NEW.accrual_error IS NOT NULL THEN
    _status := 'failed';
    _reason := NEW.accrual_error;
  ELSIF NEW.accrual_journal_id IS NOT NULL THEN
    _status := 'posted';
    _reason := NULL;
  ELSIF lower(COALESCE(NEW.status, '')) IN ('posted','received','completed') THEN
    _status := 'eligible';
    _reason := 'Awaiting inventory recognition and goods-received-not-invoiced accrual';
  ELSE
    _status := 'pending';
    _reason := 'Delivery not yet completed';
  END IF;

  PERFORM public.neo_financial_state_set(
    NEW.organization_id, NEW.branch_id, 'inventory-receipt', NEW.id,
    NEW.grn_number, NEW.status, _status, _reason,
    COALESCE(NEW.accrued_value, NEW.total_value, 0), 'KES',
    COALESCE(NEW.received_at::date, NEW.delivery_date::date, NEW.created_at::date),
    COALESCE(NEW.reversal_journal_id, NEW.accrual_journal_id), NULL,
    NEW.accrual_error, COALESCE(NEW.reversed_by, NEW.received_by), '{}'::jsonb
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS financial_state_from_grn ON public.goods_receipts;
CREATE TRIGGER financial_state_from_grn
AFTER INSERT OR UPDATE ON public.goods_receipts
FOR EACH ROW EXECUTE FUNCTION public.neo_financial_state_from_grn();

CREATE OR REPLACE FUNCTION public.neo_financial_state_from_supplier_invoice()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _status text;
  _reason text;
BEGIN
  IF NEW.journal_id IS NOT NULL THEN
    _status := 'posted';
  ELSIF lower(COALESCE(NEW.status, '')) IN ('reversed','cancelled','voided') THEN
    _status := 'reversed';
    _reason := NEW.notes;
  ELSIF lower(COALESCE(NEW.match_status, '')) IN ('held','exception','variance','hold') THEN
    _status := 'blocked';
    _reason := COALESCE(NEW.notes, 'Matching exception — resolution required');
  ELSIF lower(COALESCE(NEW.match_status, '')) = 'matched' THEN
    _status := 'eligible';
    _reason := 'Matched and ready for accounts payable posting';
  ELSE
    _status := 'pending';
    _reason := 'Awaiting matching against purchase order and goods receipts';
  END IF;

  PERFORM public.neo_financial_state_set(
    NEW.organization_id, NEW.branch_id, 'supplier-invoice', NEW.id,
    NEW.invoice_number, NEW.status, _status, _reason,
    COALESCE(NEW.amount, 0), 'KES',
    COALESCE(NEW.invoice_date::date, NEW.created_at::date),
    NEW.journal_id, NULL, NULL, COALESCE(NEW.approved_by, NEW.created_by), '{}'::jsonb
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS financial_state_from_supplier_invoice ON public.supplier_invoices;
CREATE TRIGGER financial_state_from_supplier_invoice
AFTER INSERT OR UPDATE ON public.supplier_invoices
FOR EACH ROW EXECUTE FUNCTION public.neo_financial_state_from_supplier_invoice();

-- Back-fill: nothing is deleted, existing rows simply gain their canonical state.
INSERT INTO public.financial_states (
  organization_id, branch_id, source_module, source_id, source_reference,
  financial_status, reason, amount, currency, accounting_date, journal_id,
  receipt_id, attempts, last_error, actor_id, posted_at
)
SELECT r.organization_id, r.branch_id, r.source_module, r.source_id, r.source_reference,
  CASE lower(COALESCE(r.status,'pending'))
    WHEN 'posted' THEN 'posted' WHEN 'failed' THEN 'failed'
    WHEN 'blocked' THEN 'blocked' WHEN 'reversed' THEN 'reversed'
    WHEN 'eligible' THEN 'eligible' ELSE 'pending' END,
  COALESCE(r.last_error, r.detail), COALESCE(r.amount,0), COALESCE(r.currency,'KES'),
  r.occurred_on::date, r.journal_id, r.id, COALESCE(r.attempts,0), r.last_error,
  r.requested_by, r.posted_at
FROM public.finance_posting_receipts r
ON CONFLICT (source_module, source_id) DO NOTHING;

INSERT INTO public.financial_states (
  organization_id, branch_id, source_module, source_id, source_reference,
  operational_status, financial_status, reason, amount, currency,
  accounting_date, journal_id, last_error, actor_id, posted_at, reversed_at
)
SELECT g.organization_id, g.branch_id, 'inventory-receipt', g.id, g.grn_number, g.status,
  CASE
    WHEN g.reversed_at IS NOT NULL THEN 'reversed'
    WHEN g.accrual_error IS NOT NULL THEN 'failed'
    WHEN g.accrual_journal_id IS NOT NULL THEN 'posted'
    WHEN lower(COALESCE(g.status,'')) IN ('posted','received','completed') THEN 'eligible'
    ELSE 'pending' END,
  CASE
    WHEN g.reversed_at IS NOT NULL THEN COALESCE(g.reversal_reason,'Receipt reversed')
    WHEN g.accrual_error IS NOT NULL THEN g.accrual_error
    WHEN g.accrual_journal_id IS NOT NULL THEN NULL
    WHEN lower(COALESCE(g.status,'')) IN ('posted','received','completed')
      THEN 'Awaiting inventory recognition and goods-received-not-invoiced accrual'
    ELSE 'Delivery not yet completed' END,
  COALESCE(g.accrued_value, g.total_value, 0), 'KES',
  COALESCE(g.received_at::date, g.delivery_date::date, g.created_at::date),
  COALESCE(g.reversal_journal_id, g.accrual_journal_id), g.accrual_error,
  COALESCE(g.reversed_by, g.received_by), g.posted_at, g.reversed_at
FROM public.goods_receipts g
ON CONFLICT (source_module, source_id) DO NOTHING;

INSERT INTO public.financial_states (
  organization_id, branch_id, source_module, source_id, source_reference,
  operational_status, financial_status, reason, amount, currency,
  accounting_date, journal_id, actor_id
)
SELECT i.organization_id, i.branch_id, 'supplier-invoice', i.id, i.invoice_number, i.status,
  CASE
    WHEN i.journal_id IS NOT NULL THEN 'posted'
    WHEN lower(COALESCE(i.status,'')) IN ('reversed','cancelled','voided') THEN 'reversed'
    WHEN lower(COALESCE(i.match_status,'')) IN ('held','exception','variance','hold') THEN 'blocked'
    WHEN lower(COALESCE(i.match_status,'')) = 'matched' THEN 'eligible'
    ELSE 'pending' END,
  CASE
    WHEN i.journal_id IS NOT NULL THEN NULL
    WHEN lower(COALESCE(i.match_status,'')) IN ('held','exception','variance','hold')
      THEN COALESCE(i.notes,'Matching exception — resolution required')
    WHEN lower(COALESCE(i.match_status,'')) = 'matched'
      THEN 'Matched and ready for accounts payable posting'
    ELSE 'Awaiting matching against purchase order and goods receipts' END,
  COALESCE(i.amount,0), 'KES', COALESCE(i.invoice_date::date, i.created_at::date),
  i.journal_id, COALESCE(i.approved_by, i.created_by)
FROM public.supplier_invoices i
ON CONFLICT (source_module, source_id) DO NOTHING;

-- Register reader: one dataset behind every Finance tile, list and drilldown.
CREATE OR REPLACE FUNCTION public.neo_financial_state_register(
  _branch uuid DEFAULT NULL,
  _from date DEFAULT NULL,
  _to date DEFAULT NULL,
  _module text DEFAULT NULL,
  _status text DEFAULT NULL
) RETURNS TABLE (
  id uuid,
  branch_id uuid,
  source_module text,
  source_id uuid,
  source_reference text,
  operational_status text,
  financial_status text,
  reason text,
  amount numeric,
  currency text,
  accounting_date date,
  journal_id uuid,
  journal_number text,
  attempts integer,
  last_attempt_at timestamptz,
  last_error text,
  posted_at timestamptz,
  reversed_at timestamptz,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT fs.id, fs.branch_id, fs.source_module, fs.source_id, fs.source_reference,
         fs.operational_status, fs.financial_status, fs.reason, fs.amount, fs.currency,
         fs.accounting_date, fs.journal_id, j.journal_number, fs.attempts, fs.last_attempt_at,
         fs.last_error, fs.posted_at, fs.reversed_at, fs.updated_at
  FROM public.financial_states fs
  LEFT JOIN public.journal_entries j ON j.id = fs.journal_id
  WHERE fs.organization_id = public.current_org_id()
    AND (_branch IS NULL OR fs.branch_id = _branch)
    AND (_from IS NULL OR fs.accounting_date >= _from)
    AND (_to IS NULL OR fs.accounting_date <= _to)
    AND (_module IS NULL OR fs.source_module = _module)
    AND (_status IS NULL OR fs.financial_status = _status)
  ORDER BY fs.updated_at DESC
  LIMIT 1000;
$$;

REVOKE ALL ON FUNCTION public.neo_financial_state_register(uuid,date,date,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_financial_state_register(uuid,date,date,text,text) TO authenticated;