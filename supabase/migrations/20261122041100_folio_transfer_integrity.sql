BEGIN;

DO $transfer_baseline$
DECLARE
  definition text := pg_get_functiondef(to_regprocedure('public.folio_transfer_line(uuid,uuid,text)'));
BEGIN
  IF NOT coalesce(
    md5(definition) IN ('edfa202791098f169e5a2694d6714211', 'c521335319e62a91ceaf1754490d64ee')
    OR md5(replace(definition, chr(13) || chr(10), chr(10))) IN (
      'edfa202791098f169e5a2694d6714211', '223f0fe9c6f3e84c00b773f81250c525'
    ), false) THEN
    RAISE EXCEPTION 'Installed folio transfer definition differs from the reviewed versions.';
  END IF;
END;
$transfer_baseline$;

CREATE OR REPLACE FUNCTION public.folio_transfer_line(_line uuid, _target_folio uuid, _reason text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  _org uuid := public.current_org_id();
  _l public.folio_lines;
  _s public.folios;
  _t public.folios;
  _prior public.folio_lines;
  _new uuid;
  _source_group uuid;
  _key text := 'transfer:' || _line::text || ':' || _target_folio::text;
  _note text := nullif(btrim(_reason), '');
BEGIN
  IF auth.uid() IS NULL OR _org IS NULL
    OR NOT coalesce(public.has_permission('pms','folios.post_charge'), false) THEN
    RAISE EXCEPTION 'Not permitted to transfer charges' USING ERRCODE = '42501';
  END IF;
  IF _note IS NULL THEN RAISE EXCEPTION 'A transfer reason is required'; END IF;
  SELECT * INTO _l FROM public.folio_lines WHERE id=_line AND organization_id=_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Charge not found'; END IF;
  IF _l.folio_id = _target_folio THEN RAISE EXCEPTION 'Choose a different receiving folio'; END IF;
  -- Use one lock order for folio balances when two charges are moving in opposite directions.
  PERFORM id FROM public.folios WHERE organization_id=_org AND id IN (_l.folio_id, _target_folio) ORDER BY id FOR UPDATE;
  SELECT * INTO _s FROM public.folios WHERE id=_l.folio_id AND organization_id=_org;
  SELECT * INTO _t FROM public.folios WHERE id=_target_folio AND organization_id=_org;
  IF _s.id IS NULL OR _t.id IS NULL OR _s.branch_id IS NULL OR _t.branch_id IS DISTINCT FROM _s.branch_id
    OR _l.branch_id IS DISTINCT FROM _s.branch_id OR NOT coalesce(public.neo_branch_in_scope(_s.branch_id), false) THEN
    RAISE EXCEPTION 'Use two folios in the same authorised property' USING ERRCODE = '42501';
  END IF;
  IF _s.currency IS NULL OR _s.currency IS DISTINCT FROM _t.currency THEN
    RAISE EXCEPTION 'Use a receiving folio in the same currency';
  END IF;
  IF _t.folio_type = 'master' AND _t.group_booking_id IS NOT NULL THEN
    SELECT coalesce(_s.group_booking_id, r.group_booking_id) INTO _source_group
      FROM (SELECT 1) anchor
      LEFT JOIN public.reservations r ON r.id = _s.reservation_id AND r.organization_id = _org AND r.branch_id = _s.branch_id;
    IF _source_group IS DISTINCT FROM _t.group_booking_id OR NOT EXISTS (
      SELECT 1 FROM public.group_bookings g WHERE g.id = _source_group AND g.organization_id = _org
        AND g.branch_id = _s.branch_id AND g.master_folio_id = _t.id
    ) THEN
      RAISE EXCEPTION 'Choose the verified master folio for this reservation group';
    END IF;
  END IF;
  SELECT * INTO _prior FROM public.folio_lines WHERE organization_id=_org AND idempotency_key=_key;
  IF FOUND THEN
    IF _prior.folio_id IS DISTINCT FROM _t.id OR _prior.transferred_from_folio_id IS DISTINCT FROM _s.id
      OR _prior.transfer_reason IS DISTINCT FROM _note OR _prior.net_amount IS DISTINCT FROM _l.net_amount THEN
      RAISE EXCEPTION 'This charge transfer conflicts with the saved posting';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.folio_lines WHERE organization_id=_org AND reverses_line_id=_line) THEN
      RAISE EXCEPTION 'The saved transfer is missing its original reversal';
    END IF;
    RETURN _prior.id;
  END IF;
  IF _s.status IS DISTINCT FROM 'open' OR _t.status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'Both folios must be open';
  END IF;
  IF _l.status IS DISTINCT FROM 'posted' OR _l.line_type IS DISTINCT FROM 'charge'
    OR coalesce(_l.net_amount, 0) <= 0 OR _l.net_amount::text IN ('NaN', 'Infinity', '-Infinity')
    OR EXISTS (SELECT 1 FROM public.folio_lines WHERE organization_id=_org AND reverses_line_id=_line) THEN
    RAISE EXCEPTION 'Only an active posted charge can be transferred';
  END IF;

  INSERT INTO public.folio_lines (organization_id, branch_id, folio_id, reservation_id, customer_id, line_type,
    category, revenue_centre, reference, source_module, source_record_id, source_record_uuid, idempotency_key,
    description, quantity, unit_price, gross_amount, discount_amount, tax_amount, service_charge_amount,
    net_amount, posted_by, actor_id, correlation_id, status, transferred_from_folio_id, transfer_reason)
  VALUES (_org, _t.branch_id, _target_folio, _t.reservation_id, _t.customer_id, _l.line_type,
    _l.category, _l.revenue_centre, _l.reference, _l.source_module, _l.source_record_id, _l.source_record_uuid,
    _key, _l.description, _l.quantity, _l.unit_price,
    _l.gross_amount, _l.discount_amount, _l.tax_amount, _l.service_charge_amount, _l.net_amount,
    auth.uid(), auth.uid(), _l.correlation_id, 'posted', _l.folio_id, _note)
  RETURNING id INTO _new;

  PERFORM public.folio_reverse_line(_line, 'Transferred to folio ' || _t.folio_number || ': ' || _note);
  UPDATE public.folios SET total_charges = total_charges + _l.gross_amount,
    total_taxes = total_taxes + _l.tax_amount, balance = balance + _l.net_amount, updated_at = now()
  WHERE id = _target_folio;
  RETURN _new;
END; $$;

COMMIT;
