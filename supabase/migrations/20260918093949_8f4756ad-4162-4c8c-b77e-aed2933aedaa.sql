
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

  reserved := lower(coalesce(_type,'')) = ANY(ARRAY['void','cancel','cancellation','discount','refund','complimentary','rate-override','write-off','payment-reversal','till-reopen','period-reopen']);

  IF reserved THEN
    SELECT id INTO own FROM public.roles
     WHERE organization_id=o AND coalesce(active,true)
       AND public.neo_resolve_role_template_key(normalized_role_key,name)='owner'
       AND public.neo_role_is_staffed(id,_branch)
     LIMIT 1;
    IF own IS NULL THEN
      RETURN jsonb_build_object('status','owner_unstaffed','message','This Owner-reserved action has no staffed Owner approver.');
    END IF;
    IF NOT exception_active AND q IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.role_id = own AND ur.organization_id = o AND ur.user_id <> q) THEN
      RETURN jsonb_build_object('status','self_only','level',1,'approver_role_id',own,'approver_user_id',NULL,
        'required_approvers',1,
        'message','You raised this Owner-reserved request and you are the only Owner in this workspace. It is held for an independent approver.');
    END IF;
    RETURN jsonb_build_object('status','owner_reserved','level',1,'approver_role_id',own,'approver_user_id',NULL,'required_approvers',1,'message','Routed to Owner under restricted-action policy.');
  END IF;

  FOR x IN
    SELECT * FROM public.approval_rules r
     WHERE r.organization_id=o AND r.active AND r.approval_type=_type
       AND (r.branch_id IS NULL OR r.branch_id=_branch)
       AND (r.department_id IS NULL OR r.department_id=_department)
     ORDER BY (r.branch_id IS NOT NULL) DESC, (r.department_id IS NOT NULL) DESC, r.level
  LOOP
    IF (x.max_amount IS NOT NULL AND _amount IS NOT NULL AND _amount > x.max_amount)
       OR (x.max_percent IS NOT NULL AND _percent IS NOT NULL AND _percent > x.max_percent) THEN
      CONTINUE;
    END IF;

    -- Named approver is the requester: never route a record back to its creator.
    IF x.approver_user_id = q AND NOT (x.allow_self_approval AND exception_active) THEN
      self_only := true; CONTINUE;
    END IF;

    IF x.approver_user_id IS NULL AND x.approver_role_id IS NOT NULL THEN
      IF NOT public.neo_role_is_staffed(x.approver_role_id,_branch) THEN
        unstaffed := true; CONTINUE;
      END IF;
      -- The requester's own role may approve for others, but not this record.
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

    RETURN jsonb_build_object('status','ok','rule_id',x.id,'level',x.level,'approver_role_id',x.approver_role_id,'approver_user_id',x.approver_user_id,'required_approvers',x.required_approvers,'message','Routed to the configured approver.');
  END LOOP;

  IF unstaffed OR self_only THEN
    SELECT id INTO ops FROM public.roles
     WHERE organization_id=o AND coalesce(active,true)
       AND public.neo_resolve_role_template_key(normalized_role_key,name)='operations-manager'
       AND public.neo_role_is_staffed(id,_branch)
     LIMIT 1;
    IF ops IS NOT NULL AND (q IS NULL OR EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.role_id = ops AND ur.organization_id = o AND ur.user_id <> q)) THEN
      RETURN jsonb_build_object('status','delegated','level',1,'approver_role_id',ops,'approver_user_id',NULL,'required_approvers',1,
        'message','Configured approver unavailable or is the person who raised this; routed to Operations Manager for this request only.');
    END IF;
    IF self_only THEN
      RETURN jsonb_build_object('status','self_only',
        'message','You raised this request and you are the only person holding that approval authority here. It is held until an independent approver is available or the workspace records a written exception.');
    END IF;
    RETURN jsonb_build_object('status','unstaffed','message','No staffed departmental approver or Operations Manager is available for this property.');
  END IF;

  RETURN jsonb_build_object('status','unconfigured','message','No approval authority is configured for this request type and scope.');
END $function$;
