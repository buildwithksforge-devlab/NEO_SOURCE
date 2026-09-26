
-- ============ FOLIOS =============
ALTER TABLE public.folio_lines
  ADD COLUMN IF NOT EXISTS customer_id uuid,
  ADD COLUMN IF NOT EXISTS revenue_centre text NOT NULL DEFAULT 'rooms',
  ADD COLUMN IF NOT EXISTS service_charge_amount numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS source_record_uuid uuid,
  ADD COLUMN IF NOT EXISTS correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS actor_id uuid,
  ADD COLUMN IF NOT EXISTS transferred_from_folio_id uuid,
  ADD COLUMN IF NOT EXISTS transfer_reason text NOT NULL DEFAULT '';

UPDATE public.folio_lines SET actor_id = posted_by WHERE actor_id IS NULL AND posted_by IS NOT NULL;

ALTER TABLE public.folios
  ADD COLUMN IF NOT EXISTS closed_by uuid,
  ADD COLUMN IF NOT EXISTS reopen_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reopened_by uuid,
  ADD COLUMN IF NOT EXISTS reopened_at timestamptz,
  ADD COLUMN IF NOT EXISTS reopen_reason text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS billing_instructions text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS event_booking_id uuid;

DELETE FROM public.folio_lines a USING public.folio_lines b
 WHERE a.ctid > b.ctid AND a.organization_id = b.organization_id
   AND a.idempotency_key IS NOT NULL AND a.idempotency_key = b.idempotency_key;

CREATE UNIQUE INDEX IF NOT EXISTS folio_lines_idempotency_unique
  ON public.folio_lines (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS folio_lines_source_idx
  ON public.folio_lines (organization_id, source_module, source_record_id);

-- Closed folios cannot be edited directly
CREATE OR REPLACE FUNCTION public.tg_folio_line_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _status text;
BEGIN
  SELECT status INTO _status FROM public.folios
   WHERE id = COALESCE(NEW.folio_id, OLD.folio_id);
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Folio charges cannot be deleted. Post a reversal or credit note instead.';
  END IF;
  IF _status IN ('closed','settled','invoiced') AND current_setting('neo.folio_maintenance', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Folio is % and cannot be edited. Reopen it or post a credit note/reversal.', _status;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'posted'
     AND (NEW.gross_amount IS DISTINCT FROM OLD.gross_amount
       OR NEW.net_amount IS DISTINCT FROM OLD.net_amount
       OR NEW.tax_amount IS DISTINCT FROM OLD.tax_amount)
     AND current_setting('neo.folio_maintenance', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Posted folio charges are immutable. Use a reversal, allowance or credit note.';
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_folio_line_immutable ON public.folio_lines;
CREATE TRIGGER trg_folio_line_immutable BEFORE UPDATE OR DELETE ON public.folio_lines
  FOR EACH ROW EXECUTE FUNCTION public.tg_folio_line_immutable();

-- Rich charge posting
CREATE OR REPLACE FUNCTION public.folio_post_charge(
  _folio uuid, _category text, _description text, _quantity numeric, _unit_price numeric,
  _tax numeric DEFAULT 0, _service_charge numeric DEFAULT 0, _discount numeric DEFAULT 0,
  _source_module text DEFAULT 'manual', _source_record uuid DEFAULT NULL,
  _revenue_centre text DEFAULT 'rooms', _idempotency_key text DEFAULT NULL,
  _correlation uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _org uuid := public.current_org_id(); _f public.folios; _gross numeric; _net numeric; _id uuid;
        _key text := COALESCE(_idempotency_key, _source_module || ':' || COALESCE(_source_record::text, gen_random_uuid()::text));
BEGIN
  IF NOT public.has_permission('pms','folios.post_charge') THEN RAISE EXCEPTION 'Not permitted to post charges'; END IF;
  SELECT * INTO _f FROM public.folios WHERE id=_folio AND organization_id=_org FOR UPDATE;
  IF _f.id IS NULL THEN RAISE EXCEPTION 'Folio not found'; END IF;
  IF _f.status <> 'open' THEN RAISE EXCEPTION 'Folio is % and cannot accept charges', _f.status; END IF;

  SELECT id INTO _id FROM public.folio_lines WHERE organization_id=_org AND idempotency_key=_key;
  IF _id IS NOT NULL THEN RETURN _id; END IF;

  IF _f.corporate_account_id IS NOT NULL THEN
    PERFORM public.corp_assert_credit(_f.corporate_account_id, _f.branch_id, _f.customer_id,
      round(COALESCE(_quantity,1)*COALESCE(_unit_price,0),2) + COALESCE(_tax,0) + COALESCE(_service_charge,0));
  END IF;

  _gross := round(COALESCE(_quantity,1) * COALESCE(_unit_price,0), 2);
  _net := _gross - COALESCE(_discount,0) + COALESCE(_tax,0) + COALESCE(_service_charge,0);

  INSERT INTO public.folio_lines (organization_id, branch_id, folio_id, reservation_id, customer_id, line_type,
    category, revenue_centre, reference, source_module, source_record_id, source_record_uuid, idempotency_key,
    description, quantity, unit_price, gross_amount, discount_amount, tax_amount, service_charge_amount,
    net_amount, posted_by, actor_id, correlation_id, status)
  VALUES (_org, _f.branch_id, _folio, _f.reservation_id, _f.customer_id, 'charge',
    _category, COALESCE(_revenue_centre,'rooms'), COALESCE(_source_record::text,''), _source_module,
    _source_record::text, _source_record, _key, _description, COALESCE(_quantity,1), COALESCE(_unit_price,0),
    _gross, COALESCE(_discount,0), COALESCE(_tax,0), COALESCE(_service_charge,0), _net,
    auth.uid(), auth.uid(), COALESCE(_correlation, gen_random_uuid()), 'posted')
  RETURNING id INTO _id;

  UPDATE public.folios SET
    total_charges = total_charges + _gross,
    total_discounts = total_discounts + COALESCE(_discount,0),
    total_taxes = total_taxes + COALESCE(_tax,0),
    balance = balance + _net, updated_at = now()
  WHERE id=_folio;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (_org, auth.uid(), '', 'pms.folio.post_charge', 'finance', _folio::text,
    jsonb_build_object('line_id',_id,'category',_category,'amount',_net,'source',_source_module,'revenue_centre',_revenue_centre));
  RETURN _id;
END; $$;
REVOKE ALL ON FUNCTION public.folio_post_charge(uuid,text,text,numeric,numeric,numeric,numeric,numeric,text,uuid,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.folio_post_charge(uuid,text,text,numeric,numeric,numeric,numeric,numeric,text,uuid,text,text,uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.folio_transfer_line(_line uuid, _target_folio uuid, _reason text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _org uuid := public.current_org_id(); _l public.folio_lines; _t public.folios; _new uuid;
BEGIN
  IF NOT public.has_permission('pms','folios.transfer') AND NOT public.has_permission('pms','folios.post_charge') THEN
    RAISE EXCEPTION 'Not permitted to transfer charges'; END IF;
  IF COALESCE(trim(_reason),'') = '' THEN RAISE EXCEPTION 'A transfer reason is required'; END IF;
  SELECT * INTO _l FROM public.folio_lines WHERE id=_line AND organization_id=_org;
  IF _l.id IS NULL THEN RAISE EXCEPTION 'Charge not found'; END IF;
  SELECT * INTO _t FROM public.folios WHERE id=_target_folio AND organization_id=_org FOR UPDATE;
  IF _t.id IS NULL OR _t.status <> 'open' THEN RAISE EXCEPTION 'Target folio is not open'; END IF;

  INSERT INTO public.folio_lines (organization_id, branch_id, folio_id, reservation_id, customer_id, line_type,
    category, revenue_centre, reference, source_module, source_record_id, source_record_uuid, idempotency_key,
    description, quantity, unit_price, gross_amount, discount_amount, tax_amount, service_charge_amount,
    net_amount, posted_by, actor_id, correlation_id, status, transferred_from_folio_id, transfer_reason)
  VALUES (_org, _t.branch_id, _target_folio, _t.reservation_id, _t.customer_id, _l.line_type,
    _l.category, _l.revenue_centre, _l.reference, _l.source_module, _l.source_record_id, _l.source_record_uuid,
    'transfer:' || _line::text || ':' || _target_folio::text, _l.description, _l.quantity, _l.unit_price,
    _l.gross_amount, _l.discount_amount, _l.tax_amount, _l.service_charge_amount, _l.net_amount,
    auth.uid(), auth.uid(), _l.correlation_id, 'posted', _l.folio_id, _reason)
  RETURNING id INTO _new;

  PERFORM public.folio_reverse_line(_line, 'Transferred to folio ' || _t.folio_number || ': ' || _reason);
  UPDATE public.folios SET total_charges = total_charges + _l.gross_amount,
    total_taxes = total_taxes + _l.tax_amount, balance = balance + _l.net_amount, updated_at = now()
  WHERE id = _target_folio;
  RETURN _new;
END; $$;

CREATE OR REPLACE FUNCTION public.folio_reverse_line(_line uuid, _reason text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _org uuid := public.current_org_id(); _l public.folio_lines; _id uuid;
BEGIN
  IF NOT public.has_permission('pms','folios.post_charge') THEN RAISE EXCEPTION 'Not permitted to reverse charges'; END IF;
  IF COALESCE(trim(_reason),'') = '' THEN RAISE EXCEPTION 'A reversal reason is required'; END IF;
  SELECT * INTO _l FROM public.folio_lines WHERE id=_line AND organization_id=_org;
  IF _l.id IS NULL THEN RAISE EXCEPTION 'Charge not found'; END IF;
  IF EXISTS (SELECT 1 FROM public.folio_lines WHERE reverses_line_id = _line) THEN
    RETURN (SELECT id FROM public.folio_lines WHERE reverses_line_id = _line LIMIT 1); END IF;

  INSERT INTO public.folio_lines (organization_id, branch_id, folio_id, reservation_id, customer_id, line_type,
    category, revenue_centre, reference, source_module, source_record_id, source_record_uuid, idempotency_key,
    description, quantity, unit_price, gross_amount, discount_amount, tax_amount, service_charge_amount,
    net_amount, posted_by, actor_id, correlation_id, status, reverses_line_id)
  VALUES (_org, _l.branch_id, _l.folio_id, _l.reservation_id, _l.customer_id, 'reversal',
    _l.category, _l.revenue_centre, _l.reference, _l.source_module, _l.source_record_id, _l.source_record_uuid,
    'reversal:' || _line::text, 'Reversal: ' || _l.description || ' — ' || _reason, _l.quantity, -_l.unit_price,
    -_l.gross_amount, -_l.discount_amount, -_l.tax_amount, -_l.service_charge_amount, -_l.net_amount,
    auth.uid(), auth.uid(), _l.correlation_id, 'posted', _line)
  RETURNING id INTO _id;

  UPDATE public.folios SET total_charges = total_charges - _l.gross_amount,
    total_taxes = total_taxes - _l.tax_amount, balance = balance - _l.net_amount, updated_at = now()
  WHERE id = _l.folio_id;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, previous_value, new_value, reason)
  VALUES (_org, auth.uid(), '', 'pms.folio.reverse_charge', 'finance', _l.folio_id::text,
    to_jsonb(_l), jsonb_build_object('reversal_line', _id), _reason);
  RETURN _id;
END; $$;

CREATE OR REPLACE FUNCTION public.folio_reopen(_folio uuid, _reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _org uuid := public.current_org_id(); _f public.folios;
BEGIN
  IF NOT public.has_permission('finance','folios.reopen') AND NOT public.is_org_admin() THEN
    RAISE EXCEPTION 'Not permitted to reopen folios'; END IF;
  IF COALESCE(trim(_reason),'') = '' THEN RAISE EXCEPTION 'A reopening reason is required'; END IF;
  SELECT * INTO _f FROM public.folios WHERE id=_folio AND organization_id=_org FOR UPDATE;
  IF _f.id IS NULL THEN RAISE EXCEPTION 'Folio not found'; END IF;
  IF _f.status = 'open' THEN RETURN jsonb_build_object('status','open','changed',false); END IF;
  UPDATE public.folios SET status='open', reopen_count = reopen_count + 1, reopened_by = auth.uid(),
    reopened_at = now(), reopen_reason = _reason, closed_at = NULL, updated_at = now()
  WHERE id = _folio;
  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, previous_value, new_value, reason)
  VALUES (_org, auth.uid(), '', 'pms.folio.reopen', 'finance', _folio::text,
    jsonb_build_object('status', _f.status), jsonb_build_object('status','open'), _reason);
  RETURN jsonb_build_object('status','open','changed',true);
END; $$;

REVOKE ALL ON FUNCTION public.folio_transfer_line(uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.folio_reverse_line(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.folio_reopen(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.folio_transfer_line(uuid,uuid,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.folio_reverse_line(uuid,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.folio_reopen(uuid,text) TO authenticated, service_role;

-- ============ CORPORATE CREDIT =============
ALTER TABLE public.corporate_credit_settings
  ADD COLUMN IF NOT EXISTS effective_from date NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS effective_to date,
  ADD COLUMN IF NOT EXISTS authorized_branch_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  ADD COLUMN IF NOT EXISTS suspension_reason text NOT NULL DEFAULT '';

CREATE OR REPLACE FUNCTION public.corp_credit_check(
  _account uuid, _branch uuid DEFAULT NULL, _customer uuid DEFAULT NULL, _amount numeric DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _org uuid := public.current_org_id(); _a public.corporate_accounts; _s public.corporate_credit_settings;
        _reasons text[] := '{}'; _exposure numeric := 0;
BEGIN
  SELECT * INTO _a FROM public.corporate_accounts WHERE id=_account AND organization_id=_org;
  IF _a.id IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reasons', to_jsonb(ARRAY['Corporate account not found']));
  END IF;
  IF _a.account_status <> 'active' THEN _reasons := _reasons || ('Account status is ' || _a.account_status); END IF;

  SELECT * INTO _s FROM public.corporate_credit_settings WHERE corporate_account_id=_account AND organization_id=_org
   ORDER BY updated_at DESC LIMIT 1;
  IF _s.id IS NULL THEN _reasons := _reasons || 'No approved credit agreement exists';
  ELSE
    IF _s.credit_status <> 'approved' THEN _reasons := _reasons || ('Credit status is ' || _s.credit_status); END IF;
    IF _s.effective_from > CURRENT_DATE THEN _reasons := _reasons || 'Credit agreement is not yet effective'; END IF;
    IF _s.effective_to IS NOT NULL AND _s.effective_to < CURRENT_DATE THEN _reasons := _reasons || 'Credit agreement has expired'; END IF;
    IF _s.risk_status = 'suspended' THEN _reasons := _reasons || COALESCE(NULLIF(_s.suspension_reason,''),'Account suspended'); END IF;
    IF _branch IS NOT NULL AND array_length(_s.authorized_branch_ids,1) IS NOT NULL
       AND NOT (_branch = ANY(_s.authorized_branch_ids)) THEN
      _reasons := _reasons || 'Property is not authorised on this credit agreement'; END IF;
    SELECT COALESCE(sum(f.balance),0) INTO _exposure FROM public.folios f
      WHERE f.corporate_account_id = _account AND f.organization_id = _org AND f.status IN ('open','invoiced');
    IF (_exposure + COALESCE(_amount,0)) > COALESCE(_s.credit_limit,0) THEN
      _reasons := _reasons || format('Credit limit exceeded (exposure %s + %s > limit %s)',
        round(_exposure,2), round(COALESCE(_amount,0),2), round(COALESCE(_s.credit_limit,0),2)); END IF;
  END IF;

  IF _customer IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.corporate_contacts c WHERE c.corporate_account_id=_account AND c.customer_id=_customer)
     AND NOT EXISTS (SELECT 1 FROM public.corporate_contacts c WHERE c.corporate_account_id=_account) THEN
    _reasons := _reasons || 'No authorised contact recorded for this account';
  END IF;

  RETURN jsonb_build_object(
    'allowed', array_length(_reasons,1) IS NULL,
    'reasons', to_jsonb(_reasons),
    'exposure', _exposure,
    'credit_limit', COALESCE(_s.credit_limit,0),
    'available', GREATEST(COALESCE(_s.credit_limit,0) - _exposure, 0));
END; $$;

CREATE OR REPLACE FUNCTION public.corp_assert_credit(
  _account uuid, _branch uuid, _customer uuid, _amount numeric)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _res jsonb;
BEGIN
  _res := public.corp_credit_check(_account, _branch, _customer, _amount);
  IF NOT (_res->>'allowed')::boolean THEN
    RAISE EXCEPTION 'Corporate credit refused: %', array_to_string(
      ARRAY(SELECT jsonb_array_elements_text(_res->'reasons')), '; ');
  END IF;
END; $$;

CREATE OR REPLACE FUNCTION public.corp_account_aging(_account uuid)
RETURNS TABLE(bucket text, amount numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT b.bucket, COALESCE(sum(f.balance),0)
  FROM (VALUES ('current',0,30),('31-60',31,60),('61-90',61,90),('90+',91,100000)) AS b(bucket,lo,hi)
  LEFT JOIN public.folios f
    ON f.corporate_account_id = _account
   AND f.organization_id = public.current_org_id()
   AND f.status IN ('open','invoiced')
   AND (CURRENT_DATE - f.opened_at::date) BETWEEN b.lo AND b.hi
  GROUP BY b.bucket, b.lo ORDER BY b.lo;
$$;

REVOKE ALL ON FUNCTION public.corp_credit_check(uuid,uuid,uuid,numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corp_assert_credit(uuid,uuid,uuid,numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corp_account_aging(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.corp_credit_check(uuid,uuid,uuid,numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.corp_assert_credit(uuid,uuid,uuid,numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.corp_account_aging(uuid) TO authenticated, service_role;

-- ============ PAYMENTS & CASHIER SHIFTS =============
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS shift_id uuid,
  ADD COLUMN IF NOT EXISTS station_id uuid,
  ADD COLUMN IF NOT EXISTS source_module text NOT NULL DEFAULT 'pms',
  ADD COLUMN IF NOT EXISTS source_record_id uuid,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS posted_journal_id uuid;

DELETE FROM public.payments a USING public.payments b
 WHERE a.ctid > b.ctid AND a.organization_id = b.organization_id
   AND a.idempotency_key IS NOT NULL AND a.idempotency_key = b.idempotency_key;
CREATE UNIQUE INDEX IF NOT EXISTS payments_idempotency_unique
  ON public.payments (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

ALTER TABLE public.pos_shifts
  ADD COLUMN IF NOT EXISTS shift_number text,
  ADD COLUMN IF NOT EXISTS opened_by uuid,
  ADD COLUMN IF NOT EXISTS closed_by uuid,
  ADD COLUMN IF NOT EXISTS total_drops numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_paid_outs numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS review_approval_request_id uuid,
  ADD COLUMN IF NOT EXISTS posted_journal_id uuid,
  ADD COLUMN IF NOT EXISTS correlation_id uuid NOT NULL DEFAULT gen_random_uuid();

CREATE OR REPLACE FUNCTION public.tg_payment_controls()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _shift public.pos_shifts;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.method = 'cash' THEN
      IF NEW.shift_id IS NULL THEN RAISE EXCEPTION 'Cash payments must reference an open cashier shift'; END IF;
    END IF;
    IF NEW.shift_id IS NOT NULL THEN
      SELECT * INTO _shift FROM public.pos_shifts WHERE id = NEW.shift_id;
      IF _shift.id IS NULL THEN RAISE EXCEPTION 'Cashier shift not found'; END IF;
      IF _shift.status <> 'open' THEN RAISE EXCEPTION 'Cashier shift is % and cannot accept payments', _shift.status; END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'confirmed' AND current_setting('neo.payment_maintenance', true) IS DISTINCT FROM 'on' THEN
    IF NEW.amount IS DISTINCT FROM OLD.amount OR NEW.method IS DISTINCT FROM OLD.method
       OR NEW.folio_id IS DISTINCT FROM OLD.folio_id OR NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'Confirmed payments cannot be edited. Post a refund or reversal instead.';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_payment_controls ON public.payments;
CREATE TRIGGER trg_payment_controls BEFORE INSERT OR UPDATE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.tg_payment_controls();

CREATE OR REPLACE FUNCTION public.cash_open_shift(_branch uuid, _station uuid, _float numeric)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _org uuid := public.current_org_id(); _id uuid;
BEGIN
  IF NOT public.has_permission('pos','shifts.open') AND NOT public.has_permission('pos','write') THEN
    RAISE EXCEPTION 'Not permitted to open a cashier shift'; END IF;
  SELECT id INTO _id FROM public.pos_shifts
   WHERE organization_id=_org AND cashier_id = auth.uid() AND status='open'
     AND COALESCE(branch_id::text,'') = COALESCE(_branch::text,'') LIMIT 1;
  IF _id IS NOT NULL THEN RETURN _id; END IF;
  INSERT INTO public.pos_shifts (organization_id, branch_id, station_id, cashier_id, opened_by,
    opening_float, status, shift_number)
  VALUES (_org, _branch, _station, auth.uid(), auth.uid(), COALESCE(_float,0), 'open',
    to_char(now(),'YYYYMMDD-HH24MI') || '-' || substr(auth.uid()::text,1,4))
  RETURNING id INTO _id;
  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (_org, auth.uid(), '', 'pos.shift.open', 'pos', _id::text, jsonb_build_object('float', _float));
  RETURN _id;
END; $$;

CREATE OR REPLACE FUNCTION public.cash_record_movement(_shift uuid, _type text, _amount numeric, _reason text, _reference text DEFAULT '')
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _org uuid := public.current_org_id(); _s public.pos_shifts; _id uuid;
BEGIN
  SELECT * INTO _s FROM public.pos_shifts WHERE id=_shift AND organization_id=_org FOR UPDATE;
  IF _s.id IS NULL THEN RAISE EXCEPTION 'Shift not found'; END IF;
  IF _s.status <> 'open' THEN RAISE EXCEPTION 'Shift is % and cannot accept movements', _s.status; END IF;
  IF _type NOT IN ('drop','paid-out','pickup','float-top-up') THEN RAISE EXCEPTION 'Unsupported movement type %', _type; END IF;
  IF COALESCE(trim(_reason),'') = '' THEN RAISE EXCEPTION 'A reason is required'; END IF;
  INSERT INTO public.cash_movements (organization_id, shift_id, movement_type, amount, reason, reference, created_by)
  VALUES (_org, _shift, _type, _amount, _reason, _reference, auth.uid()) RETURNING id INTO _id;
  UPDATE public.pos_shifts SET
    total_drops = total_drops + CASE WHEN _type IN ('drop','pickup') THEN _amount ELSE 0 END,
    total_paid_outs = total_paid_outs + CASE WHEN _type = 'paid-out' THEN _amount ELSE 0 END,
    opening_float = opening_float + CASE WHEN _type = 'float-top-up' THEN _amount ELSE 0 END,
    updated_at = now()
  WHERE id = _shift;
  RETURN _id;
END; $$;

CREATE OR REPLACE FUNCTION public.cash_shift_expected(_shift uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(s.opening_float,0)
       + COALESCE((SELECT sum(p.amount) FROM public.payments p
                    WHERE p.shift_id = s.id AND p.method='cash' AND p.status='confirmed'),0)
       - COALESCE(s.total_drops,0) - COALESCE(s.total_paid_outs,0)
  FROM public.pos_shifts s WHERE s.id = _shift AND s.organization_id = public.current_org_id();
$$;

CREATE OR REPLACE FUNCTION public.cash_close_shift(_shift uuid, _counted numeric, _reason text DEFAULT '')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _org uuid := public.current_org_id(); _s public.pos_shifts; _expected numeric; _variance numeric; _appr uuid;
BEGIN
  SELECT * INTO _s FROM public.pos_shifts WHERE id=_shift AND organization_id=_org FOR UPDATE;
  IF _s.id IS NULL THEN RAISE EXCEPTION 'Shift not found'; END IF;
  IF _s.status <> 'open' THEN RAISE EXCEPTION 'Shift is already %', _s.status; END IF;
  _expected := public.cash_shift_expected(_shift);
  _variance := round(COALESCE(_counted,0) - COALESCE(_expected,0), 2);
  IF _variance <> 0 AND COALESCE(trim(_reason),'') = '' THEN
    RAISE EXCEPTION 'A variance reason is required when the count does not match the expected cash';
  END IF;

  IF _variance <> 0 THEN
    INSERT INTO public.approval_requests (organization_id, branch_id, reference, approval_type, requester_id,
      reason, amount, status)
    VALUES (_org, _s.branch_id, 'SHIFT-' || COALESCE(_s.shift_number, substr(_shift::text,1,8)),
      'cash-variance', auth.uid(), _reason, abs(_variance), 'pending')
    RETURNING id INTO _appr;
  END IF;

  UPDATE public.pos_shifts SET status = CASE WHEN _variance = 0 THEN 'closed' ELSE 'pending-review' END,
    expected_cash = _expected, counted_cash = _counted, variance = _variance, variance_reason = _reason,
    closed_at = now(), closed_by = auth.uid(), review_approval_request_id = _appr, updated_at = now()
  WHERE id = _shift;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
  VALUES (_org, auth.uid(), '', 'pos.shift.close', 'pos', _shift::text,
    jsonb_build_object('expected',_expected,'counted',_counted,'variance',_variance), _reason);

  RETURN jsonb_build_object('expected',_expected,'counted',_counted,'variance',_variance,
    'status', CASE WHEN _variance = 0 THEN 'closed' ELSE 'pending-review' END, 'approval_request_id', _appr);
END; $$;

CREATE OR REPLACE FUNCTION public.cash_review_shift(_shift uuid, _decision text, _notes text DEFAULT '')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _org uuid := public.current_org_id(); _s public.pos_shifts;
BEGIN
  SELECT * INTO _s FROM public.pos_shifts WHERE id=_shift AND organization_id=_org FOR UPDATE;
  IF _s.id IS NULL THEN RAISE EXCEPTION 'Shift not found'; END IF;
  IF _s.cashier_id = auth.uid() OR _s.closed_by = auth.uid() THEN
    RAISE EXCEPTION 'Cash variances must be reviewed by an independent authorised reviewer'; END IF;
  IF NOT public.has_permission('finance','cash.review') AND NOT public.has_permission('pos','shifts.review')
     AND NOT public.is_org_admin() THEN
    RAISE EXCEPTION 'Not permitted to review cashier shifts'; END IF;
  IF COALESCE(trim(_notes),'') = '' THEN RAISE EXCEPTION 'Review notes are required'; END IF;

  UPDATE public.pos_shifts SET status = CASE WHEN _decision = 'approved' THEN 'closed' ELSE 'disputed' END,
    reviewed_by = auth.uid(), reviewed_at = now(), notes = _notes, updated_at = now() WHERE id = _shift;
  IF _s.review_approval_request_id IS NOT NULL THEN
    UPDATE public.approval_requests SET status = _decision, approver_id = auth.uid(), notes = _notes, updated_at = now()
     WHERE id = _s.review_approval_request_id;
  END IF;
  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
  VALUES (_org, auth.uid(), '', 'pos.shift.review', 'pos', _shift::text,
    jsonb_build_object('decision',_decision,'variance',_s.variance), _notes);
  RETURN jsonb_build_object('status', _decision);
END; $$;

REVOKE ALL ON FUNCTION public.cash_open_shift(uuid,uuid,numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cash_record_movement(uuid,text,numeric,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cash_shift_expected(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cash_close_shift(uuid,numeric,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cash_review_shift(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cash_open_shift(uuid,uuid,numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cash_record_movement(uuid,text,numeric,text,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cash_shift_expected(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cash_close_shift(uuid,numeric,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cash_review_shift(uuid,text,text) TO authenticated, service_role;
