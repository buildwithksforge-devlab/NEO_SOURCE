-- NEO P1.6 - DELIVERY REMITTANCE DUPLICATE PROTECTION
-- LOCAL DRAFT - NOT DEPLOYED
--
-- Prevent additional cash recording on disputed remittances.
-- Preserve existing reconciliation and till integration.
CREATE OR REPLACE FUNCTION public.neo_delivery_remit_reconcile(
  _remittance uuid, _counted numeric, _reason text DEFAULT NULL::text, _shift uuid DEFAULT NULL::uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _r public.rider_cash_remittances;
  _var numeric;
  _s public.pos_shifts;
  _till_recorded boolean := false;
BEGIN
  IF _org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.has_permission('delivery','payments.reconcile') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'The delivery.payments.reconcile permission is required.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _r FROM public.rider_cash_remittances
   WHERE id = _remittance AND organization_id = _org FOR UPDATE;
  IF _r.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'remittance_not_found'); END IF;
  IF _r.rider_id = public.my_rider_id() THEN
    RAISE EXCEPTION 'A rider cannot reconcile their own cash.' USING ERRCODE = '42501';
  END IF;
  IF NOT public.neo_branch_in_scope(_r.branch_id) THEN
    RAISE EXCEPTION 'That remittance is outside your access scope.' USING ERRCODE = '42501';
  END IF;
  -- P1.6: A remittance must not be financially received twice.
  IF _r.status = 'reconciled' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'already_reconciled', true,
      'remittance_id', _r.id
    );
  END IF;

  -- Disputed remittances require an explicit resolution workflow.
  -- Do not insert another till cash movement by retrying reconciliation.
  IF _r.status = 'disputed' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'remittance_disputed',
      'detail', 'Resolve the existing disputed remittance before any further cash posting.',
      'remittance_id', _r.id
    );
  END IF;

  _var := _counted - _r.expected_amount;
  IF _var <> 0 AND nullif(btrim(coalesce(_reason,'')),'') IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'variance_reason_required', 'variance', _var);
  END IF;

  IF _shift IS NOT NULL THEN
    SELECT * INTO _s FROM public.pos_shifts WHERE id = _shift AND organization_id = _org FOR UPDATE;
    IF _s.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'till_not_found'); END IF;
    IF _s.status <> 'open' THEN RETURN jsonb_build_object('ok', false, 'reason', 'till_not_open'); END IF;
    IF _s.cashier_id IS DISTINCT FROM auth.uid() THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'till_belongs_to_another_cashier');
    END IF;
    IF _s.branch_id IS DISTINCT FROM _r.branch_id THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'till_property_mismatch');
    END IF;
    INSERT INTO public.cash_movements (organization_id, shift_id, movement_type, amount, reason, reference, created_by)
    VALUES (_org, _shift, 'rider-cash', _counted,
            'Rider cash counted in: ' || coalesce(_r.reference,'remittance'), coalesce(_r.reference,''), auth.uid());
    _till_recorded := true;
  END IF;

  UPDATE public.rider_cash_remittances
     SET counted_amount = _counted, variance = _var, variance_reason = nullif(btrim(coalesce(_reason,'')),''),
         status = CASE WHEN _var = 0 THEN 'reconciled' ELSE 'disputed' END,
         shift_id = coalesce(_shift, shift_id),
         received_by = auth.uid(), received_at = coalesce(received_at, now()),
         reconciled_by = auth.uid(), reconciled_at = now(), updated_at = now()
   WHERE id = _remittance;

  UPDATE public.rider_cash_collections
     SET status = CASE WHEN _var = 0 THEN 'reconciled' ELSE 'disputed' END, updated_at = now()
   WHERE remittance_id = _remittance;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, previous_value, new_value, reason)
  VALUES (_org, auth.uid(), '', 'delivery.cash.reconcile', 'delivery', _remittance::text,
          jsonb_build_object('status', _r.status, 'expected', _r.expected_amount, 'declared', _r.declared_amount),
          jsonb_build_object('counted', _counted, 'variance', _var, 'shift_id', _shift, 'till_recorded', _till_recorded),
          nullif(btrim(coalesce(_reason,'')),''));

  RETURN jsonb_build_object('ok', true, 'remittance_id', _remittance, 'counted_amount', _counted,
                            'variance', _var, 'till_recorded', _till_recorded,
                            'status', CASE WHEN _var = 0 THEN 'reconciled' ELSE 'disputed' END);
END; $function$;


