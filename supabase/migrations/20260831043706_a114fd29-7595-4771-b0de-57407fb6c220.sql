CREATE OR REPLACE FUNCTION public.pms_apply_deposits_to_folio()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _d record; _line uuid;
BEGIN
  IF NEW.reservation_id IS NULL THEN RETURN NEW; END IF;
  FOR _d IN SELECT * FROM public.reservation_deposits
             WHERE reservation_id = NEW.reservation_id AND status = 'held'
  LOOP
    INSERT INTO public.folio_lines (organization_id, branch_id, folio_id, reservation_id, line_type,
      category, source_module, description, operational_date, quantity, unit_price,
      gross_amount, net_amount, posted_by)
    VALUES (NEW.organization_id, NEW.branch_id, NEW.id, NEW.reservation_id, 'payment', 'payment', 'pms',
      'Pre-arrival deposit' || COALESCE(' · ' || _d.reference, ''), current_date, 1, _d.amount,
      _d.amount, _d.amount, auth.uid())
    RETURNING id INTO _line;

    UPDATE public.reservation_deposits
       SET status='applied', applied_folio_id=NEW.id, applied_folio_line_id=_line, applied_at=now()
     WHERE id=_d.id;

    -- A deposit applied to the folio is money already banked: it must reduce
    -- what the guest owes, not sit on the folio as an unreconciled line.
    UPDATE public.folios
       SET total_payments = COALESCE(total_payments,0) + _d.amount,
           balance = COALESCE(balance,0) - _d.amount,
           updated_at = now()
     WHERE id = NEW.id;
  END LOOP;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.pms_check_out(_reservation uuid, _force boolean DEFAULT false, _notes text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _stay record; _f record; _charges numeric; _paid numeric; _line_paid numeric; _outstanding numeric;
BEGIN
  SELECT * INTO _stay FROM public.stays WHERE reservation_id=_reservation FOR UPDATE;
  IF _stay IS NULL THEN RAISE EXCEPTION 'No active stay for this reservation'; END IF;
  IF _stay.status = 'checked-out' THEN
    RETURN jsonb_build_object('stay_id',_stay.id,'idempotent',true);
  END IF;

  SELECT * INTO _f FROM public.folios WHERE stay_id=_stay.id AND folio_type='guest' FOR UPDATE;

  -- Charges exclude payment/deposit lines; those are settlement, not consumption.
  SELECT COALESCE(SUM(l.net_amount), 0) INTO _charges
    FROM public.folio_lines l
    JOIN public.folios f ON f.id = l.folio_id
   WHERE f.stay_id = _stay.id
     AND COALESCE(l.status,'posted') NOT IN ('void','voided','reversed')
     AND COALESCE(l.line_type,'charge') NOT IN ('payment','deposit','refund');

  SELECT COALESCE(SUM(a.amount), 0) INTO _paid
    FROM public.payment_allocations a
    JOIN public.folios f ON f.id = a.folio_id
    JOIN public.payments p ON p.id = a.payment_id
   WHERE f.stay_id = _stay.id
     AND p.status = 'confirmed';

  -- Deposits applied at check-in are recorded as folio payment lines.
  SELECT COALESCE(SUM(l.net_amount), 0) INTO _line_paid
    FROM public.folio_lines l
    JOIN public.folios f ON f.id = l.folio_id
   WHERE f.stay_id = _stay.id
     AND COALESCE(l.status,'posted') NOT IN ('void','voided','reversed')
     AND COALESCE(l.line_type,'charge') IN ('payment','deposit');

  _outstanding := _charges - _paid - _line_paid;

  IF round(_outstanding, 2) > 0 THEN
    IF NOT _force THEN
      RAISE EXCEPTION 'Folio is not settled — outstanding balance of %. Settle the bill before check-out.', round(_outstanding, 2);
    END IF;
    IF NOT (public.has_permission('pms','folio.override') OR public.is_org_admin()) THEN
      RAISE EXCEPTION 'Checking out with an unsettled balance of % requires folio override authority.', round(_outstanding, 2);
    END IF;
    IF btrim(COALESCE(_notes,'')) = '' THEN
      RAISE EXCEPTION 'A written reason is required to check out with an unsettled balance.';
    END IF;
  END IF;

  UPDATE public.stays SET status='checked-out', checked_out_at=now(), updated_at=now() WHERE id=_stay.id;
  UPDATE public.reservations SET status='checked-out', updated_at=now() WHERE id=_reservation;

  IF _f.id IS NOT NULL THEN
    UPDATE public.folios
       SET total_charges = _charges,
           total_payments = COALESCE(_paid,0) + COALESCE(_line_paid,0),
           balance = _outstanding,
           status = CASE WHEN round(_outstanding,2) > 0 THEN 'under-review' ELSE 'settled' END,
           updated_at = now()
     WHERE id = _f.id;
  END IF;

  UPDATE public.rooms SET status='active', housekeeping_status='dirty', updated_at=now()
   WHERE id = (SELECT room_id FROM public.reservations WHERE id=_reservation);

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
  VALUES (_stay.organization_id, auth.uid(), '', 'pms.check_out', 'pms', _stay.id::text,
    jsonb_build_object('reservation_id',_reservation,'outstanding',_outstanding,'forced',_force), _notes);

  RETURN jsonb_build_object('stay_id',_stay.id,'folio_id',_f.id,'idempotent',false,'outstanding',_outstanding);
END;
$function$;