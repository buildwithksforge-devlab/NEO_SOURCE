-- System-derived charges (guest laundry, recipe-style automated postings) may
-- reach a folio without the actor holding manual folio-posting rights, because
-- the amount is computed by the system and never typed by the actor.
CREATE OR REPLACE FUNCTION public.neo_system_posting()
RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(current_setting('neo.system_posting', true), 'off') = 'on'
$$;
REVOKE ALL ON FUNCTION public.neo_system_posting() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.folio_post_charge(_folio uuid, _category text, _description text, _quantity numeric, _unit_price numeric, _tax numeric DEFAULT 0, _service_charge numeric DEFAULT 0, _discount numeric DEFAULT 0, _source_module text DEFAULT 'manual'::text, _source_record uuid DEFAULT NULL::uuid, _revenue_centre text DEFAULT 'rooms'::text, _idempotency_key text DEFAULT NULL::text, _correlation uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _f public.folios; _gross numeric; _net numeric; _id uuid;
        _key text := COALESCE(_idempotency_key, _source_module || ':' || COALESCE(_source_record::text, gen_random_uuid()::text));
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
END; $function$;

-- Laundry posting turns the flag on only for its own derived charge.
CREATE OR REPLACE FUNCTION public.laundry_post_charge(_order uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid := current_org_id(); v_order record; v_folio uuid; v_line uuid; v_key text;
BEGIN
  IF NOT (has_permission('laundry','edit') OR has_permission('laundry','approve')
          OR has_permission('laundry','complete') OR has_permission('laundry','deliver')
          OR has_permission('pms','folios.post_charge') OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to post laundry charges';
  END IF;

  SELECT * INTO v_order FROM guest_laundry_orders WHERE id=_order AND organization_id=v_org FOR UPDATE;
  IF v_order IS NULL THEN RAISE EXCEPTION 'Unknown laundry order'; END IF;
  IF v_order.posting_status = 'posted' THEN
    RETURN jsonb_build_object('ok', true, 'already_posted', true, 'folio_line_id', v_order.folio_line_id);
  END IF;
  IF COALESCE(v_order.total, 0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_chargeable_items',
      'detail', 'Count the laundry items and price them before posting the charge.');
  END IF;

  v_folio := v_order.folio_id;
  IF v_folio IS NULL AND v_order.reservation_id IS NOT NULL THEN
    SELECT id INTO v_folio FROM folios
      WHERE organization_id=v_org AND reservation_id=v_order.reservation_id AND status='open'
      ORDER BY created_at LIMIT 1;
  END IF;
  IF v_folio IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_folio',
      'detail', 'No open guest folio for this laundry order.');
  END IF;

  v_key := 'laundry:' || _order::text;
  PERFORM set_config('neo.system_posting', 'on', true);
  v_line := public.folio_post_charge(
    v_folio, 'laundry', 'Guest laundry ' || COALESCE(v_order.laundry_number,''),
    1, COALESCE(v_order.total,0) - COALESCE(v_order.tax_amount,0), COALESCE(v_order.tax_amount,0),
    0, 0, 'laundry', _order, 'laundry', v_key, NULL);
  PERFORM set_config('neo.system_posting', 'off', true);

  UPDATE guest_laundry_orders
     SET posting_status='posted', folio_id=v_folio, folio_line_id=v_line, posted_at=now()
   WHERE id=_order;
  RETURN jsonb_build_object('ok', true, 'folio_line_id', v_line);
END $$;