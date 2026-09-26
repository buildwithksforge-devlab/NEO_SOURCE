-- Three routines could be run twice at the same instant (double tap, two
-- devices, a retried request) and each read its guard before the other wrote.

CREATE OR REPLACE FUNCTION public.neo_delivery_rider_remit(_declared numeric, _branch uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _rider uuid := public.my_rider_id(); _org uuid; _branch_id uuid; _expected numeric; _n int; _rem uuid; _ref text;
BEGIN
  IF _rider IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_a_rider'); END IF;
  IF _declared IS NULL OR _declared < 0 THEN RETURN jsonb_build_object('ok', false, 'reason', 'invalid_amount'); END IF;

  SELECT organization_id, coalesce(_branch, branch_id) INTO _org, _branch_id
    FROM public.rider_profiles WHERE id = _rider;

  -- Hold the outstanding collections. Without this, two submissions in the same
  -- moment both saw the same uncollected cash and wrote two remittances for one
  -- float, the second one empty.
  PERFORM 1 FROM public.rider_cash_collections
   WHERE rider_id = _rider AND status = 'collected' AND remittance_id IS NULL
     AND (_branch IS NULL OR branch_id = _branch)
   FOR UPDATE;

  SELECT coalesce(sum(collected_amount), 0), count(*)
    INTO _expected, _n
    FROM public.rider_cash_collections
   WHERE rider_id = _rider AND status = 'collected' AND remittance_id IS NULL
     AND (_branch IS NULL OR branch_id = _branch);

  IF _n = 0 THEN RETURN jsonb_build_object('ok', false, 'reason', 'nothing_to_remit'); END IF;

  _ref := 'REM-' || to_char(now(), 'YYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text,'-',''), 1, 5));

  INSERT INTO public.rider_cash_remittances
    (organization_id, branch_id, rider_id, reference, expected_amount, declared_amount, variance, status, submitted_at)
  VALUES (_org, _branch_id, _rider, _ref, _expected, _declared, _declared - _expected, 'submitted', now())
  RETURNING id INTO _rem;

  UPDATE public.rider_cash_collections
     SET remittance_id = _rem, status = 'remitted', updated_at = now()
   WHERE rider_id = _rider AND status = 'collected' AND remittance_id IS NULL
     AND (_branch IS NULL OR branch_id = _branch);

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (_org, auth.uid(), '', 'delivery.cash.remit', 'delivery', _rem::text,
          jsonb_build_object('expected', _expected, 'declared', _declared, 'orders', _n));

  RETURN jsonb_build_object('ok', true, 'remittance_id', _rem, 'reference', _ref,
                            'expected_amount', _expected, 'declared_amount', _declared,
                            'variance', _declared - _expected, 'orders', _n);
END; $function$;

CREATE OR REPLACE FUNCTION public.folio_reverse_line(_line uuid, _reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _l public.folio_lines; _id uuid;
BEGIN
  IF NOT public.has_permission('pms','folios.post_charge') THEN RAISE EXCEPTION 'Not permitted to reverse charges'; END IF;
  IF COALESCE(trim(_reason),'') = '' THEN RAISE EXCEPTION 'A reversal reason is required'; END IF;
  -- Locked so a double submission waits and then returns the first reversal,
  -- instead of racing past the check and hitting a raw uniqueness error.
  SELECT * INTO _l FROM public.folio_lines WHERE id=_line AND organization_id=_org FOR UPDATE;
  IF _l.id IS NULL THEN RAISE EXCEPTION 'Charge not found'; END IF;
  IF _l.line_type = 'reversal' THEN RAISE EXCEPTION 'That line is itself a reversal'; END IF;
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
END; $function$;

CREATE OR REPLACE FUNCTION public.neo_post_pos_order(_order uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare org uuid:=public.current_org_id(); o public.pos_orders; line uuid; prior text;
begin
  if org is null or not (public.is_org_admin() or public.has_permission('finance','view') or public.has_permission('restaurant','orders.settle') or public.neo_system_posting()) then raise exception 'insufficient_privilege' using errcode='42501'; end if;
  -- Locked so two settlements of the same bill cannot both pass the
  -- already-posted check and charge the guest folio twice.
  select * into o from public.pos_orders where id=_order and organization_id=org for update;
  if not found then return jsonb_build_object('ok',false,'reason','not_found'); end if;
  if o.status not in ('closed','paid','settled','completed','charged-to-room') then return jsonb_build_object('ok',false,'reason','not_finalised','status',o.status); end if;
  if o.folio_post_status='posted' then return jsonb_build_object('ok',true,'reason','already_posted'); end if;
  if o.folio_id is null then return jsonb_build_object('ok',false,'reason','no_folio','detail','The order is not attached to a guest folio, so it cannot be posted as a folio charge.'); end if;
  prior:=coalesce(current_setting('neo.system_posting',true),'off');
  perform set_config('neo.system_posting','on',true);
  line:=public.folio_post_charge(o.folio_id,'food-beverage','Point of sale order '||o.order_number,1,o.subtotal,o.tax_total,o.service_charge_total,o.discount_total,'pos',o.id,'fnb','pos:'||o.id::text,null);
  perform set_config('neo.system_posting',prior,true);
  update public.pos_orders set folio_post_status='posted',updated_at=now() where id=o.id;
  return jsonb_build_object('ok',true,'folio_line_id',line);
end $function$;