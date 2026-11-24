BEGIN;

DO $group_billing_baseline$
BEGIN
  IF coalesce(md5(pg_get_functiondef(to_regprocedure('public.pms_group_master_folio(uuid)'))), '') NOT IN (
      '7b012d1fc093d3e8797371df1517de7e', 'd92dbf19d47aceff79afbe1a2ab5f8d8')
    OR coalesce(md5(pg_get_functiondef(to_regprocedure('public.pms_group_record_deposit(uuid,numeric,text,text)'))), '') NOT IN (
      'bec92f98f5f1fb8d771a3c9fbdbd54af', '53fe19416b12ce7e96ea71f379cb339b',
      'cd19a123f24e3120508451c6f38e47f0', 'fdd61dfbb695ca573e4d194cc8bf246b') THEN
    RAISE EXCEPTION 'Installed group billing definitions differ from the reviewed versions.';
  END IF;
END;
$group_billing_baseline$;

CREATE OR REPLACE FUNCTION public.pms_group_master_folio(_group uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  booking public.group_bookings;
  master public.folios;
  property_currency text;
BEGIN
  IF auth.uid() IS NULL OR NOT coalesce(public.is_org_admin()
      OR public.has_permission('front-office', 'groups', 'edit')
      OR public.has_permission('pms', 'write'), false) THEN
    RAISE EXCEPTION 'Group billing access required.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO booking FROM public.group_bookings
    WHERE id = _group AND organization_id = public.current_org_id() FOR UPDATE;
  IF NOT FOUND OR booking.branch_id IS NULL OR NOT coalesce(public.neo_branch_in_scope(booking.branch_id), false) THEN
    RAISE EXCEPTION 'Group booking is outside your property access.' USING ERRCODE = '42501';
  END IF;
  property_currency := public.neo_fact_currency(booking.organization_id, booking.branch_id);
  IF property_currency IS NULL OR property_currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'Configure the property currency before billing this group.';
  END IF;

  IF booking.master_folio_id IS NOT NULL THEN
    SELECT * INTO master FROM public.folios WHERE id = booking.master_folio_id FOR UPDATE;
    IF NOT FOUND OR master.organization_id IS DISTINCT FROM booking.organization_id
        OR master.branch_id IS DISTINCT FROM booking.branch_id OR master.group_booking_id IS DISTINCT FROM booking.id
        OR master.folio_type IS DISTINCT FROM 'master' OR master.currency IS DISTINCT FROM property_currency THEN
      RAISE EXCEPTION 'The saved group master folio needs its property, group or currency reconciled.';
    END IF;
    RETURN master.id;
  END IF;
  IF booking.status IN ('cancelled', 'canceled', 'closed') THEN
    RAISE EXCEPTION 'This group is closed to new billing.';
  END IF;
  -- A missing link can be restored only when one compatible master already exists.
  IF (SELECT count(*) FROM public.folios WHERE group_booking_id = booking.id AND folio_type = 'master') > 1 THEN
    RAISE EXCEPTION 'Multiple master folios exist for this group. Reconcile them before billing.';
  END IF;
  SELECT * INTO master FROM public.folios WHERE group_booking_id = booking.id AND folio_type = 'master' FOR UPDATE;
  IF FOUND THEN
    IF master.organization_id IS DISTINCT FROM booking.organization_id OR master.branch_id IS DISTINCT FROM booking.branch_id
        OR master.currency IS DISTINCT FROM property_currency THEN
      RAISE EXCEPTION 'The existing group master folio needs reconciliation.';
    END IF;
  ELSE
    INSERT INTO public.folios (organization_id, branch_id, folio_number, folio_type, group_booking_id,
      corporate_account_id, customer_id, status, billing_instructions, created_by, currency)
    VALUES (booking.organization_id, booking.branch_id,
      'GM-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)), 'master', booking.id,
      booking.corporate_account_id, booking.contact_customer_id, 'open', booking.billing_instructions, auth.uid(), property_currency)
    RETURNING * INTO master;
  END IF;
  UPDATE public.group_bookings SET master_folio_id = master.id, updated_at = now() WHERE id = booking.id;
  RETURN master.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.pms_group_record_deposit(_group uuid, _amount numeric, _method text, _reference text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  booking public.group_bookings;
  master public.folios;
  payment public.payments;
  folio_key uuid;
  reference_text text := nullif(btrim(_reference), '');
  method_text text := coalesce(nullif(lower(btrim(_method)), ''), 'cash');
  attempt_key text;
BEGIN
  IF _amount IS NULL OR _amount::text IN ('NaN', 'Infinity', '-Infinity') OR _amount <= 0 OR _amount <> round(_amount, 2) THEN
    RAISE EXCEPTION 'Enter a positive deposit amount with at most two decimal places.' USING ERRCODE = '22023';
  END IF;
  IF reference_text IS NULL OR length(reference_text) > 120 THEN
    RAISE EXCEPTION 'Enter the receipt or payment reference (up to 120 characters).' USING ERRCODE = '22023';
  END IF;
  -- The scoped group lock covers master creation, reference reuse and the deposit total.
  folio_key := public.pms_group_master_folio(_group);
  SELECT * INTO STRICT master FROM public.folios WHERE id = folio_key;
  SELECT * INTO STRICT booking FROM public.group_bookings WHERE id = _group;
  attempt_key := 'group-deposit:' || booking.id::text || ':' || reference_text;

  SELECT * INTO payment FROM public.payments
    WHERE organization_id = booking.organization_id AND idempotency_key = attempt_key FOR UPDATE;
  IF FOUND THEN
    IF payment.folio_id IS DISTINCT FROM master.id OR payment.branch_id IS DISTINCT FROM booking.branch_id
        OR payment.source_module IS DISTINCT FROM 'pms.groups' OR payment.source_record_id IS DISTINCT FROM booking.id
        OR payment.currency IS DISTINCT FROM master.currency OR payment.amount IS DISTINCT FROM _amount
        OR payment.method IS DISTINCT FROM method_text THEN
      RAISE EXCEPTION 'This reference already belongs to a different deposit. Review the saved payment.' USING ERRCODE = '23514';
    END IF;
    IF payment.status NOT IN ('confirmed', 'posted', 'completed') OR payment.status IS NULL THEN
      RAISE EXCEPTION 'This reference belongs to a deposit that is no longer confirmed. Review the saved payment.' USING ERRCODE = '23514';
    END IF;
    RETURN jsonb_build_object('duplicate', true, 'payment_id', payment.id, 'folio_id', master.id, 'currency', master.currency);
  END IF;
  IF master.status IS DISTINCT FROM 'open' OR booking.status IN ('cancelled', 'canceled', 'closed') THEN
    RAISE EXCEPTION 'This group or master folio is closed to new deposits.';
  END IF;

  INSERT INTO public.payments (organization_id, branch_id, folio_id, customer_id, amount, currency, method,
    external_reference, status, received_by, source_module, source_record_id, idempotency_key, notes)
  VALUES (booking.organization_id, booking.branch_id, master.id, booking.contact_customer_id, _amount, master.currency,
    method_text, reference_text, 'confirmed', auth.uid(), 'pms.groups', booking.id, attempt_key, 'Group deposit')
  RETURNING * INTO payment;
  UPDATE public.group_bookings SET deposit_paid = coalesce(deposit_paid, 0) + _amount, updated_at = now() WHERE id = booking.id;
  INSERT INTO public.group_block_events (organization_id, group_booking_id, event_type, new_value, actor_id, reason)
  VALUES (booking.organization_id, booking.id, 'deposit',
    jsonb_build_object('amount', _amount, 'currency', master.currency, 'method', method_text,
      'payment', payment.id, 'folio_id', master.id), auth.uid(), 'Group deposit received');
  RETURN jsonb_build_object('duplicate', false, 'payment_id', payment.id, 'folio_id', master.id, 'currency', master.currency);
END;
$$;

REVOKE ALL ON FUNCTION public.pms_group_master_folio(uuid), public.pms_group_record_deposit(uuid,numeric,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pms_group_master_folio(uuid), public.pms_group_record_deposit(uuid,numeric,text,text) TO authenticated, service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
