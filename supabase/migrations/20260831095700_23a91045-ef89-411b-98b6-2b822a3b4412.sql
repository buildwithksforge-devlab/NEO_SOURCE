CREATE OR REPLACE FUNCTION public.neo_payment_schedule_release(_schedule uuid, _reason text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  s public.payment_schedules;
  _existing public.supplier_payments;
  _pid uuid;
  _num text;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'No workspace context'; END IF;

  SELECT * INTO s FROM public.payment_schedules
   WHERE id = _schedule AND organization_id = _org FOR UPDATE;
  IF s.id IS NULL THEN RAISE EXCEPTION 'Payment schedule not found'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('payment-schedule:' || _schedule::text, 0));

  IF NOT (public.has_permission('finance','payment','approve') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Only a finance approver or an owner can release a scheduled payment' USING ERRCODE = '42501';
  END IF;

  IF s.created_by IS NOT NULL AND s.created_by = auth.uid() AND NOT public.is_org_admin() THEN
    RAISE EXCEPTION 'A payment cannot be released by the person who scheduled it';
  END IF;

  -- Repeat-safe: a release already happened for this schedule.
  SELECT * INTO _existing FROM public.supplier_payments
   WHERE organization_id = _org AND schedule_id = _schedule
   ORDER BY created_at LIMIT 1;
  IF _existing.id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true,
      'status', _existing.status, 'payment_id', _existing.id,
      'payment_number', _existing.payment_number);
  END IF;

  IF s.status NOT IN ('scheduled','approved','pending','draft') THEN
    RAISE EXCEPTION 'Only a scheduled payment can be released (currently "%")', s.status;
  END IF;
  IF s.supplier_id IS NULL THEN
    RAISE EXCEPTION 'This schedule has no supplier, so it cannot be released';
  END IF;
  IF round(coalesce(s.amount,0),2) <= 0 THEN
    RAISE EXCEPTION 'A schedule with no amount cannot be released';
  END IF;

  _num := 'SPY-' || to_char(now(),'YYYYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,5));

  INSERT INTO public.supplier_payments (
    organization_id, branch_id, payment_number, supplier_id, supplier_invoice_id,
    schedule_id, amount, currency, method, paid_on, status,
    created_by, approved_by, approved_at
  ) VALUES (
    _org, s.branch_id, _num, s.supplier_id, s.supplier_invoice_id,
    s.id, round(s.amount,2),
    coalesce(nullif(public.neo_fact_currency(_org, s.branch_id),''),'KES'),
    coalesce(nullif(s.method,''),'bank_transfer'), CURRENT_DATE, 'released',
    auth.uid(), auth.uid(), now()
  ) RETURNING id INTO _pid;

  UPDATE public.payment_schedules
     SET status = 'released', updated_at = now()
   WHERE id = s.id;

  INSERT INTO public.audit_logs (
    organization_id, branch_id, user_id, action, module, record_id,
    previous_value, new_value, reason, permission_used
  ) VALUES (
    _org, s.branch_id, auth.uid(), 'supplier_payment_released', 'finance', _pid::text,
    jsonb_build_object('schedule_id', s.id, 'schedule_status', s.status),
    jsonb_build_object('payment_id', _pid, 'payment_number', _num,
                       'amount', round(s.amount,2), 'supplier_id', s.supplier_id,
                       'status', 'released'),
    nullif(btrim(coalesce(_reason,'')),''), 'finance.payment.approve'
  );

  RETURN jsonb_build_object('ok', true, 'idempotent', false, 'status', 'released',
    'payment_id', _pid, 'payment_number', _num);
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_payment_schedule_release(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_payment_schedule_release(uuid, text) TO authenticated;