INSERT INTO public.permissions (module, feature, action, label) VALUES
  ('administration','approvals','view','View the approval inbox'),
  ('administration','approvals','decide','Approve or reject requests')
ON CONFLICT (module, feature, action) DO NOTHING;

INSERT INTO public.role_feature_templates (role_key, module, feature, action) VALUES
  ('owner','administration','approvals','view'),
  ('owner','administration','approvals','decide'),
  ('operations-manager','administration','approvals','view'),
  ('operations-manager','administration','approvals','decide'),
  ('general-manager','administration','approvals','view'),
  ('general-manager','administration','approvals','decide'),
  ('finance-manager','administration','approvals','view'),
  ('procurement-manager','administration','approvals','view'),
  ('human-resources-manager','administration','approvals','view')
ON CONFLICT (role_key, module, feature, action) DO NOTHING;

CREATE OR REPLACE FUNCTION public.neo_approval_decide(
  _request uuid,
  _action text,
  _comment text DEFAULT ''::text,
  _idempotency_key text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE r public.approval_requests; s public.approval_steps; _uid uuid := auth.uid();
        _key text; _next public.approval_steps; _exec jsonb; _authorised boolean;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Authentication required.'; END IF;
  IF lower(coalesce(_action,'')) NOT IN ('approved','rejected') THEN
    RAISE EXCEPTION 'Decision must be approved or rejected.';
  END IF;
  _action := lower(_action);

  SELECT * INTO r FROM public.approval_requests WHERE id = _request FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Approval request not found.'; END IF;
  IF r.organization_id <> public.current_org_id() THEN RAISE EXCEPTION 'Out of scope.'; END IF;
  IF r.status <> 'pending_approval' THEN
    RETURN jsonb_build_object('ok', false, 'status', r.status, 'error', 'This request is no longer awaiting approval.');
  END IF;

  SELECT * INTO s FROM public.approval_steps
   WHERE request_id = r.id AND status = 'active' ORDER BY level LIMIT 1 FOR UPDATE;
  IF s.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No active approval level.');
  END IF;
  IF s.approver_user_id IS NOT NULL AND s.approver_user_id <> _uid THEN
    RAISE EXCEPTION 'This level is assigned to another approver.';
  END IF;

  _authorised := public.has_permission('administration','approvals','decide');

  IF lower(coalesce(r.approval_type,'')) IN ('void','cancel','cancellation','discount','refund','complimentary','rate-override','write-off') THEN
    _authorised := _authorised OR public.can_approve_restricted();
  ELSE
    _authorised := _authorised
      OR public.can_approve_restricted()
      OR (s.approver_user_id = _uid
          AND r.source_module IS NOT NULL
          AND public.has_permission(r.source_module, 'approve'));
  END IF;

  IF NOT _authorised THEN
    RAISE EXCEPTION 'You do not have approval authority.';
  END IF;

  IF r.requester_id = _uid AND NOT r.emergency_override THEN
    RAISE EXCEPTION 'You cannot approve your own request.';
  END IF;

  _key := coalesce(nullif(_idempotency_key,''),
                   'approval:' || r.id::text || ':level:' || s.level::text || ':' || _action);
  BEGIN
    INSERT INTO public.automation_idempotency_keys (organization_id, scope, idempotency_key, result_reference)
    VALUES (r.organization_id, 'approval-decision', _key, r.id::text);
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'status', r.status);
  END;

  INSERT INTO public.approval_actions (organization_id, request_id, actor_id, action, comment, level)
  VALUES (r.organization_id, r.id, _uid, _action, coalesce(_comment,''), s.level);

  UPDATE public.approval_steps
     SET status = _action, decided_at = now(), decided_by = _uid,
         comment = coalesce(_comment,''), updated_at = now()
   WHERE id = s.id;

  UPDATE public.notifications SET status = 'resolved', acted_at = now(), acted_by = _uid
   WHERE source_module = 'approvals' AND source_record_id = r.id AND status = 'open';
  UPDATE public.tasks SET status = 'completed', progress = 100, completed_at = now()
   WHERE organization_id = r.organization_id AND reference = 'APRTASK-' || r.id::text || '-' || s.level::text
     AND status NOT IN ('completed','cancelled');

  IF _action = 'rejected' THEN
    UPDATE public.approval_steps SET status = 'cancelled', updated_at = now()
     WHERE request_id = r.id AND status IN ('waiting','active');
    UPDATE public.approval_requests
       SET status = 'rejected', approver_id = _uid, decided_at = now(), notes = coalesce(_comment,'')
     WHERE id = r.id;
    PERFORM public.neo_notify(r.organization_id, r.requester_id, r.branch_id, 'workflow',
      'Request rejected', coalesce(r.reason,'Your request was rejected.'),
      '/approvals?request=' || r.id::text, 'high', false, 'approvals', r.id, 'approval.rejected',
      'approval:' || r.id::text || ':rejected');
    INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
    VALUES (r.organization_id, _uid, '', 'approval.rejected', 'governance', r.id::text,
      jsonb_build_object('level', s.level, 'status','rejected'), coalesce(_comment,''));
    RETURN jsonb_build_object('ok', true, 'status', 'rejected');
  END IF;

  SELECT * INTO _next FROM public.approval_steps
   WHERE request_id = r.id AND status = 'waiting' ORDER BY level LIMIT 1 FOR UPDATE;

  IF _next.id IS NOT NULL THEN
    UPDATE public.approval_steps SET status = 'active', activated_at = now(), updated_at = now()
     WHERE id = _next.id;
    UPDATE public.approval_requests SET level = _next.level, approver_id = NULL WHERE id = r.id;
    PERFORM public.neo_notify(r.organization_id, _next.approver_user_id, r.branch_id, 'approvals',
      format('Approval required (level %s of %s): %s', _next.level, r.max_level, coalesce(r.approval_type,'request')),
      coalesce(r.reason,'A request is waiting for your decision.'),
      '/approvals?request=' || r.id::text, 'high', true, 'approvals', r.id, 'approval.level_activated',
      'approval:' || r.id::text || ':level:' || _next.level::text);
    INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
    VALUES (r.organization_id, _uid, '', 'approval.level_approved', 'governance', r.id::text,
      jsonb_build_object('level', s.level, 'next_level', _next.level), coalesce(_comment,''));
    RETURN jsonb_build_object('ok', true, 'status', 'pending_approval', 'level', _next.level);
  END IF;

  UPDATE public.approval_requests
     SET status = 'approved_pending_execution', approver_id = _uid, decided_at = now(),
         notes = coalesce(_comment,''), level = s.level
   WHERE id = r.id;

  _exec := public.neo_approval_execute(r.id);

  PERFORM public.neo_notify(r.organization_id, r.requester_id, r.branch_id, 'workflow',
    CASE WHEN (_exec->>'ok')::boolean THEN 'Request approved' ELSE 'Approved but execution failed' END,
    coalesce(r.reason,''), '/approvals?request=' || r.id::text,
    CASE WHEN (_exec->>'ok')::boolean THEN 'normal' ELSE 'high' END, false,
    'approvals', r.id, 'approval.finalised', 'approval:' || r.id::text || ':finalised');

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
  VALUES (r.organization_id, _uid, '', 'approval.final_approved', 'governance', r.id::text,
    jsonb_build_object('level', s.level, 'execution', _exec), coalesce(_comment,''));

  RETURN jsonb_build_object('ok', true,
    'status', CASE WHEN (_exec->>'ok')::boolean THEN 'completed' ELSE 'execution_failed' END,
    'execution', _exec);
END
$fn$;

REVOKE ALL ON FUNCTION public.neo_approval_decide(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.neo_approval_decide(uuid, text, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.neo_approval_decide(uuid, text, text, text) TO authenticated;