-- 1. Department managers may read the Staff Board (view/export/print only).
INSERT INTO public.role_feature_templates (role_key, module, feature, action)
SELECT k, 'reports', 'overview', a
FROM unnest(ARRAY[
  'front-office-manager','restaurant-manager','bar-manager','head-chef','head-pastry-chef',
  'housekeeping-manager','laundry-manager','maintenance-manager','sales-and-events-manager',
  'procurement-manager','human-resources-manager','delivery-manager'
]) k, unnest(ARRAY['view','export','print']) a
ON CONFLICT (role_key, module, feature, action) DO NOTHING;

-- Additive compile into live roles; never revokes an existing grant.
INSERT INTO public.role_permissions (organization_id, role_id, permission_id, source)
SELECT r.organization_id, r.id, p.id, 'template'
FROM public.roles r
JOIN public.permissions p
  ON p.module = 'reports' AND p.feature = 'overview' AND p.action IN ('view','export','print')
WHERE coalesce(r.active, true)
  AND public.neo_resolve_role_template_key(r.normalized_role_key, r.name) IN (
    'front-office-manager','restaurant-manager','bar-manager','head-chef','head-pastry-chef',
    'housekeeping-manager','laundry-manager','maintenance-manager','sales-and-events-manager',
    'procurement-manager','human-resources-manager','delivery-manager')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- 2. A role nobody holds cannot approve anything.
CREATE OR REPLACE FUNCTION public.neo_role_is_staffed(_role uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.user_roles ur
      JOIN public.profiles pr ON pr.id = ur.user_id
     WHERE ur.role_id = _role
       AND coalesce(pr.account_status, 'active') = 'active'
  )
$$;
REVOKE ALL ON FUNCTION public.neo_role_is_staffed(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_role_is_staffed(uuid) TO authenticated, service_role;

-- 3. Routing: skip unstaffed departmental approvers, then fall back to the
--    Operations Manager, who carries departmental authority when a workspace
--    has no manager for that department. The departmental roles, their
--    permissions and their rules remain untouched.
CREATE OR REPLACE FUNCTION public.neo_approval_route(_type text, _amount numeric DEFAULT NULL::numeric, _percent numeric DEFAULT NULL::numeric, _branch uuid DEFAULT NULL::uuid, _department uuid DEFAULT NULL::uuid, _requester uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := public.current_org_id();
  v_requester uuid := COALESCE(_requester, auth.uid());
  v_rule record;
  v_first_level integer;
  v_escalated boolean := false;
  v_unstaffed boolean := false;
  v_ops uuid;
BEGIN
  IF v_org IS NULL THEN
    RETURN jsonb_build_object('status','unconfigured','message','No workspace context');
  END IF;

  FOR v_rule IN
    SELECT * FROM public.approval_rules r
    WHERE r.organization_id = v_org
      AND r.active
      AND r.approval_type = _type
      AND (r.branch_id IS NULL OR _branch IS NULL OR r.branch_id = _branch)
      AND (r.department_id IS NULL OR _department IS NULL OR r.department_id = _department)
    ORDER BY r.level, r.max_amount NULLS LAST, r.max_percent NULLS LAST
  LOOP
    IF v_first_level IS NULL THEN v_first_level := v_rule.level; END IF;

    IF (v_rule.max_amount IS NOT NULL AND _amount IS NOT NULL AND _amount > v_rule.max_amount)
       OR (v_rule.max_percent IS NOT NULL AND _percent IS NOT NULL AND _percent > v_rule.max_percent) THEN
      v_escalated := true;
      CONTINUE;
    END IF;

    IF v_rule.approver_user_id IS NOT NULL
       AND v_requester IS NOT NULL
       AND v_rule.approver_user_id = v_requester
       AND NOT v_rule.allow_self_approval THEN
      v_escalated := true;
      CONTINUE;
    END IF;

    -- A role-based rule that nobody holds cannot act on the request.
    IF v_rule.approver_user_id IS NULL
       AND v_rule.approver_role_id IS NOT NULL
       AND NOT public.neo_role_is_staffed(v_rule.approver_role_id) THEN
      v_unstaffed := true;
      CONTINUE;
    END IF;

    RETURN jsonb_build_object(
      'status', CASE WHEN v_escalated THEN 'escalated' ELSE 'ok' END,
      'rule_id', v_rule.id,
      'level', v_rule.level,
      'approver_role_id', v_rule.approver_role_id,
      'approver_user_id', v_rule.approver_user_id,
      'required_approvers', v_rule.required_approvers,
      'max_amount', v_rule.max_amount,
      'max_percent', v_rule.max_percent,
      'message', CASE WHEN v_escalated
        THEN 'Approval limit exceeded — escalated to next authorised approver.'
        ELSE 'Routed to the configured approver.' END
    );
  END LOOP;

  -- Departmental authority falls to the Operations Manager when the department
  -- has no manager staffed in this workspace.
  IF v_unstaffed THEN
    SELECT r.id INTO v_ops
      FROM public.roles r
     WHERE r.organization_id = v_org
       AND coalesce(r.active, true)
       AND public.neo_resolve_role_template_key(r.normalized_role_key, r.name) = 'operations-manager'
       AND public.neo_role_is_staffed(r.id)
     LIMIT 1;

    IF v_ops IS NOT NULL THEN
      RETURN jsonb_build_object(
        'status','delegated',
        'rule_id', NULL,
        'level', COALESCE(v_first_level, 1),
        'approver_role_id', v_ops,
        'approver_user_id', NULL,
        'required_approvers', 1,
        'message','No manager is staffed for this department — routed to the Operations Manager.'
      );
    END IF;

    RETURN jsonb_build_object('status','unstaffed','message',
      'The approver role for this request has nobody assigned. An administrator must staff it or appoint an Operations Manager.');
  END IF;

  IF v_first_level IS NULL THEN
    RETURN jsonb_build_object('status','unconfigured','message',
      'No approval authority is configured for this request type. An administrator must configure it.');
  END IF;

  RETURN jsonb_build_object('status','exhausted','message',
    'Approval limit exceeded and no higher authorised approver is configured.');
END $function$;