
-- ============ Package allocation rules ============
CREATE TABLE public.package_allocation_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  name text NOT NULL,
  package_type text NOT NULL DEFAULT 'custom',
  room_type_id uuid REFERENCES public.room_types(id) ON DELETE CASCADE,
  rate_plan_id uuid REFERENCES public.rate_plans(id) ON DELETE CASCADE,
  meal_plan_id uuid REFERENCES public.meal_plans(id) ON DELETE CASCADE,
  corporate_account_id uuid REFERENCES public.corporate_accounts(id) ON DELETE CASCADE,
  group_booking_id uuid REFERENCES public.group_bookings(id) ON DELETE CASCADE,
  occupancy_type text NOT NULL DEFAULT 'any',
  guest_category text NOT NULL DEFAULT 'any',
  season_label text,
  valid_from date,
  valid_to date,
  allocation_method text NOT NULL DEFAULT 'fixed',
  package_price numeric NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'KES',
  tax_treatment text NOT NULL DEFAULT 'inclusive',
  discount_rule text NOT NULL DEFAULT 'proportional',
  priority integer NOT NULL DEFAULT 100,
  status text NOT NULL DEFAULT 'draft',
  notes text,
  created_by uuid,
  activated_by uuid,
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT package_allocation_rules_method_chk CHECK (allocation_method IN ('fixed','percentage')),
  CONSTRAINT package_allocation_rules_status_chk CHECK (status IN ('draft','active','inactive')),
  CONSTRAINT package_allocation_rules_discount_chk CHECK (discount_rule IN ('proportional','rooms-only','meals-only','manual')),
  CONSTRAINT package_allocation_rules_type_chk CHECK (package_type IN ('room-only','bed-breakfast','half-board','full-board','custom'))
);

CREATE TABLE public.package_allocation_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  rule_id uuid NOT NULL REFERENCES public.package_allocation_rules(id) ON DELETE CASCADE,
  component_type text NOT NULL,
  label text NOT NULL,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  revenue_centre text,
  gl_account_id uuid REFERENCES public.chart_of_accounts(id) ON DELETE SET NULL,
  method text NOT NULL DEFAULT 'fixed',
  amount numeric NOT NULL DEFAULT 0,
  percentage numeric NOT NULL DEFAULT 0,
  tax_treatment text NOT NULL DEFAULT 'inclusive',
  meal_period text,
  creates_entitlement boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT package_allocation_components_type_chk CHECK (component_type IN ('room','breakfast','lunch','dinner','other')),
  CONSTRAINT package_allocation_components_method_chk CHECK (method IN ('fixed','percentage'))
);
CREATE INDEX package_allocation_components_rule_idx ON public.package_allocation_components(rule_id);

-- ============ Posted allocations ============
CREATE TABLE public.package_revenue_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid,
  rule_id uuid REFERENCES public.package_allocation_rules(id) ON DELETE SET NULL,
  component_id uuid REFERENCES public.package_allocation_components(id) ON DELETE SET NULL,
  folio_id uuid REFERENCES public.folios(id) ON DELETE CASCADE,
  folio_line_id uuid REFERENCES public.folio_lines(id) ON DELETE CASCADE,
  reservation_id uuid REFERENCES public.reservations(id) ON DELETE SET NULL,
  stay_id uuid,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  room_id uuid REFERENCES public.rooms(id) ON DELETE SET NULL,
  room_type_id uuid REFERENCES public.room_types(id) ON DELETE SET NULL,
  rate_plan_id uuid REFERENCES public.rate_plans(id) ON DELETE SET NULL,
  meal_plan_id uuid REFERENCES public.meal_plans(id) ON DELETE SET NULL,
  package_type text,
  component_type text NOT NULL,
  component_label text,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  revenue_centre text,
  gl_account_id uuid REFERENCES public.chart_of_accounts(id) ON DELETE SET NULL,
  stay_date date NOT NULL,
  posting_date timestamptz NOT NULL DEFAULT now(),
  package_price numeric NOT NULL DEFAULT 0,
  allocated_amount numeric NOT NULL DEFAULT 0,
  discount_amount numeric NOT NULL DEFAULT 0,
  tax_amount numeric NOT NULL DEFAULT 0,
  tax_treatment text,
  allocation_method text,
  discount_rule text,
  status text NOT NULL DEFAULT 'posted',
  source text NOT NULL DEFAULT 'night-audit',
  reverses_allocation_id uuid REFERENCES public.package_revenue_allocations(id) ON DELETE SET NULL,
  reversal_reason text,
  idempotency_key text,
  posted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT package_revenue_allocations_status_chk CHECK (status IN ('posted','reversed','reversal'))
);
CREATE UNIQUE INDEX package_revenue_allocations_idem_idx
  ON public.package_revenue_allocations(organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX package_revenue_allocations_line_idx ON public.package_revenue_allocations(folio_line_id);
CREATE INDEX package_revenue_allocations_date_idx ON public.package_revenue_allocations(organization_id, stay_date);

-- ============ Meal entitlements ============
CREATE TABLE public.package_meal_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid,
  allocation_id uuid REFERENCES public.package_revenue_allocations(id) ON DELETE CASCADE,
  reservation_id uuid REFERENCES public.reservations(id) ON DELETE CASCADE,
  folio_id uuid REFERENCES public.folios(id) ON DELETE SET NULL,
  stay_id uuid,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  room_id uuid REFERENCES public.rooms(id) ON DELETE SET NULL,
  service_date date NOT NULL,
  meal_period text NOT NULL,
  guest_count integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'pending',
  consumed_at timestamptz,
  recorded_by uuid,
  notes text,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT package_meal_entitlements_status_chk CHECK (status IN ('pending','consumed','missed','packed','replaced','cancelled'))
);
CREATE UNIQUE INDEX package_meal_entitlements_idem_idx
  ON public.package_meal_entitlements(organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX package_meal_entitlements_date_idx ON public.package_meal_entitlements(organization_id, service_date, meal_period);

-- ============ Grants ============
GRANT SELECT, INSERT, UPDATE, DELETE ON public.package_allocation_rules TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.package_allocation_components TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.package_revenue_allocations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.package_meal_entitlements TO authenticated;
GRANT ALL ON public.package_allocation_rules TO service_role;
GRANT ALL ON public.package_allocation_components TO service_role;
GRANT ALL ON public.package_revenue_allocations TO service_role;
GRANT ALL ON public.package_meal_entitlements TO service_role;

ALTER TABLE public.package_allocation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.package_allocation_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.package_revenue_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.package_meal_entitlements ENABLE ROW LEVEL SECURITY;

CREATE POLICY staff_read_pkg_rules ON public.package_allocation_rules FOR SELECT TO authenticated USING (organization_id = public.current_org_id());
CREATE POLICY staff_insert_pkg_rules ON public.package_allocation_rules FOR INSERT TO authenticated WITH CHECK (organization_id = public.current_org_id() AND (public.has_permission('finance','edit') OR public.has_permission('pms','write')));
CREATE POLICY staff_update_pkg_rules ON public.package_allocation_rules FOR UPDATE TO authenticated USING (organization_id = public.current_org_id() AND (public.has_permission('finance','edit') OR public.has_permission('pms','write'))) WITH CHECK (organization_id = public.current_org_id());
CREATE POLICY staff_delete_pkg_rules ON public.package_allocation_rules FOR DELETE TO authenticated USING (organization_id = public.current_org_id() AND public.is_org_admin());

CREATE POLICY staff_read_pkg_components ON public.package_allocation_components FOR SELECT TO authenticated USING (organization_id = public.current_org_id());
CREATE POLICY staff_insert_pkg_components ON public.package_allocation_components FOR INSERT TO authenticated WITH CHECK (organization_id = public.current_org_id() AND (public.has_permission('finance','edit') OR public.has_permission('pms','write')));
CREATE POLICY staff_update_pkg_components ON public.package_allocation_components FOR UPDATE TO authenticated USING (organization_id = public.current_org_id() AND (public.has_permission('finance','edit') OR public.has_permission('pms','write'))) WITH CHECK (organization_id = public.current_org_id());
CREATE POLICY staff_delete_pkg_components ON public.package_allocation_components FOR DELETE TO authenticated USING (organization_id = public.current_org_id() AND (public.has_permission('finance','edit') OR public.has_permission('pms','write')));

CREATE POLICY staff_read_pkg_allocations ON public.package_revenue_allocations FOR SELECT TO authenticated USING (organization_id = public.current_org_id());
CREATE POLICY staff_read_pkg_entitlements ON public.package_meal_entitlements FOR SELECT TO authenticated USING (organization_id = public.current_org_id());
CREATE POLICY staff_update_pkg_entitlements ON public.package_meal_entitlements FOR UPDATE TO authenticated USING (organization_id = public.current_org_id() AND (public.has_permission('pms','write') OR public.has_permission('restaurant','write') OR public.has_permission('kitchen','write'))) WITH CHECK (organization_id = public.current_org_id());

CREATE TRIGGER package_allocation_rules_touch BEFORE UPDATE ON public.package_allocation_rules FOR EACH ROW EXECUTE FUNCTION public.fin_touch_updated_at();
CREATE TRIGGER package_allocation_components_touch BEFORE UPDATE ON public.package_allocation_components FOR EACH ROW EXECUTE FUNCTION public.fin_touch_updated_at();
CREATE TRIGGER package_meal_entitlements_touch BEFORE UPDATE ON public.package_meal_entitlements FOR EACH ROW EXECUTE FUNCTION public.fin_touch_updated_at();

-- ============ Balance validation ============
CREATE OR REPLACE FUNCTION public.pkg_rule_balance(_rule uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _r public.package_allocation_rules; _total numeric := 0; _pct numeric := 0;
BEGIN
  SELECT * INTO _r FROM public.package_allocation_rules WHERE id=_rule;
  IF _r.id IS NULL THEN RETURN jsonb_build_object('balanced', false, 'reason','rule not found'); END IF;
  SELECT COALESCE(sum(CASE WHEN c.method='percentage' THEN round(_r.package_price * c.percentage/100, 2) ELSE c.amount END),0),
         COALESCE(sum(CASE WHEN c.method='percentage' THEN c.percentage ELSE 0 END),0)
    INTO _total, _pct
  FROM public.package_allocation_components c WHERE c.rule_id=_rule;
  RETURN jsonb_build_object(
    'package_price', _r.package_price,
    'allocated_total', _total,
    'variance', round(_r.package_price - _total, 2),
    'percentage_total', _pct,
    'component_count', (SELECT count(*) FROM public.package_allocation_components WHERE rule_id=_rule),
    'balanced', (SELECT count(*) FROM public.package_allocation_components WHERE rule_id=_rule) > 0
                AND abs(_r.package_price - _total) <= 0.01
  );
END; $$;

CREATE OR REPLACE FUNCTION public.pkg_guard_rule_activation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _b jsonb;
BEGIN
  IF NEW.status = 'active' THEN
    _b := public.pkg_rule_balance(NEW.id);
    IF NOT (_b->>'balanced')::boolean THEN
      RAISE EXCEPTION 'Allocations (%) must equal the package selling price (%)',
        _b->>'allocated_total', _b->>'package_price';
    END IF;
    IF NEW.activated_at IS NULL THEN NEW.activated_at := now(); NEW.activated_by := auth.uid(); END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER package_allocation_rules_guard BEFORE INSERT OR UPDATE ON public.package_allocation_rules
FOR EACH ROW EXECUTE FUNCTION public.pkg_guard_rule_activation();

-- ============ Rule resolution ============
CREATE OR REPLACE FUNCTION public.pkg_resolve_rule(
  _org uuid, _branch uuid, _rate_plan uuid, _meal_plan uuid, _room_type uuid,
  _corporate uuid, _group uuid, _date date, _occupancy text DEFAULT 'any'
) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT r.id FROM public.package_allocation_rules r
  WHERE r.organization_id=_org AND r.status='active'
    AND (r.branch_id IS NULL OR r.branch_id = _branch)
    AND (r.rate_plan_id IS NULL OR r.rate_plan_id = _rate_plan)
    AND (r.meal_plan_id IS NULL OR r.meal_plan_id = _meal_plan)
    AND (r.room_type_id IS NULL OR r.room_type_id = _room_type)
    AND (r.corporate_account_id IS NULL OR r.corporate_account_id = _corporate)
    AND (r.group_booking_id IS NULL OR r.group_booking_id = _group)
    AND (r.occupancy_type = 'any' OR r.occupancy_type = _occupancy)
    AND (r.valid_from IS NULL OR r.valid_from <= _date)
    AND (r.valid_to IS NULL OR r.valid_to >= _date)
  ORDER BY
    (r.group_booking_id IS NOT NULL)::int + (r.corporate_account_id IS NOT NULL)::int
    + (r.rate_plan_id IS NOT NULL)::int + (r.meal_plan_id IS NOT NULL)::int
    + (r.room_type_id IS NOT NULL)::int + (r.branch_id IS NOT NULL)::int
    + (r.valid_from IS NOT NULL)::int DESC,
    r.priority ASC, r.created_at DESC
  LIMIT 1;
$$;

-- ============ Allocate a posted folio line ============
CREATE OR REPLACE FUNCTION public.pkg_allocate_folio_line(_line uuid, _source text DEFAULT 'manual')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  _org uuid := public.current_org_id();
  _l public.folio_lines; _res public.reservations; _rule public.package_allocation_rules;
  _c record; _price numeric; _disc numeric; _amount numeric; _share numeric;
  _meal_total numeric; _room_total numeric; _n integer := 0; _sum numeric := 0;
  _alloc uuid; _occ text; _stay_date date; _room uuid; _stay uuid;
BEGIN
  SELECT * INTO _l FROM public.folio_lines WHERE id=_line AND organization_id=_org;
  IF _l.id IS NULL THEN RAISE EXCEPTION 'Folio line not found'; END IF;
  IF _l.reservation_id IS NULL THEN RETURN jsonb_build_object('allocated', 0, 'reason','no reservation'); END IF;
  SELECT * INTO _res FROM public.reservations WHERE id=_l.reservation_id;

  _occ := CASE WHEN COALESCE(_res.adults,1) <= 1 THEN 'single'
               WHEN _res.adults = 2 THEN 'double'
               WHEN _res.adults = 3 THEN 'triple' ELSE 'family' END;
  _stay_date := COALESCE(_l.operational_date, _l.posting_date::date);

  SELECT * INTO _rule FROM public.package_allocation_rules
   WHERE id = public.pkg_resolve_rule(_org, _l.branch_id, _res.rate_plan_id, _res.meal_plan_id,
                                      _res.room_type_id, _res.corporate_account_id, _res.group_booking_id,
                                      _stay_date, _occ);
  IF _rule.id IS NULL THEN RETURN jsonb_build_object('allocated', 0, 'reason','no active allocation rule'); END IF;

  IF EXISTS (SELECT 1 FROM public.package_revenue_allocations
              WHERE folio_line_id=_line AND status='posted') THEN
    RETURN jsonb_build_object('allocated', 0, 'reason','already allocated');
  END IF;

  _price := COALESCE(_l.gross_amount, 0);
  _disc := COALESCE(_l.discount_amount, 0);

  SELECT f.stay_id INTO _stay FROM public.folios f WHERE f.id=_l.folio_id;
  SELECT s.room_id INTO _room FROM public.stays s WHERE s.id=_stay;

  SELECT COALESCE(sum(CASE WHEN c.method='percentage' THEN round(_rule.package_price*c.percentage/100,2) ELSE c.amount END),0)
    INTO _room_total FROM public.package_allocation_components c WHERE c.rule_id=_rule.id AND c.component_type='room';
  SELECT COALESCE(sum(CASE WHEN c.method='percentage' THEN round(_rule.package_price*c.percentage/100,2) ELSE c.amount END),0)
    INTO _meal_total FROM public.package_allocation_components c WHERE c.rule_id=_rule.id AND c.component_type <> 'room';

  FOR _c IN SELECT * FROM public.package_allocation_components WHERE rule_id=_rule.id ORDER BY sort_order, created_at LOOP
    IF _c.method='percentage' THEN
      _amount := round(_price * _c.percentage / 100, 2);
    ELSE
      _share := CASE WHEN _rule.package_price > 0 THEN _c.amount / _rule.package_price ELSE 0 END;
      _amount := round(_price * _share, 2);
    END IF;

    -- discount treatment
    IF _disc > 0 THEN
      IF _rule.discount_rule = 'rooms-only' AND _c.component_type='room' AND _room_total > 0 THEN
        _amount := _amount; -- discount already reflected in gross for rooms
      ELSIF _rule.discount_rule = 'meals-only' AND _c.component_type <> 'room' AND _meal_total > 0 THEN
        _amount := _amount;
      END IF;
    END IF;

    INSERT INTO public.package_revenue_allocations (
      organization_id, branch_id, rule_id, component_id, folio_id, folio_line_id, reservation_id,
      stay_id, customer_id, room_id, room_type_id, rate_plan_id, meal_plan_id, package_type,
      component_type, component_label, department_id, revenue_centre, gl_account_id, stay_date,
      package_price, allocated_amount, discount_amount, tax_treatment, allocation_method, discount_rule,
      source, idempotency_key, posted_by)
    VALUES (_org, _l.branch_id, _rule.id, _c.id, _l.folio_id, _line, _l.reservation_id,
      _stay, _res.customer_id, _room, _res.room_type_id, _res.rate_plan_id, _res.meal_plan_id, _rule.package_type,
      _c.component_type, _c.label, _c.department_id, _c.revenue_centre, _c.gl_account_id, _stay_date,
      _price, _amount, _disc, _c.tax_treatment, _rule.allocation_method, _rule.discount_rule,
      _source, 'alloc:' || _line::text || ':' || _c.id::text, auth.uid())
    RETURNING id INTO _alloc;
    _n := _n + 1; _sum := _sum + _amount;

    IF _c.creates_entitlement AND _c.component_type <> 'room' THEN
      INSERT INTO public.package_meal_entitlements (
        organization_id, branch_id, allocation_id, reservation_id, folio_id, stay_id, customer_id,
        room_id, service_date, meal_period, guest_count, idempotency_key)
      VALUES (_org, _l.branch_id, _alloc, _l.reservation_id, _l.folio_id, _stay, _res.customer_id,
        _room, _stay_date, COALESCE(_c.meal_period, _c.component_type),
        GREATEST(COALESCE(_res.adults,1) + COALESCE(_res.children,0), 1),
        'ent:' || _line::text || ':' || _c.id::text)
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;

  -- rounding remainder onto the largest component so allocations tie back exactly
  IF _n > 0 AND abs(_price - _sum) > 0 THEN
    UPDATE public.package_revenue_allocations SET allocated_amount = allocated_amount + (_price - _sum)
    WHERE id = (SELECT id FROM public.package_revenue_allocations
                WHERE folio_line_id=_line AND status='posted' ORDER BY allocated_amount DESC LIMIT 1);
    _sum := _price;
  END IF;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (_org, auth.uid(), '', 'pms.package.allocated', 'finance', _line::text,
    jsonb_build_object('rule', _rule.id, 'components', _n, 'package_price', _price, 'allocated', _sum));

  RETURN jsonb_build_object('allocated', _n, 'package_price', _price, 'total_allocated', _sum,
    'balanced', abs(_price - _sum) <= 0.01, 'rule', _rule.id);
END; $$;

-- ============ Reversal ============
CREATE OR REPLACE FUNCTION public.pkg_reverse_allocations(_line uuid, _reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _org uuid := public.current_org_id(); _a record; _n integer := 0;
BEGIN
  IF NOT (public.has_permission('finance','edit') OR public.has_permission('pms','write')) THEN
    RAISE EXCEPTION 'Not permitted to reverse allocations';
  END IF;
  IF COALESCE(btrim(_reason),'') = '' THEN RAISE EXCEPTION 'A reversal reason is required'; END IF;

  FOR _a IN SELECT * FROM public.package_revenue_allocations
             WHERE organization_id=_org AND folio_line_id=_line AND status='posted' LOOP
    INSERT INTO public.package_revenue_allocations (
      organization_id, branch_id, rule_id, component_id, folio_id, folio_line_id, reservation_id,
      stay_id, customer_id, room_id, room_type_id, rate_plan_id, meal_plan_id, package_type,
      component_type, component_label, department_id, revenue_centre, gl_account_id, stay_date,
      package_price, allocated_amount, discount_amount, tax_treatment, allocation_method, discount_rule,
      status, source, reverses_allocation_id, reversal_reason, idempotency_key, posted_by)
    VALUES (_a.organization_id, _a.branch_id, _a.rule_id, _a.component_id, _a.folio_id, _a.folio_line_id,
      _a.reservation_id, _a.stay_id, _a.customer_id, _a.room_id, _a.room_type_id, _a.rate_plan_id,
      _a.meal_plan_id, _a.package_type, _a.component_type, _a.component_label, _a.department_id,
      _a.revenue_centre, _a.gl_account_id, _a.stay_date, _a.package_price, -_a.allocated_amount,
      _a.discount_amount, _a.tax_treatment, _a.allocation_method, _a.discount_rule,
      'reversal', 'reversal', _a.id, _reason, 'rev:' || _a.id::text, auth.uid());
    UPDATE public.package_revenue_allocations SET status='reversed', reversal_reason=_reason WHERE id=_a.id;
    UPDATE public.package_meal_entitlements SET status='cancelled', notes=_reason
      WHERE allocation_id=_a.id AND status='pending';
    _n := _n + 1;
  END LOOP;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (_org, auth.uid(), '', 'pms.package.allocation_reversed', 'finance', _line::text,
    jsonb_build_object('reversed', _n, 'reason', _reason));
  RETURN jsonb_build_object('reversed', _n);
END; $$;

-- Recalculate: reverse then re-allocate at the current folio line values
CREATE OR REPLACE FUNCTION public.pkg_reallocate_folio_line(_line uuid, _reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _rev jsonb;
BEGIN
  _rev := public.pkg_reverse_allocations(_line, _reason);
  RETURN jsonb_build_object('reversal', _rev, 'allocation', public.pkg_allocate_folio_line(_line, 'recalculation'));
END; $$;

-- ============ Reporting ============
CREATE OR REPLACE FUNCTION public.pkg_allocation_report(_branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _org uuid := public.current_org_id(); _f date := COALESCE(_from, CURRENT_DATE - 30); _t date := COALESCE(_to, CURRENT_DATE);
BEGIN
  IF NOT public.has_permission('finance','view') THEN RAISE EXCEPTION 'Not permitted'; END IF;
  RETURN (
    WITH rows AS (
      SELECT a.*, rt.name AS room_type_name, rp.name AS rate_plan_name, d.name AS department_name, b.name AS branch_name
      FROM public.package_revenue_allocations a
      LEFT JOIN public.room_types rt ON rt.id=a.room_type_id
      LEFT JOIN public.rate_plans rp ON rp.id=a.rate_plan_id
      LEFT JOIN public.departments d ON d.id=a.department_id
      LEFT JOIN public.branches b ON b.id=a.branch_id
      WHERE a.organization_id=_org AND a.stay_date BETWEEN _f AND _t
        AND a.status <> 'reversed'
        AND (_branch IS NULL OR a.branch_id=_branch)
    ), lines AS (
      SELECT folio_line_id, max(package_price) AS package_price, sum(allocated_amount) AS allocated
      FROM rows GROUP BY folio_line_id
    )
    SELECT jsonb_build_object(
      'package_sales', (SELECT COALESCE(sum(package_price),0) FROM lines),
      'total_allocated', (SELECT COALESCE(sum(allocated_amount),0) FROM rows),
      'by_component', (SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM (
          SELECT component_type AS label, sum(allocated_amount) AS amount FROM rows GROUP BY 1 ORDER BY 2 DESC) x),
      'by_department', (SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM (
          SELECT COALESCE(department_name,'Unassigned') AS label, sum(allocated_amount) AS amount FROM rows GROUP BY 1 ORDER BY 2 DESC) x),
      'by_room_type', (SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM (
          SELECT COALESCE(room_type_name,'Unknown') AS label, sum(allocated_amount) AS amount FROM rows GROUP BY 1 ORDER BY 2 DESC) x),
      'by_rate_plan', (SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM (
          SELECT COALESCE(rate_plan_name,'Unknown') AS label, sum(allocated_amount) AS amount FROM rows GROUP BY 1 ORDER BY 2 DESC) x),
      'by_branch', (SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM (
          SELECT COALESCE(branch_name,'Unassigned') AS label, sum(allocated_amount) AS amount FROM rows GROUP BY 1 ORDER BY 2 DESC) x),
      'by_stay_date', (SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM (
          SELECT stay_date::text AS label, sum(allocated_amount) AS amount FROM rows GROUP BY 1 ORDER BY 1) x),
      'unbalanced', (SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM (
          SELECT folio_line_id, package_price, allocated, round(package_price - allocated, 2) AS variance
          FROM lines WHERE abs(package_price - allocated) > 0.01) x)
    )
  );
END; $$;

REVOKE EXECUTE ON FUNCTION public.pkg_rule_balance(uuid) FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.pkg_guard_rule_activation() FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.pkg_resolve_rule(uuid,uuid,uuid,uuid,uuid,uuid,uuid,date,text) FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.pkg_allocate_folio_line(uuid,text) FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.pkg_reverse_allocations(uuid,text) FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.pkg_reallocate_folio_line(uuid,text) FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.pkg_allocation_report(uuid,date,date) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.pkg_rule_balance(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pkg_allocate_folio_line(uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pkg_reverse_allocations(uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pkg_reallocate_folio_line(uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pkg_allocation_report(uuid,date,date) TO authenticated;

-- ============ Night audit hook ============
CREATE OR REPLACE FUNCTION public.pms_post_accommodation(_operational_date date DEFAULT CURRENT_DATE)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _org uuid := public.current_org_id(); _r record; _n integer := 0; _tax numeric; _line uuid;
BEGIN
  IF NOT public.has_permission('pms','folios.post_charge') THEN RAISE EXCEPTION 'Not permitted to post charges'; END IF;
  FOR _r IN
    SELECT s.id AS stay_id, s.reservation_id, f.id AS folio_id, f.branch_id, res.nightly_rate,
           COALESCE(rp.tax_rate,0) AS tax_rate, rm.room_number
    FROM public.stays s
    JOIN public.reservations res ON res.id = s.reservation_id
    JOIN public.folios f ON f.stay_id = s.id AND f.folio_type='guest' AND f.status='open'
    LEFT JOIN public.rate_plans rp ON rp.id = res.rate_plan_id
    LEFT JOIN public.rooms rm ON rm.id = s.room_id
    WHERE s.organization_id=_org AND s.status='in-house'
      AND _operational_date >= res.arrival_date AND _operational_date < res.departure_date
  LOOP
    _tax := round(_r.nightly_rate * _r.tax_rate / 100, 2);
    BEGIN
      INSERT INTO public.folio_lines (organization_id, branch_id, folio_id, reservation_id, line_type,
        category, source_module, description, operational_date, quantity, unit_price,
        gross_amount, tax_amount, net_amount, posted_by)
      VALUES (_org, _r.branch_id, _r.folio_id, _r.reservation_id, 'charge', 'accommodation', 'pms',
        'Accommodation — room ' || COALESCE(_r.room_number,'') || ' · ' || _operational_date::text,
        _operational_date, 1, _r.nightly_rate, _r.nightly_rate, _tax, _r.nightly_rate + _tax, auth.uid())
      RETURNING id INTO _line;
      UPDATE public.folios SET total_charges = total_charges + _r.nightly_rate,
        total_taxes = total_taxes + _tax, balance = balance + _r.nightly_rate + _tax, updated_at=now()
      WHERE id=_r.folio_id;
      PERFORM public.pkg_allocate_folio_line(_line, 'night-audit');
      _n := _n + 1;
    EXCEPTION WHEN unique_violation THEN
      NULL;
    END;
  END LOOP;
  RETURN _n;
END; $$;
