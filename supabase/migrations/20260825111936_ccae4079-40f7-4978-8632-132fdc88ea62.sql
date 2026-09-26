
-- =====================================================================
-- 1. RIDER IDENTITY CHAIN
-- =====================================================================
CREATE UNIQUE INDEX IF NOT EXISTS rider_profiles_active_profile_uq
  ON public.rider_profiles (organization_id, profile_id)
  WHERE profile_id IS NOT NULL AND active;

CREATE OR REPLACE FUNCTION public.neo_delivery_rider_reconcile(_commit boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _linked int := 0; _retired int := 0; _deactivated int := 0; _created int := 0; _branch_fixed int := 0;
  _unlinked int := 0; _missing int := 0;
  _r record; _prof uuid; _code text; _n int;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'No organisation context'; END IF;
  IF NOT (public.has_permission('delivery','riders.manage') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  IF _commit THEN
    -- a) Link rider records to their staff account through the HR employee record.
    FOR _r IN
      SELECT rp.id, e.profile_id
        FROM public.rider_profiles rp
        JOIN public.employees e ON e.id = rp.employee_id AND e.organization_id = rp.organization_id
       WHERE rp.organization_id = _org
         AND rp.profile_id IS NULL
         AND e.profile_id IS NOT NULL
    LOOP
      IF EXISTS (SELECT 1 FROM public.rider_profiles x
                  WHERE x.organization_id = _org AND x.profile_id = _r.profile_id AND x.active AND x.id <> _r.id) THEN
        -- duplicate rider record for one staff identity: retire the spare
        UPDATE public.rider_profiles
           SET active = false, availability_status = 'offline', updated_at = now()
         WHERE id = _r.id
           AND NOT EXISTS (SELECT 1 FROM public.delivery_orders d
                            WHERE d.rider_id = _r.id
                              AND d.dispatch_status NOT IN ('delivered','delivery-failed','returned'));
        _retired := _retired + 1;
      ELSE
        UPDATE public.rider_profiles rp
           SET profile_id = _r.profile_id, updated_at = now()
         WHERE rp.id = _r.id;
        _linked := _linked + 1;
      END IF;
    END LOOP;

    -- b) Backfill employee link, property and display details from the canonical records.
    WITH fixed AS (
      UPDATE public.rider_profiles rp
         SET employee_id = COALESCE(rp.employee_id, e.id),
             branch_id   = COALESCE(rp.branch_id, e.branch_id, p.branch_id),
             display_name = COALESCE(NULLIF(p.full_name,''), rp.display_name),
             work_phone  = COALESCE(rp.work_phone, p.phone),
             updated_at  = now()
        FROM public.profiles p
        LEFT JOIN public.employees e ON e.profile_id = p.id AND e.organization_id = p.organization_id
       WHERE rp.organization_id = _org
         AND rp.profile_id = p.id
         AND (rp.employee_id IS NULL OR rp.branch_id IS NULL
              OR rp.display_name IS DISTINCT FROM p.full_name
              OR (rp.work_phone IS NULL AND p.phone IS NOT NULL))
      RETURNING 1
    ) SELECT count(*) INTO _branch_fixed FROM fixed;

    -- c) Deactivate riders whose staff account or rider capability is gone.
    WITH gone AS (
      UPDATE public.rider_profiles rp
         SET active = false, availability_status = 'offline', updated_at = now()
       WHERE rp.organization_id = _org
         AND rp.active
         AND rp.profile_id IS NOT NULL
         AND (
           NOT EXISTS (SELECT 1 FROM public.profiles p
                        WHERE p.id = rp.profile_id AND p.organization_id = _org
                          AND COALESCE(p.account_status,'active') = 'active'
                          AND COALESCE(p.employment_status,'active') NOT IN ('terminated','resigned','suspended','inactive'))
           OR NOT public.neo_rider_holds_capability(rp.profile_id, _org)
         )
      RETURNING 1
    ) SELECT count(*) INTO _deactivated FROM gone;

    -- d) Enrol active staff who hold a rider capability but have no rider record.
    FOR _r IN
      SELECT p.id AS profile_id, p.full_name, p.phone,
             COALESCE(e.branch_id, p.branch_id) AS branch_id, e.id AS employee_id
        FROM public.profiles p
        LEFT JOIN public.employees e ON e.profile_id = p.id AND e.organization_id = p.organization_id
       WHERE p.organization_id = _org
         AND COALESCE(p.account_type,'staff') = 'staff'
         AND COALESCE(p.account_status,'active') = 'active'
         AND COALESCE(p.employment_status,'active') NOT IN ('terminated','resigned','suspended','inactive')
         AND public.neo_rider_holds_capability(p.id, _org)
         AND NOT EXISTS (SELECT 1 FROM public.rider_profiles rp
                          WHERE rp.organization_id = _org AND rp.profile_id = p.id)
    LOOP
      LOOP
        SELECT COALESCE(max((regexp_replace(rider_code, '^RDR-', ''))::int), 0) + 1 INTO _n
          FROM public.rider_profiles
         WHERE organization_id = _org AND rider_code ~ '^RDR-[0-9]+$';
        _code := 'RDR-' || lpad(_n::text, 3, '0');
        EXIT WHEN NOT EXISTS (SELECT 1 FROM public.rider_profiles
                               WHERE organization_id = _org AND rider_code = _code);
      END LOOP;

      INSERT INTO public.rider_profiles (
        organization_id, branch_id, employee_id, profile_id, rider_code, display_name,
        work_phone, vehicle_type, max_active_deliveries, cash_handling_allowed,
        availability_status, active, created_by)
      VALUES (_org, _r.branch_id, _r.employee_id, _r.profile_id, _code, _r.full_name,
              _r.phone, 'motorcycle', 3, true, 'offline', true, auth.uid());
      _created := _created + 1;
    END LOOP;

    INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
    VALUES (_org, auth.uid(), '', 'delivery.rider.reconcile', 'delivery', NULL,
            jsonb_build_object('linked', _linked, 'created', _created, 'retired', _retired,
                               'deactivated', _deactivated, 'repaired', _branch_fixed));
  END IF;

  SELECT count(*) INTO _unlinked FROM public.rider_profiles
   WHERE organization_id = _org AND active AND profile_id IS NULL;
  SELECT count(*) INTO _missing FROM public.profiles p
   WHERE p.organization_id = _org
     AND COALESCE(p.account_status,'active') = 'active'
     AND public.neo_rider_holds_capability(p.id, _org)
     AND NOT EXISTS (SELECT 1 FROM public.rider_profiles rp
                      WHERE rp.organization_id = _org AND rp.profile_id = p.id AND rp.active);

  RETURN jsonb_build_object('ok', true, 'committed', _commit,
    'linked', _linked, 'created', _created, 'retired_duplicates', _retired,
    'deactivated', _deactivated, 'repaired', _branch_fixed,
    'still_unlinked', _unlinked, 'staff_without_rider_record', _missing);
END $function$;

REVOKE ALL ON FUNCTION public.neo_delivery_rider_reconcile(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_delivery_rider_reconcile(boolean) TO authenticated;

-- Availability must follow the shift roster once a rider has scheduled shifts.
CREATE OR REPLACE FUNCTION public.neo_delivery_rider_shift_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.availability_status IN ('available','online')
     AND NEW.availability_status IS DISTINCT FROM OLD.availability_status THEN
    IF EXISTS (SELECT 1 FROM public.rider_shifts s
                WHERE s.rider_id = NEW.id AND COALESCE(s.status,'scheduled') <> 'cancelled')
       AND NOT EXISTS (
         SELECT 1 FROM public.rider_shifts s
          WHERE s.rider_id = NEW.id
            AND COALESCE(s.status,'scheduled') <> 'cancelled'
            AND now() BETWEEN s.starts_at AND COALESCE(s.ends_at, s.starts_at + interval '12 hours')) THEN
      RAISE EXCEPTION 'This rider has no active shift right now — schedule or start a shift before going available.'
        USING ERRCODE = '22023';
    END IF;
  END IF;
  RETURN NEW;
END $function$;

REVOKE ALL ON FUNCTION public.neo_delivery_rider_shift_guard() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS trg_rider_shift_guard ON public.rider_profiles;
CREATE TRIGGER trg_rider_shift_guard
BEFORE UPDATE OF availability_status ON public.rider_profiles
FOR EACH ROW EXECUTE FUNCTION public.neo_delivery_rider_shift_guard();

-- =====================================================================
-- 2. EVENT BOOKING -> BILLING CONTRACT
-- =====================================================================
CREATE OR REPLACE FUNCTION public.neo_event_billing_build(_booking uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  org uuid := public.current_org_id();
  b public.event_bookings;
  lines int := 0;
  total numeric := 0;
  agreed numeric := 0;
  components int := 0;
BEGIN
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.has_permission('events','billing','create') OR public.has_permission('events','billing','edit')) THEN
    RAISE EXCEPTION 'The events.billing.create permission is required.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO b FROM public.event_bookings
   WHERE id = _booking AND organization_id = org FOR UPDATE;
  IF b.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF NOT public.neo_branch_in_scope(b.branch_id) THEN
    RAISE EXCEPTION 'That property is outside your access scope.' USING ERRCODE = '42501';
  END IF;
  IF b.billing_status = 'finalised' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_finalised',
      'detail', 'The bill is finalised. Record an adjustment instead of rebuilding it.');
  END IF;

  -- The contracted commercial value survives a rebuild: quotation first, then the
  -- value already agreed on the booking.
  SELECT GREATEST(COALESCE(b.total_amount,0),
                  COALESCE((SELECT q.total_amount FROM public.event_quotations q
                             WHERE q.id = b.quotation_id), 0))
    INTO agreed;

  DELETE FROM public.event_billing_items WHERE booking_id = b.id AND generated = true;

  INSERT INTO public.event_billing_items
    (organization_id, branch_id, booking_id, category, description, quantity, unit_price,
     line_total, unit_cost, tax_rate, is_complimentary, created_by, source_key, generated)
  SELECT b.organization_id, b.branch_id, b.id, 'catering',
         'Menu — ' || m.name || ' (' || coalesce(m.service_style,'service') || ')',
         greatest(coalesce(nullif(m.guest_count,0), b.guaranteed_guests, b.expected_guests, 0), 0),
         coalesce(m.price_per_person, 0),
         greatest(coalesce(nullif(m.guest_count,0), b.guaranteed_guests, b.expected_guests, 0), 0)
           * coalesce(m.price_per_person, 0),
         coalesce(m.estimated_cost, 0), 0, false, auth.uid(), 'menu:' || m.id::text, true
    FROM public.event_menus m
   WHERE m.booking_id = b.id AND coalesce(m.price_per_person,0) > 0;

  INSERT INTO public.event_billing_items
    (organization_id, branch_id, booking_id, category, description, quantity, unit_price,
     line_total, unit_cost, tax_rate, is_complimentary, created_by, source_key, generated)
  SELECT b.organization_id, b.branch_id, b.id, 'resource',
         'Resource — ' || r.name,
         greatest(coalesce(rr.quantity,1), 1), coalesce(r.hire_price, 0),
         greatest(coalesce(rr.quantity,1), 1) * coalesce(r.hire_price, 0),
         0, 0, false, auth.uid(), 'resource:' || rr.id::text, true
    FROM public.event_resource_reservations rr
    JOIN public.event_resources r ON r.id = rr.resource_id
   WHERE rr.booking_id = b.id
     AND coalesce(rr.status,'reserved') NOT IN ('cancelled','released')
     AND coalesce(r.hire_price,0) > 0;

  INSERT INTO public.event_billing_items
    (organization_id, branch_id, booking_id, category, description, quantity, unit_price,
     line_total, unit_cost, tax_rate, is_complimentary, created_by, source_key, generated)
  SELECT b.organization_id, b.branch_id, b.id, 'vendor',
         'Vendor — ' || v.vendor_name || coalesce(' (' || nullif(v.service,'') || ')', ''),
         1, coalesce(v.agreed_cost, 0), coalesce(v.agreed_cost, 0), coalesce(v.agreed_cost, 0),
         0, false, auth.uid(), 'vendor:' || v.id::text, true
    FROM public.event_vendors v
   WHERE v.booking_id = b.id
     AND coalesce(v.status,'confirmed') NOT IN ('cancelled','declined')
     AND coalesce(v.agreed_cost,0) > 0;

  INSERT INTO public.event_billing_items
    (organization_id, branch_id, booking_id, category, description, quantity, unit_price,
     line_total, unit_cost, tax_rate, is_complimentary, created_by, source_key, generated)
  SELECT b.organization_id, b.branch_id, b.id, 'adjustment',
         'Change — ' || coalesce(nullif(cr.reason,''), cr.change_type),
         1, cr.financial_impact, cr.financial_impact, 0, 0, false, auth.uid(),
         'change:' || cr.id::text, true
    FROM public.event_change_requests cr
   WHERE cr.booking_id = b.id
     AND coalesce(cr.status,'') IN ('approved','applied')
     AND coalesce(cr.financial_impact,0) <> 0;

  SELECT count(*) INTO components FROM public.event_billing_items WHERE booking_id = b.id;

  -- No itemised components but a contracted value exists: bill the agreed package
  -- so the invoice, folio and finance handoff carry the real amount.
  IF components = 0 AND agreed > 0 THEN
    INSERT INTO public.event_billing_items
      (organization_id, branch_id, booking_id, category, description, quantity, unit_price,
       line_total, unit_cost, tax_rate, is_complimentary, created_by, source_key, generated)
    VALUES (b.organization_id, b.branch_id, b.id, 'package',
            'Contracted event package — ' || coalesce(nullif(b.event_name,''), b.event_reference),
            1, agreed, agreed, 0, 0, false, auth.uid(), 'booking-value', true);
  END IF;

  SELECT count(*), coalesce(sum(CASE WHEN is_complimentary THEN 0 ELSE line_total END), 0)
    INTO lines, total
    FROM public.event_billing_items WHERE booking_id = b.id;

  UPDATE public.event_bookings
     SET total_amount = CASE WHEN lines > 0 THEN total ELSE COALESCE(b.total_amount, 0) END,
         deposit_required = CASE
           WHEN COALESCE(b.deposit_required,0) > 0 THEN b.deposit_required
           ELSE COALESCE(b.deposit_required,0) END,
         billing_status = CASE WHEN lines > 0 THEN 'draft' ELSE 'not_billed' END,
         billing_generated_at = now(),
         updated_at = now()
   WHERE id = b.id;

  INSERT INTO public.event_activity_logs (organization_id, booking_id, action, detail, actor_id)
  VALUES (b.organization_id, b.id, 'events.billing.built',
          jsonb_build_object('lines', lines, 'total', total, 'from_contract', components = 0), auth.uid());

  RETURN jsonb_build_object('ok', true, 'lines', lines, 'total', total,
    'from_contract', components = 0,
    'deposit_required', COALESCE(b.deposit_required,0),
    'deposit_paid', COALESCE(b.deposit_paid,0),
    'billing_status', CASE WHEN lines > 0 THEN 'draft' ELSE 'not_billed' END);
END $function$;

-- =====================================================================
-- 3. APPROVAL GOVERNANCE DEFAULTS (configurable per organisation)
-- =====================================================================
CREATE OR REPLACE FUNCTION public.neo_approval_seed_authority(_commit boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _created int := 0; _skipped int := 0;
  _t record; _l record; _role uuid;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'No organisation context'; END IF;
  IF NOT (public.is_org_admin() OR public.has_permission('administration','approvals','edit')) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  FOR _t IN SELECT key FROM public.approval_types WHERE organization_id = _org AND COALESCE(active,true) LOOP
    IF EXISTS (SELECT 1 FROM public.approval_rules r
                WHERE r.organization_id = _org AND r.approval_type = _t.key) THEN
      _skipped := _skipped + 1;
      CONTINUE;
    END IF;

    FOR _l IN
      SELECT * FROM (VALUES
        (1, ARRAY['operations-manager','duty-manager','department-manager','front-office-manager'],  25000::numeric, 10::numeric, 'Department / duty manager'),
        (2, ARRAY['financial-controller','finance-manager','accountant'],                           250000::numeric, 25::numeric, 'Finance authority'),
        (3, ARRAY['general-manager','deputy-general-manager'],                                     1000000::numeric, 50::numeric, 'General manager'),
        (4, ARRAY['owner','director','managing-director'],                                              NULL::numeric, NULL::numeric, 'Owner / Director')
      ) AS v(lvl, keys, max_amount, max_percent, label)
    LOOP
      SELECT r.id INTO _role
        FROM public.roles r
       WHERE r.organization_id = _org
         AND COALESCE(r.active,true)
         AND lower(COALESCE(r.normalized_role_key, replace(lower(r.name),' ','-'))) = ANY(_l.keys)
       ORDER BY array_position(_l.keys, lower(COALESCE(r.normalized_role_key, replace(lower(r.name),' ','-'))))
       LIMIT 1;

      IF _role IS NULL THEN CONTINUE; END IF;

      IF _commit THEN
        INSERT INTO public.approval_rules (organization_id, approval_type, level, approver_role_id,
          max_amount, max_percent, required_approvers, allow_self_approval, escalate_above_limit,
          active, label, created_by)
        VALUES (_org, _t.key, _l.lvl, _role, _l.max_amount, _l.max_percent, 1, false, true,
                true, _l.label, auth.uid());
      END IF;
      _created := _created + 1;
    END LOOP;
  END LOOP;

  IF _commit AND _created > 0 THEN
    INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
    VALUES (_org, auth.uid(), '', 'administration.approvals.seed_authority', 'administration', NULL,
            jsonb_build_object('rules_created', _created));
  END IF;

  RETURN jsonb_build_object('ok', true, 'committed', _commit,
    'rules', _created, 'types_already_configured', _skipped);
END $function$;

REVOKE ALL ON FUNCTION public.neo_approval_seed_authority(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_approval_seed_authority(boolean) TO authenticated;

-- =====================================================================
-- 4. FINANCE WORKSPACE READINESS
-- =====================================================================
CREATE OR REPLACE FUNCTION public.neo_finance_readiness()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _accounts int; _tax int; _years int; _periods int; _open int; _methods int;
BEGIN
  IF _org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.is_org_admin() OR public.has_permission('finance','view')) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO _accounts FROM public.chart_of_accounts WHERE organization_id = _org;
  SELECT count(*) INTO _tax FROM public.tax_codes WHERE organization_id = _org;
  SELECT count(*) INTO _years FROM public.financial_years WHERE organization_id = _org;
  SELECT count(*) INTO _periods FROM public.accounting_periods WHERE organization_id = _org;
  SELECT count(*) INTO _open FROM public.accounting_periods
   WHERE organization_id = _org AND CURRENT_DATE BETWEEN starts_on AND ends_on
     AND COALESCE(status,'open') = 'open';
  SELECT count(*) INTO _methods FROM public.payment_methods WHERE organization_id = _org AND COALESCE(active,true);

  RETURN jsonb_build_object(
    'ok', true,
    'accounts', _accounts,
    'tax_codes', _tax,
    'financial_years', _years,
    'periods', _periods,
    'current_period_open', _open > 0,
    'payment_methods', _methods,
    'ready', (_accounts > 0 AND _tax > 0 AND _years > 0 AND _periods > 0 AND _open > 0),
    'blocking', (
      SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM (
        SELECT 'chart_of_accounts' AS x WHERE _accounts = 0
        UNION ALL SELECT 'tax_codes' WHERE _tax = 0
        UNION ALL SELECT 'financial_year' WHERE _years = 0
        UNION ALL SELECT 'accounting_periods' WHERE _periods = 0
        UNION ALL SELECT 'open_period_today' WHERE _open = 0
        UNION ALL SELECT 'payment_methods' WHERE _methods = 0
      ) s
    ));
END $function$;

REVOKE ALL ON FUNCTION public.neo_finance_readiness() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_finance_readiness() TO authenticated;
