CREATE TABLE IF NOT EXISTS public.approval_routing_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  workflow_key text NOT NULL,
  reserved_role_id uuid REFERENCES public.roles(id) ON DELETE SET NULL,
  fallback_role_id uuid REFERENCES public.roles(id) ON DELETE SET NULL,
  fallback_enabled boolean NOT NULL DEFAULT true,
  notes text,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_routing_policies_unique UNIQUE (organization_id, workflow_key)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.approval_routing_policies TO authenticated;
GRANT ALL ON public.approval_routing_policies TO service_role;

ALTER TABLE public.approval_routing_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "routing policies readable in my workspace" ON public.approval_routing_policies;
CREATE POLICY "routing policies readable in my workspace"
  ON public.approval_routing_policies FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "routing policies managed by workspace admins" ON public.approval_routing_policies;
CREATE POLICY "routing policies managed by workspace admins"
  ON public.approval_routing_policies FOR ALL TO authenticated
  USING (organization_id = public.current_org_id() AND public.is_org_admin_for(organization_id))
  WITH CHECK (organization_id = public.current_org_id() AND public.is_org_admin_for(organization_id));

DROP TRIGGER IF EXISTS approval_routing_policies_touch ON public.approval_routing_policies;
CREATE TRIGGER approval_routing_policies_touch
  BEFORE UPDATE ON public.approval_routing_policies
  FOR EACH ROW EXECUTE FUNCTION public.fin_touch_updated_at();

CREATE INDEX IF NOT EXISTS approval_routing_policies_org_idx
  ON public.approval_routing_policies (organization_id, workflow_key) WHERE active;

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
     ORDER BY (r.branch_id IS NOT NULL) DESC, (r.department_id IS NOT NULL) DESC, r.level
  LOOP
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

    RETURN jsonb_build_object('status','ok','rule_id',x.id,'level',x.level,'approver_role_id',x.approver_role_id,'approver_user_id',x.approver_user_id,'required_approvers',x.required_approvers,'message','Routed to the configured approver.');
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

    IF ops IS NOT NULL AND (q IS NULL OR EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.role_id = ops AND ur.organization_id = o AND ur.user_id <> q)) THEN
      RETURN jsonb_build_object('status','delegated','level',1,'approver_role_id',ops,'approver_user_id',NULL,'required_approvers',1,
        'message','Configured approver unavailable or is the person who raised this; routed to the configured fallback approver for this request only.');
    END IF;
    IF self_only THEN
      RETURN jsonb_build_object('status','self_only',
        'message','You raised this request and you are the only person holding that approval authority here. It is held until an independent approver is available or the workspace records a written exception.');
    END IF;
    RETURN jsonb_build_object('status','unstaffed','message','No staffed departmental approver or configured fallback approver is available for this property.');
  END IF;

  RETURN jsonb_build_object('status','unconfigured','message','No approval authority is configured for this request type and scope.');
END $function$;