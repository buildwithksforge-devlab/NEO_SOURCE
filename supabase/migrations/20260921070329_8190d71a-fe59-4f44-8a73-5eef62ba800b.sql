-- ============================================================
-- 1. Financial accounts: where money is received or paid from
-- ============================================================

ALTER TABLE public.bank_accounts
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS destination_account_id uuid REFERENCES public.bank_accounts(id);

ALTER TABLE public.reservation_deposits
  ADD COLUMN IF NOT EXISTS destination_account_id uuid REFERENCES public.bank_accounts(id);

CREATE INDEX IF NOT EXISTS payments_destination_account_idx
  ON public.payments(destination_account_id) WHERE destination_account_id IS NOT NULL;

-- One shared resolver: the ledger code money should land in.
-- A named financial account always wins; otherwise fall back to the
-- payment-method default so historical behaviour is unchanged.
CREATE OR REPLACE FUNCTION public.neo_gl_cash_code(_org uuid, _method text, _account uuid DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_code text; v_name text;
BEGIN
  IF _account IS NOT NULL THEN
    SELECT a.code INTO v_code
      FROM public.bank_accounts b
      JOIN public.chart_of_accounts a ON a.id = b.gl_account_id
     WHERE b.id = _account
       AND b.organization_id = _org
       AND a.organization_id = _org
       AND a.postable AND a.active AND coalesce(a.is_header,false) = false;
    IF v_code IS NOT NULL THEN RETURN v_code; END IF;
  END IF;

  SELECT c.code INTO v_code FROM (VALUES
      ('mpesa','1030'), ('mobile','1030'), ('mobile_money','1030'),
      ('card','1040'),
      ('bank','1020'), ('transfer','1020'), ('eft','1020')
    ) AS c(method, code)
   WHERE c.method = lower(coalesce(_method,'cash'));

  RETURN coalesce(v_code, '1010');
END $$;

CREATE OR REPLACE FUNCTION public.neo_gl_cash_name(_code text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$ SELECT CASE _code
        WHEN '1030' THEN 'M-Pesa Clearing'
        WHEN '1040' THEN 'Card Clearing'
        WHEN '1020' THEN 'Bank Accounts'
        ELSE 'Cash on Hand' END $$;

GRANT EXECUTE ON FUNCTION public.neo_gl_cash_code(uuid, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_gl_cash_name(text) TO authenticated, service_role;

-- Guest payments: honour the chosen receiving account.
CREATE OR REPLACE FUNCTION public.neo_payment_post(_payment uuid, _silent boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE p public.payments; org uuid; cur text; cash_code text; cash_name text;
        occurred date; ref text; res jsonb; jid uuid; msg text; amt numeric;
BEGIN
  SELECT * INTO p FROM public.payments WHERE id = _payment;
  IF p.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  org := p.organization_id;

  IF NOT _silent AND NOT (public.is_org_admin() OR public.has_permission('finance','edit')
                          OR public.has_permission('finance','approve')) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  IF coalesce(p.status,'') IN ('void','voided','cancelled','failed','reversed') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_eligible',
      'detail', 'A voided, cancelled or failed payment is not recognised in Finance.');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('payment:' || _payment::text, 0));

  IF p.posted_journal_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.finance_posting_receipts
                 WHERE organization_id = org AND idempotency_key = 'payment:' || _payment::text
                   AND status = 'posted') THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_posted',
      'journal_id', p.posted_journal_id, 'module', 'payment', 'source_id', _payment);
  END IF;

  amt := round(coalesce(p.amount,0), 2);
  IF amt <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_eligible',
      'detail', 'A payment with no amount cannot be recognised.');
  END IF;

  cur := coalesce(nullif(p.currency,''), public.neo_fact_currency(org, p.branch_id));
  occurred := coalesce((p.paid_at)::date, (p.created_at)::date, CURRENT_DATE);
  ref := coalesce(nullif(p.receipt_number,''), _payment::text);

  cash_code := public.neo_gl_cash_code(org, p.method, p.destination_account_id);
  cash_name := public.neo_gl_cash_name(cash_code);

  BEGIN
    PERFORM public.neo_finance_ensure_account(org, cash_code, cash_name, 'asset', 'Cash and Bank');
    PERFORM public.neo_finance_ensure_account(org, '1110', 'Guest Ledger', 'asset', 'Receivables');

    res := public.neo_gl_post(
      org, p.branch_id, 'payments', 'guest_payment', _payment, 'settlement',
      occurred, cur,
      'Guest payment ' || ref,
      jsonb_build_array(
        jsonb_build_object('code', cash_code, 'debit', amt,
                           'description', 'Payment received (' || coalesce(p.method,'cash') || ')'),
        jsonb_build_object('code', '1110', 'credit', amt,
                           'description', 'Guest ledger settled')
      ), p.customer_id);
    jid := nullif(res->>'journal_id','')::uuid;
  EXCEPTION WHEN OTHERS THEN
    msg := SQLERRM;
    PERFORM public.neo_record_posting_receipt(org, p.branch_id, 'payment', _payment, ref, 'failed',
      amt, cur, NULL, NULL, msg, occurred);
    PERFORM public.neo_financial_state_set(org, p.branch_id, 'payment', _payment, ref,
      p.status, 'failed', 'The payment could not be recognised in Finance.',
      amt, cur, occurred, NULL, NULL, msg, auth.uid(), NULL);
    IF _silent THEN RETURN jsonb_build_object('ok', false, 'reason', 'failed', 'detail', msg); END IF;
    RAISE;
  END;

  IF jid IS NOT NULL THEN
    UPDATE public.payments SET posted_journal_id = jid, updated_at = now() WHERE id = _payment;
  END IF;

  PERFORM public.neo_record_posting_receipt(org, p.branch_id, 'payment', _payment, ref,
    CASE WHEN jid IS NOT NULL THEN 'posted' ELSE 'blocked' END,
    amt, cur, NULL, res->>'detail', NULL, occurred);

  PERFORM public.neo_financial_state_set(org, p.branch_id, 'payment', _payment, ref,
    p.status, CASE WHEN jid IS NOT NULL THEN 'posted' ELSE 'blocked' END,
    'A guest payment moves cash in and reduces the guest ledger on the day it is received.',
    amt, cur, occurred, jid, NULL, NULL, auth.uid(), NULL);

  RETURN coalesce(res, '{}'::jsonb) || jsonb_build_object('module', 'payment', 'source_id', _payment);
END $function$;

-- Deposits: same resolver. Previously pointed at code 1000, which is the
-- non-postable "Assets" heading in the seeded chart, so every deposit failed.
CREATE OR REPLACE FUNCTION public.neo_deposit_post(_deposit uuid, _silent boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE d public.reservation_deposits; org uuid; cur text; cash_code text; cash_name text;
        occurred date; ref text; res jsonb; jid uuid; msg text;
BEGIN
  SELECT * INTO d FROM public.reservation_deposits WHERE id = _deposit;
  IF d.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  org := d.organization_id;

  IF NOT _silent AND NOT (public.is_org_admin() OR public.has_permission('finance','edit')
                          OR public.has_permission('finance','approve')) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('deposit:' || _deposit::text, 0));

  IF EXISTS (SELECT 1 FROM public.finance_posting_receipts
              WHERE organization_id = org AND idempotency_key = 'deposit:' || _deposit::text
                AND status = 'posted') THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_posted');
  END IF;

  cur := COALESCE(NULLIF(d.currency,''), public.neo_fact_currency(org, d.branch_id));
  occurred := COALESCE((d.received_at)::date, (d.created_at)::date, CURRENT_DATE);
  SELECT COALESCE(r.confirmation_number, d.reservation_id::text) INTO ref
    FROM public.reservations r WHERE r.id = d.reservation_id;
  ref := COALESCE(ref, _deposit::text);

  cash_code := public.neo_gl_cash_code(org, d.method, d.destination_account_id);
  cash_name := public.neo_gl_cash_name(cash_code);

  BEGIN
    PERFORM public.neo_finance_ensure_account(org, cash_code, cash_name, 'asset', 'Cash and Bank');
    PERFORM public.neo_finance_ensure_account(org, '2020', 'Guest Deposits', 'liability', 'Liabilities');

    res := public.neo_gl_post(
      org, d.branch_id, 'pms', 'reservation_deposit', _deposit, 'deposit',
      occurred, cur,
      'Pre-arrival deposit ' || ref,
      jsonb_build_array(
        jsonb_build_object('code', cash_code, 'debit', round(COALESCE(d.amount,0),2),
                           'description', 'Deposit received (' || COALESCE(d.method,'cash') || ')'),
        jsonb_build_object('code', '2020', 'credit', round(COALESCE(d.amount,0),2),
                           'description', 'Guest deposit held')
      ), d.customer_id);
    jid := NULLIF(res->>'journal_id','')::uuid;
  EXCEPTION WHEN OTHERS THEN
    msg := SQLERRM;
    PERFORM public.neo_record_posting_receipt(org, d.branch_id, 'deposit', _deposit, ref, 'failed',
      COALESCE(d.amount,0), cur, NULL, NULL, msg, occurred);
    PERFORM public.neo_financial_state_set(org, d.branch_id, 'deposit', _deposit, ref,
      d.status, 'failed', 'The deposit could not be recognised in Finance.',
      COALESCE(d.amount,0), cur, occurred, NULL, NULL, msg, auth.uid(), NULL);
    IF _silent THEN RETURN jsonb_build_object('ok', false, 'reason', 'failed', 'detail', msg); END IF;
    RAISE;
  END;

  PERFORM public.neo_record_posting_receipt(org, d.branch_id, 'deposit', _deposit, ref,
    CASE WHEN jid IS NOT NULL THEN 'posted' ELSE 'blocked' END,
    COALESCE(d.amount,0), cur, NULL, res->>'detail', NULL, occurred);

  PERFORM public.neo_financial_state_set(org, d.branch_id, 'deposit', _deposit, ref,
    d.status, CASE WHEN jid IS NOT NULL THEN 'posted' ELSE 'blocked' END,
    'A pre-arrival deposit is held as a liability until it is applied to the guest folio.',
    COALESCE(d.amount,0), cur, occurred, jid, NULL, NULL, auth.uid(), NULL);

  RETURN COALESCE(res, '{}'::jsonb) || jsonb_build_object('module', 'deposit', 'source_id', _deposit);
END $function$;

-- Financial accounts a property can receive money into, for selectors.
CREATE OR REPLACE FUNCTION public.neo_financial_accounts(_branch uuid DEFAULT NULL)
RETURNS TABLE(id uuid, name text, account_kind text, currency text, branch_id uuid,
              gl_code text, is_default boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT b.id, b.name, b.account_kind, b.currency, b.branch_id, a.code, b.is_default
    FROM public.bank_accounts b
    LEFT JOIN public.chart_of_accounts a ON a.id = b.gl_account_id
   WHERE b.organization_id = public.current_org_id()
     AND b.active
     AND (_branch IS NULL OR b.branch_id IS NULL OR b.branch_id = _branch)
   ORDER BY b.is_default DESC, b.account_kind, b.name;
$$;

GRANT EXECUTE ON FUNCTION public.neo_financial_accounts(uuid) TO authenticated, service_role;

-- ============================================================
-- 2. Accounting periods open when their dates arrive
-- ============================================================

CREATE OR REPLACE FUNCTION public.neo_fin_activate_due_periods(_org uuid, _date date)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  UPDATE public.accounting_periods
     SET status = 'open', updated_at = now()
   WHERE organization_id = _org
     AND status = 'future'
     AND starts_on <= greatest(_date, CURRENT_DATE);
END $$;

GRANT EXECUTE ON FUNCTION public.neo_fin_activate_due_periods(uuid, date) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fin_period_for(_org uuid, _date date)
RETURNS accounting_periods
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE p public.accounting_periods;
BEGIN
  SELECT * INTO p
    FROM public.accounting_periods
   WHERE organization_id = _org AND _date BETWEEN starts_on AND ends_on
   ORDER BY
     CASE status WHEN 'open' THEN 0 WHEN 'closed' THEN 1 WHEN 'locked' THEN 2 ELSE 3 END,
     created_at DESC
   LIMIT 1;

  -- A month whose dates have already arrived is open, not future. Closing and
  -- locking stay deliberate acts and are never undone here.
  IF p.id IS NOT NULL AND p.status = 'future' AND p.starts_on <= CURRENT_DATE THEN
    p.status := 'open';
  END IF;
  RETURN p;
END $$;

-- ============================================================
-- 3. Stock cannot silently go below zero
-- ============================================================

CREATE TABLE IF NOT EXISTS public.inventory_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid,
  allow_negative_stock boolean NOT NULL DEFAULT false,
  note text,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS inventory_policies_org_branch_idx
  ON public.inventory_policies(organization_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid));

GRANT SELECT, INSERT, UPDATE ON public.inventory_policies TO authenticated;
GRANT ALL ON public.inventory_policies TO service_role;

ALTER TABLE public.inventory_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inventory_policies_read ON public.inventory_policies;
CREATE POLICY inventory_policies_read ON public.inventory_policies
  FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS inventory_policies_write ON public.inventory_policies;
CREATE POLICY inventory_policies_write ON public.inventory_policies
  FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id()
              AND (public.is_org_admin_for(organization_id)
                   OR public.has_permission('inventory','settings.manage')
                   OR public.has_permission('inventory','stock.manage')));

DROP POLICY IF EXISTS inventory_policies_update ON public.inventory_policies;
CREATE POLICY inventory_policies_update ON public.inventory_policies
  FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id()
         AND (public.is_org_admin_for(organization_id)
              OR public.has_permission('inventory','settings.manage')
              OR public.has_permission('inventory','stock.manage')))
  WITH CHECK (organization_id = public.current_org_id());

CREATE OR REPLACE FUNCTION public.neo_inventory_allows_negative(_org uuid, _branch uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT coalesce((
    SELECT p.allow_negative_stock FROM public.inventory_policies p
     WHERE p.organization_id = _org
       AND (p.branch_id = _branch OR p.branch_id IS NULL)
     ORDER BY (p.branch_id IS NOT NULL) DESC
     LIMIT 1), false);
$$;

GRANT EXECUTE ON FUNCTION public.neo_inventory_allows_negative(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.inventory_apply_movement(_item uuid, _location uuid, _quantity numeric, _unit text, _movement_type text, _unit_cost numeric DEFAULT NULL::numeric, _reference_type text DEFAULT NULL::text, _reference_id uuid DEFAULT NULL::uuid, _reason text DEFAULT NULL::text, _idempotency_key text DEFAULT NULL::text, _batch_number text DEFAULT NULL::text, _expiry date DEFAULT NULL::date)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := current_org_id();
  v_item record;
  v_qty_base numeric;
  v_cost numeric;
  v_level record;
  v_batch uuid;
  v_movement uuid;
  v_existing uuid;
  v_available numeric;
  v_store text;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No active organization'; END IF;
  IF NOT public.neo_system_posting()
     AND NOT (has_permission('inventory','stock.manage') OR has_permission('procurement','receiving.manage')) THEN
    RAISE EXCEPTION 'Not permitted to move stock';
  END IF;

  IF _idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing FROM stock_movements WHERE organization_id = v_org AND idempotency_key = _idempotency_key;
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_item FROM stock_items WHERE id = _item AND organization_id = v_org;
  IF v_item IS NULL THEN RAISE EXCEPTION 'Unknown stock item'; END IF;

  v_qty_base := inventory_convert(_quantity, COALESCE(_unit, v_item.base_unit), v_item.base_unit);
  v_cost := COALESCE(_unit_cost, v_item.average_cost);

  INSERT INTO stock_levels (organization_id, stock_item_id, location_id, quantity_on_hand, last_movement_at)
  VALUES (v_org, _item, _location, 0, now())
  ON CONFLICT (stock_item_id, location_id) DO NOTHING;

  SELECT * INTO v_level FROM stock_levels WHERE stock_item_id = _item AND location_id = _location FOR UPDATE;

  -- Taking out more than is there creates impossible inventory. A count,
  -- adjustment or opening balance must still be able to state reality.
  IF v_qty_base < 0
     AND COALESCE(v_level.quantity_on_hand, 0) + v_qty_base < 0
     AND lower(COALESCE(_movement_type,'')) NOT IN
         ('count','stock_take','stock-take','adjustment','opening','opening_balance','variance','recount','correction')
     AND NOT public.neo_inventory_allows_negative(v_org, v_item.branch_id) THEN
    SELECT sl.name INTO v_store FROM stock_locations sl WHERE sl.id = _location;
    v_available := round(COALESCE(v_level.quantity_on_hand, 0), 4);
    RAISE EXCEPTION 'Not enough %: % % available in %, % % requested',
      v_item.name,
      trim(to_char(GREATEST(v_available,0), 'FM999999990.###')), v_item.base_unit,
      COALESCE(v_store, 'this store'),
      trim(to_char(abs(v_qty_base), 'FM999999990.###')), v_item.base_unit
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_qty_base > 0 AND (v_item.track_batches OR _batch_number IS NOT NULL OR _expiry IS NOT NULL) THEN
    INSERT INTO stock_batches (organization_id, stock_item_id, location_id, batch_number, expiry_date, quantity, unit_cost)
    VALUES (v_org, _item, _location, _batch_number, _expiry, v_qty_base, v_cost)
    RETURNING id INTO v_batch;
  ELSIF v_qty_base < 0 THEN
    SELECT id INTO v_batch FROM stock_batches
      WHERE stock_item_id = _item AND location_id = _location AND quantity > 0 AND status = 'active'
      ORDER BY expiry_date NULLS LAST, received_at LIMIT 1;
    IF v_batch IS NOT NULL THEN
      UPDATE stock_batches SET quantity = GREATEST(0, quantity + v_qty_base) WHERE id = v_batch;
    END IF;
  END IF;

  UPDATE stock_levels
     SET quantity_on_hand = quantity_on_hand + v_qty_base,
         quantity_damaged = quantity_damaged + CASE WHEN _movement_type = 'damage' THEN abs(v_qty_base) ELSE 0 END,
         quantity_expired = quantity_expired + CASE WHEN _movement_type = 'expiry' THEN abs(v_qty_base) ELSE 0 END,
         last_movement_at = now()
   WHERE id = v_level.id;

  IF v_qty_base > 0 AND _unit_cost IS NOT NULL THEN
    UPDATE stock_items
       SET last_cost = v_cost,
           average_cost = CASE
             WHEN COALESCE(v_level.quantity_on_hand, 0) + v_qty_base <= 0 THEN v_cost
             ELSE ((GREATEST(v_level.quantity_on_hand, 0) * average_cost) + (v_qty_base * v_cost))
                  / (GREATEST(v_level.quantity_on_hand, 0) + v_qty_base)
           END
     WHERE id = _item;
  END IF;

  INSERT INTO stock_movements (
    organization_id, branch_id, stock_item_id, location_id, batch_id, movement_type,
    quantity, unit, unit_cost, value, balance_after, reference_type, reference_id,
    reason, idempotency_key, performed_by
  ) VALUES (
    v_org, v_item.branch_id, _item, _location, v_batch, _movement_type,
    v_qty_base, v_item.base_unit, v_cost, v_qty_base * v_cost,
    (SELECT quantity_on_hand FROM stock_levels WHERE id = v_level.id),
    _reference_type, _reference_id, _reason, _idempotency_key, auth.uid()
  ) RETURNING id INTO v_movement;

  RETURN v_movement;
END;
$function$;

-- Register the new privileged routines
INSERT INTO public.privileged_function_review
 (function_name, identity_arguments, reachability, sensitive, establishes_tenant_context,
  classification, trusts_client_tenant, search_path_fixed, domain, review_note)
VALUES
 ('neo_gl_cash_code','_org uuid, _method text, _account uuid','internal_only', false, false,
  'internal_privileged', false, true, 'other',
  'Resolves which ledger account money landed in: the named financial account when the hotel chose one, otherwise the payment-method default.'),
 ('neo_financial_accounts','_branch uuid','app_callable', false, false,
  'tenant_derived_privileged', false, true, 'other',
  'Lists the active tills, bank and settlement accounts of the caller''s own workspace for selection.'),
 ('neo_fin_activate_due_periods','_org uuid, _date date','internal_only', false, false,
  'internal_privileged', false, true, 'other',
  'Opens an accounting month whose dates have arrived. Never reopens a closed or locked month.'),
 ('neo_inventory_allows_negative','_org uuid, _branch uuid','internal_only', false, false,
  'internal_privileged', false, true, 'other',
  'Reads the hotel''s policy on whether stock may fall below zero.')
ON CONFLICT DO NOTHING;