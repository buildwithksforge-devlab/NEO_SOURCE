
CREATE TABLE IF NOT EXISTS public.self_approval_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  workflow_key text NOT NULL,
  reason text NOT NULL,
  effective_from date NOT NULL DEFAULT current_date,
  effective_to date,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT self_approval_exceptions_reason_len CHECK (length(btrim(reason)) >= 20)
);

CREATE UNIQUE INDEX IF NOT EXISTS self_approval_exceptions_unique
  ON public.self_approval_exceptions (organization_id, workflow_key) WHERE active;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.self_approval_exceptions TO authenticated;
GRANT ALL ON public.self_approval_exceptions TO service_role;

ALTER TABLE public.self_approval_exceptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "self_approval_exceptions_read" ON public.self_approval_exceptions;
CREATE POLICY "self_approval_exceptions_read" ON public.self_approval_exceptions
  FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "self_approval_exceptions_write" ON public.self_approval_exceptions;
CREATE POLICY "self_approval_exceptions_write" ON public.self_approval_exceptions
  FOR ALL TO authenticated
  USING (organization_id = public.current_org_id() AND public.is_org_admin_for(organization_id))
  WITH CHECK (organization_id = public.current_org_id() AND public.is_org_admin_for(organization_id));

DROP TRIGGER IF EXISTS self_approval_exceptions_touch ON public.self_approval_exceptions;
CREATE TRIGGER self_approval_exceptions_touch
  BEFORE UPDATE ON public.self_approval_exceptions
  FOR EACH ROW EXECUTE FUNCTION public.fin_touch_updated_at();

-- Generic maker/checker guard: TG_ARGV[0] = creator column, TG_ARGV[1] = approver column.
CREATE OR REPLACE FUNCTION public.neo_guard_maker_checker()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  _new jsonb := to_jsonb(NEW);
  _old jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
  _creator uuid;
  _approver uuid;
  _prev_approver uuid;
  _org uuid;
  _exception public.self_approval_exceptions%ROWTYPE;
BEGIN
  _creator := NULLIF(_new ->> TG_ARGV[0], '')::uuid;
  _approver := NULLIF(_new ->> TG_ARGV[1], '')::uuid;
  _prev_approver := NULLIF(_old ->> TG_ARGV[1], '')::uuid;

  IF _approver IS NULL OR _creator IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND _prev_approver IS NOT DISTINCT FROM _approver THEN RETURN NEW; END IF;
  IF _approver IS DISTINCT FROM _creator THEN RETURN NEW; END IF;

  _org := NULLIF(_new ->> 'organization_id', '')::uuid;

  SELECT * INTO _exception
  FROM public.self_approval_exceptions e
  WHERE e.organization_id = _org
    AND e.workflow_key = TG_TABLE_NAME
    AND e.active
    AND e.effective_from <= current_date
    AND (e.effective_to IS NULL OR e.effective_to >= current_date)
  LIMIT 1;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id,
    previous_value, new_value, reason)
  VALUES (_org, auth.uid(), '',
    CASE WHEN _exception.id IS NULL THEN 'governance.self_approval_blocked'
         ELSE 'governance.self_approval_exception_used' END,
    'governance', COALESCE(_new ->> 'id', ''),
    jsonb_build_object('table', TG_TABLE_NAME, 'creator', _creator),
    jsonb_build_object('table', TG_TABLE_NAME, 'creator', _creator, 'approver', _approver,
      'actor', auth.uid(), 'exception_id', _exception.id),
    COALESCE(_exception.reason, 'Maker/checker separation: the person who raised this record cannot approve it.'));

  IF _exception.id IS NULL THEN
    RAISE EXCEPTION 'This record was raised by you, so it must be approved by somebody else. Route it to an independent approver.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END; $$;

REVOKE ALL ON FUNCTION public.neo_guard_maker_checker() FROM PUBLIC, anon, authenticated;

DO $do$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('banquet_event_orders','created_by','approved_by'),
      ('budgets','created_by','approved_by'),
      ('campaigns','created_by','approved_by'),
      ('cash_refund_requests','requested_by','approved_by'),
      ('checkin_deposit_overrides','requested_by','approved_by'),
      ('complimentary_register','requested_by','approved_by'),
      ('corporate_credit_applications','created_by','decided_by'),
      ('corporate_credit_settings','created_by','approved_by'),
      ('credit_notes','created_by','approved_by'),
      ('employment_history','requested_by','approved_by'),
      ('employment_offers','created_by','approved_by'),
      ('event_change_requests','requested_by','decided_by'),
      ('event_quotations','created_by','approved_by'),
      ('expense_claims','requested_by','approved_by'),
      ('journal_entries','created_by','posted_by'),
      ('payroll_periods','hr_reviewed_by','posted_by'),
      ('purchase_orders','created_by','approved_by'),
      ('purchase_requests','requested_by','approved_by'),
      ('stock_adjustments','requested_by','approved_by'),
      ('supplier_invoices','created_by','approved_by'),
      ('supplier_payments','created_by','approved_by')
    ) AS v(tbl, maker, checker)
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=r.tbl AND column_name=r.maker)
       AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=r.tbl AND column_name=r.checker) THEN
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'neo_maker_checker_' || r.tbl, r.tbl);
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.neo_guard_maker_checker(%L, %L)',
        'neo_maker_checker_' || r.tbl, r.tbl, r.maker, r.checker);
    END IF;
  END LOOP;
END $do$;
