ALTER TABLE public.approval_rules
  ADD COLUMN IF NOT EXISTS currency text,
  ADD COLUMN IF NOT EXISTS effective_from date,
  ADD COLUMN IF NOT EXISTS effective_to date,
  ADD COLUMN IF NOT EXISTS require_rejection_reason boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS require_override_reason boolean NOT NULL DEFAULT true;

CREATE OR REPLACE FUNCTION public.neo_approval_rule_validate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.approver_role_id IS NULL AND NEW.approver_user_id IS NULL THEN
    RAISE EXCEPTION 'An approval rule needs an approver role or a named approver.';
  END IF;

  IF NEW.approver_role_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.roles r
     WHERE r.id = NEW.approver_role_id
       AND r.organization_id = NEW.organization_id
       AND COALESCE(r.active, true)
  ) THEN
    RAISE EXCEPTION 'The approver role is inactive or belongs to another workspace.';
  END IF;

  IF NEW.branch_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.branches b
     WHERE b.id = NEW.branch_id AND b.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'The property belongs to another workspace.';
  END IF;

  IF NEW.min_amount IS NOT NULL AND NEW.min_amount < 0 THEN
    RAISE EXCEPTION 'The minimum amount cannot be negative.';
  END IF;

  IF NEW.min_amount IS NOT NULL AND NEW.max_amount IS NOT NULL
     AND NEW.max_amount < NEW.min_amount THEN
    RAISE EXCEPTION 'The maximum amount cannot be below the minimum amount.';
  END IF;

  IF NEW.effective_from IS NOT NULL AND NEW.effective_to IS NOT NULL
     AND NEW.effective_to < NEW.effective_from THEN
    RAISE EXCEPTION 'The end date cannot be before the start date.';
  END IF;

  IF NEW.currency IS NOT NULL THEN
    NEW.currency := upper(trim(NEW.currency));
    IF NEW.currency !~ '^[A-Z]{3}$' THEN
      RAISE EXCEPTION 'Use a three-letter currency code, for example KES.';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.approval_rules r
     WHERE r.organization_id = NEW.organization_id
       AND r.approval_type = NEW.approval_type
       AND r.id IS DISTINCT FROM NEW.id
       AND r.level = NEW.level
       AND r.branch_id IS NOT DISTINCT FROM NEW.branch_id
       AND r.department_id IS NOT DISTINCT FROM NEW.department_id
       AND r.approver_role_id IS NOT DISTINCT FROM NEW.approver_role_id
       AND r.approver_user_id IS NOT DISTINCT FROM NEW.approver_user_id
       AND r.min_amount IS NOT DISTINCT FROM NEW.min_amount
       AND r.max_amount IS NOT DISTINCT FROM NEW.max_amount
  ) THEN
    RAISE EXCEPTION 'An identical approval rule already exists for this transaction type.';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_approval_rule_validate ON public.approval_rules;
CREATE TRIGGER trg_approval_rule_validate
BEFORE INSERT OR UPDATE ON public.approval_rules
FOR EACH ROW EXECUTE FUNCTION public.neo_approval_rule_validate();

CREATE OR REPLACE FUNCTION public.neo_approval_ensure_types()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
      ('purchase-order', 'Purchase order / LPO'),
      ('procurement-variance', 'Procurement variance / exception'),
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
$function$;

CREATE OR REPLACE FUNCTION public.neo_approval_route(_type text, _amount numeric DEFAULT NULL::numeric, _percent numeric DEFAULT NULL::numeric, _branch uuid DEFAULT NULL::uuid, _department uuid DEFAULT NULL::uuid, _requester uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  o uuid := public.current_org_id();
  q uuid := coalesce(_requester, auth.uid());
  x record; ops uuid; own uuid;
  pol record;
  unstaffed boolean := false;
  self_only boolean := false;
  reserved boolean;
  exception_active boolean;
BEGIN
  IF o IS NULL THEN RETURN jsonb_build_object('status','unconfigured','message','No workspace context'); END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.self_approval_exceptions e
    WHERE e.organization_id = o AND e.workflow_key = _type AND e.active
      AND e.effective_from <= current_date
      AND (e.effective_to IS NULL OR e.effective_to >= current_date)
  ) INTO exception_active;

  SELECT * INTO pol FROM public.approval_routing_policies p
   WHERE p.organization_id = o AND p.workflow_key = _type AND p.active
   LIMIT 1;

  IF pol.id IS NOT NULL THEN
    reserved := pol.reserved_role_id IS NOT NULL;
  ELSE
    reserved := lower(coalesce(_type,'')) = ANY(ARRAY['void','cancel','cancellation','discount','refund','complimentary','rate-override','write-off','payment-reversal','till-reopen','period-reopen']);
  END IF;

  IF reserved THEN
    IF pol.id IS NOT NULL THEN
      SELECT id INTO own FROM public.roles
       WHERE id = pol.reserved_role_id AND organization_id = o AND coalesce(active,true)
         AND public.neo_role_is_staffed(id,_branch)
       LIMIT 1;
    ELSE
      SELECT id INTO own FROM public.roles
       WHERE organization_id=o AND coalesce(active,true)
         AND public.neo_resolve_role_template_key(normalized_role_key,name)='owner'
         AND public.neo_role_is_staffed(id,_branch)
       LIMIT 1;
    END IF;
    IF own IS NULL THEN
      RETURN jsonb_build_object('status','owner_unstaffed','message','This reserved action has no staffed approver in the configured reserved role.');
    END IF;
    IF NOT exception_active AND q IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.role_id = own AND ur.organization_id = o AND ur.user_id <> q) THEN
      RETURN jsonb_build_object('status','self_only','level',1,'approver_role_id',own,'approver_user_id',NULL,
        'required_approvers',1,
        'message','You raised this reserved request and you are the only holder of the reserved approval role. It is held for an independent approver.');
    END IF;
    RETURN jsonb_build_object('status','owner_reserved','level',1,'approver_role_id',own,'approver_user_id',NULL,'required_approvers',1,'message','Routed to the configured reserved approver under restricted-action policy.');
  END IF;

  FOR x IN
    SELECT * FROM public.approval_rules r
     WHERE r.organization_id=o AND r.active AND r.approval_type=_type
       AND (r.branch_id IS NULL OR r.branch_id=_branch)
       AND (r.department_id IS NULL OR r.department_id=_department)
       AND (r.effective_from IS NULL OR r.effective_from <= current_date)
       AND (r.effective_to IS NULL OR r.effective_to >= current_date)
     ORDER BY (r.branch_id IS NOT NULL) DESC, (r.department_id IS NOT NULL) DESC, r.level
  LOOP
    IF (x.min_amount IS NOT NULL AND _amount IS NOT NULL AND _amount < x.min_amount) THEN
      CONTINUE;
    END IF;

    IF (x.max_amount IS NOT NULL AND _amount IS NOT NULL AND _amount > x.max_amount)
       OR (x.max_percent IS NOT NULL AND _percent IS NOT NULL AND _percent > x.max_percent) THEN
      CONTINUE;
    END IF;

    IF x.approver_user_id = q AND NOT (x.allow_self_approval AND exception_active) THEN
      self_only := true; CONTINUE;
    END IF;

    IF x.approver_user_id IS NULL AND x.approver_role_id IS NOT NULL THEN
      IF NOT public.neo_role_is_staffed(x.approver_role_id,_branch) THEN
        unstaffed := true; CONTINUE;
      END IF;
      IF q IS NOT NULL AND NOT (x.allow_self_approval AND exception_active)
         AND NOT EXISTS (
           SELECT 1 FROM public.user_roles ur
            WHERE ur.role_id = x.approver_role_id AND ur.organization_id = o AND ur.user_id <> q)
         AND EXISTS (
           SELECT 1 FROM public.user_roles ur
            WHERE ur.role_id = x.approver_role_id AND ur.organization_id = o AND ur.user_id = q) THEN
        self_only := true; CONTINUE;
      END IF;
    END IF;

    RETURN jsonb_build_object('status','ok','rule_id',x.id,'level',x.level,'approver_role_id',x.approver_role_id,
      'approver_user_id',x.approver_user_id,'required_approvers',x.required_approvers,
      'currency',x.currency,
      'require_rejection_reason',x.require_rejection_reason,
      'require_override_reason',x.require_override_reason,
      'message','Routed to the configured approver.');
  END LOOP;

  IF unstaffed OR self_only THEN
    IF pol.id IS NOT NULL THEN
      IF pol.fallback_enabled AND pol.fallback_role_id IS NOT NULL THEN
        SELECT id INTO ops FROM public.roles
         WHERE id = pol.fallback_role_id AND organization_id = o AND coalesce(active,true)
           AND public.neo_role_is_staffed(id,_branch)
         LIMIT 1;
      ELSE
        ops := NULL;
      END IF;
    ELSE
      SELECT id INTO ops FROM public.roles
       WHERE organization_id=o AND coalesce(active,true)
         AND public.neo_resolve_role_template_key(normalized_role_key,name)='operations-manager'
         AND public.neo_role_is_staffed(id,_branch)
       LIMIT 1;
    END IF;

    IF ops IS NOT NULL THEN
      RETURN jsonb_build_object('status','delegated','level',99,'approver_role_id',ops,'approver_user_id',NULL,'required_approvers',1,
        'message','The configured approver is unavailable or raised this request, so it is routed to the configured fallback approver.');
    END IF;

    IF self_only THEN
      RETURN jsonb_build_object('status','self_only',
        'message','You raised this request and you are the only configured approver. It is held for an independent approver.');
    END IF;

    RETURN jsonb_build_object('status','unstaffed',
      'message','No configured approver for this amount is currently staffed at this property.');
  END IF;

  RETURN jsonb_build_object('status','unconfigured',
    'message','No approval authority is configured for this transaction type and amount.');
END;
$function$;