CREATE OR REPLACE FUNCTION public.folio_post_charge(_folio uuid, _category text, _description text, _quantity numeric, _unit_price numeric, _tax numeric DEFAULT 0, _service_charge numeric DEFAULT 0, _discount numeric DEFAULT 0, _source_module text DEFAULT 'manual'::text, _source_record uuid DEFAULT NULL::uuid, _revenue_centre text DEFAULT 'rooms'::text, _idempotency_key text DEFAULT NULL::text, _correlation uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid := COALESCE(public.current_org_id(),
          CASE WHEN public.neo_system_posting()
            THEN (SELECT organization_id FROM public.folios WHERE id = _folio) END); _f public.folios; _gross numeric; _net numeric; _id uuid;
        _key text := COALESCE(
          _idempotency_key,
          CASE
            WHEN _source_record IS NOT NULL
              THEN _source_module || ':' || _source_record::text
            ELSE 'auto:' || _folio::text
                 || ':' || COALESCE(_category, '')
                 || ':' || md5(COALESCE(_description, ''))
                 || ':' || to_char(round(COALESCE(_quantity,1) * COALESCE(_unit_price,0), 2), 'FM9999999999990.00')
                 || ':' || to_char(date_trunc('minute', now() AT TIME ZONE 'UTC'), 'YYYYMMDDHH24MI')
          END);
BEGIN
  IF NOT (public.has_permission('pms','folios.post_charge') OR public.neo_system_posting()) THEN
    RAISE EXCEPTION 'Not permitted to post charges';
  END IF;
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
END; $function$
