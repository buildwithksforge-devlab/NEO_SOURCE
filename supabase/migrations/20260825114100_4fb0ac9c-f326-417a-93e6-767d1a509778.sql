-- 1. Approval policy change audit -------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_audit_approval_rule_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row public.approval_rules := coalesce(NEW, OLD);
  _snapshot jsonb;
BEGIN
  _snapshot := to_jsonb(_row) - 'created_at' - 'updated_at';
  INSERT INTO public.audit_logs (organization_id, branch_id, department_id, user_id, user_name,
                                 action, module, record_id, previous_value, new_value)
  VALUES (
    _row.organization_id, _row.branch_id, _row.department_id, auth.uid(),
    coalesce((SELECT full_name FROM public.profiles WHERE id = auth.uid()), 'system'),
    CASE TG_OP WHEN 'INSERT' THEN 'administration.approvals.policy.created'
               WHEN 'UPDATE' THEN 'administration.approvals.policy.updated'
               ELSE 'administration.approvals.policy.removed' END,
    'administration', _row.id::text,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) - 'created_at' - 'updated_at' END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE _snapshot END);
  RETURN _row;
END;
$$;

REVOKE ALL ON FUNCTION public.neo_audit_approval_rule_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_approval_rules_audit ON public.approval_rules;
CREATE TRIGGER trg_approval_rules_audit
AFTER INSERT OR UPDATE OR DELETE ON public.approval_rules
FOR EACH ROW EXECUTE FUNCTION public.neo_audit_approval_rule_change();

-- 2. Baseline approval type catalogue for any organisation -------------------
CREATE OR REPLACE FUNCTION public.neo_approval_ensure_types()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _org uuid := public.current_org_id();
  _created int := 0;
  _t record;
BEGIN
  IF _org IS NULL THEN RETURN 0; END IF;
  FOR _t IN
    SELECT * FROM (VALUES
      ('discount', 'Discount'),
      ('bill-void', 'Bill void request'),
      ('bill-adjustment', 'Bill adjustment'),
      ('complimentary-meal', 'Complimentary meal'),
      ('complimentary-room', 'Complimentary room'),
      ('refund', 'Refund approval'),
      ('payment-reversal', 'Payment reversal'),
      ('write-off', 'Write-off approval'),
      ('cash-variance', 'Cash variance review'),
      ('rate-override', 'Rate override'),
      ('price-change', 'Manual price change'),
      ('credit-account', 'Credit account approval'),
      ('purchase-request', 'Purchase request'),
      ('procurement-approval', 'Procurement approval'),
      ('stock-adjustment', 'Stock adjustment'),
      ('stock-write-off', 'Stock write-off'),
      ('expense', 'Expense approval'),
      ('till-reopen', 'Till reopening'),
      ('event-quotation', 'Event quotation'),
      ('event-pricing-exception', 'Event pricing exception')
    ) AS v(key, name)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM public.approval_types t
                    WHERE t.organization_id = _org AND t.key = _t.key) THEN
      INSERT INTO public.approval_types (organization_id, key, name, levels, active)
      VALUES (_org, _t.key, _t.name, 1, true);
      _created := _created + 1;
    END IF;
  END LOOP;
  RETURN _created;
END;
$$;

REVOKE ALL ON FUNCTION public.neo_approval_ensure_types() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_approval_ensure_types() TO authenticated;

-- 3. Baseline authority seeding now guarantees the type catalogue first ------
CREATE OR REPLACE FUNCTION public.neo_approval_seed_authority(_commit boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _org uuid := public.current_org_id();
  _created int := 0; _skipped int := 0; _types int := 0;
  _t record; _l record; _role uuid;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'No organisation context'; END IF;
  IF NOT (public.is_org_admin() OR public.has_permission('administration','approvals','edit')) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  IF _commit THEN
    _types := public.neo_approval_ensure_types();
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

  IF _commit AND (_created > 0 OR _types > 0) THEN
    INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
    VALUES (_org, auth.uid(),
            coalesce((SELECT full_name FROM public.profiles WHERE id = auth.uid()), 'system'),
            'administration.approvals.seed_authority', 'administration', NULL,
            jsonb_build_object('rules_created', _created, 'types_created', _types));
  END IF;

  RETURN jsonb_build_object('ok', true, 'committed', _commit,
    'rules', _created, 'types', _types, 'types_already_configured', _skipped);
END;
$$;

REVOKE ALL ON FUNCTION public.neo_approval_seed_authority(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_approval_seed_authority(boolean) TO authenticated;

-- 4. Standalone settled POS sales post to Finance without a folio ------------
CREATE OR REPLACE FUNCTION public.neo_pos_settlement_evidence(_order uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.pos_payments p
     WHERE p.order_id = _order
       AND p.status IN ('confirmed','paid','completed','captured','settled')
       AND coalesce(p.amount,0) > 0);
$$;

REVOKE ALL ON FUNCTION public.neo_pos_settlement_evidence(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_pos_settlement_evidence(uuid) TO authenticated;