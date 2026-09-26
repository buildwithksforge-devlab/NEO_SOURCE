ALTER TABLE public.approval_requests
  ADD COLUMN IF NOT EXISTS requested_percent numeric,
  ADD COLUMN IF NOT EXISTS escalated_to_owner boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS returned_at timestamptz;

-- Which request types the caller may approve, and up to what limit.
CREATE OR REPLACE FUNCTION public.neo_my_approval_authority()
RETURNS TABLE(approval_type text, level integer, max_amount numeric, max_percent numeric,
              escalate_above_limit boolean, unlimited boolean)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT r.approval_type,
         min(r.level),
         max(r.max_amount),
         max(r.max_percent),
         bool_or(coalesce(r.escalate_above_limit, true)),
         bool_or(r.max_amount IS NULL AND r.max_percent IS NULL) OR public.is_org_admin()
    FROM public.approval_rules r
   WHERE r.organization_id = public.current_org_id()
     AND r.active
     AND (
       r.approver_user_id = auth.uid()
       OR r.approver_role_id IN (
         SELECT ur.role_id FROM public.user_roles ur WHERE ur.user_id = auth.uid()
       )
     )
   GROUP BY r.approval_type
$$;

REVOKE ALL ON FUNCTION public.neo_my_approval_authority() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_my_approval_authority() TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_approval_decide(_request uuid, _action text, _comment text DEFAULT ''::text, _idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE r public.approval_requests; s public.approval_steps; _uid uuid := auth.uid();
        _key text; _next public.approval_steps; _exec jsonb; _authorised boolean;
        _lim record; _owner_role uuid; _over boolean := false; _over_reason text;
        _owner uuid;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Authentication required.'; END IF;
  IF lower(coalesce(_action,'')) NOT IN ('approved','rejected','returned','escalated') THEN
    RAISE EXCEPTION 'Decision must be approved, rejected, returned or escalated.';
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

  -- Configured approval limit. Never hard-coded: it comes from approval_rules,
  -- which only the Owner / System Administrator may edit.
  IF _action = 'approved' AND NOT public.is_org_admin() THEN
    SELECT * INTO _lim FROM public.neo_my_approval_authority() a
     WHERE a.approval_type = r.approval_type;
    IF _lim.approval_type IS NOT NULL AND NOT coalesce(_lim.unlimited, false) THEN
      IF _lim.max_amount IS NOT NULL AND r.amount IS NOT NULL AND r.amount > _lim.max_amount THEN
        _over := true;
        _over_reason := format('Amount %s exceeds your approval limit of %s.', r.amount, _lim.max_amount);
      ELSIF _lim.max_percent IS NOT NULL AND r.requested_percent IS NOT NULL
            AND r.requested_percent > _lim.max_percent THEN
        _over := true;
        _over_reason := format('%s%% exceeds your approval limit of %s%%.', r.requested_percent, _lim.max_percent);
      END IF;
    END IF;
    IF _over THEN
      IF coalesce(_lim.escalate_above_limit, true) THEN
        _action := 'escalated';
        _comment := trim(coalesce(_comment,'') || ' ' || _over_reason);
      ELSE
        RAISE EXCEPTION '%', _over_reason;
      END IF;
    END IF;
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

  IF _action = 'returned' THEN
    UPDATE public.approval_steps SET status = 'cancelled', updated_at = now()
     WHERE request_id = r.id AND status IN ('waiting','active');
    UPDATE public.approval_requests
       SET status = 'returned_for_correction', approver_id = _uid, decided_at = now(),
           returned_at = now(), notes = coalesce(_comment,'')
     WHERE id = r.id;
    PERFORM public.neo_notify(r.organization_id, r.requester_id, r.branch_id, 'workflow',
      'Request returned for correction',
      coalesce(nullif(_comment,''), 'Your request was returned for correction.'),
      '/approvals?request=' || r.id::text, 'high', true, 'approvals', r.id, 'approval.returned',
      'approval:' || r.id::text || ':returned');
    INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
    VALUES (r.organization_id, _uid, '', 'approval.returned', 'governance', r.id::text,
      jsonb_build_object('level', s.level, 'status','returned_for_correction'), coalesce(_comment,''));
    RETURN jsonb_build_object('ok', true, 'status', 'returned_for_correction');
  END IF;

  IF _action = 'escalated' THEN
    UPDATE public.approval_steps SET status = 'cancelled', updated_at = now()
     WHERE request_id = r.id AND status = 'waiting';

    SELECT ro.id INTO _owner_role FROM public.roles ro
     WHERE ro.organization_id = r.organization_id AND lower(ro.name) = 'owner'
     LIMIT 1;

    INSERT INTO public.approval_steps (organization_id, request_id, level, status, approver_role_id, activated_at)
    VALUES (r.organization_id, r.id, coalesce(r.max_level, s.level) + 1, 'active', _owner_role, now());

    UPDATE public.approval_requests
       SET level = coalesce(max_level, s.level) + 1,
           max_level = coalesce(max_level, s.level) + 1,
           approver_id = NULL,
           escalated_to_owner = true,
           notes = coalesce(_comment,'')
     WHERE id = r.id;

    FOR _owner IN
      SELECT ur.user_id FROM public.user_roles ur
       WHERE ur.role_id = _owner_role AND ur.user_id IS NOT NULL
    LOOP
      PERFORM public.neo_notify(r.organization_id, _owner, r.branch_id, 'approvals',
        format('Escalated for Owner decision: %s', coalesce(r.approval_type,'request')),
        coalesce(nullif(_comment,''), coalesce(r.reason,'A request exceeds the approver''s authority.')),
        '/approvals?request=' || r.id::text, 'high', true, 'approvals', r.id, 'approval.escalated',
        'approval:' || r.id::text || ':escalated:' || _owner::text);
    END LOOP;

    PERFORM public.neo_notify(r.organization_id, r.requester_id, r.branch_id, 'workflow',
      'Request escalated to the Owner',
      coalesce(nullif(_comment,''), 'Your request exceeds the approver''s authority and went to the Owner.'),
      '/approvals?request=' || r.id::text, 'normal', false, 'approvals', r.id, 'approval.escalated.requester',
      'approval:' || r.id::text || ':escalated:requester');

    INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
    VALUES (r.organization_id, _uid, '', 'approval.escalated', 'governance', r.id::text,
      jsonb_build_object('from_level', s.level, 'escalated_to', 'owner'), coalesce(_comment,''));

    RETURN jsonb_build_object('ok', true, 'status', 'escalated', 'over_limit', _over);
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
$function$;

REVOKE ALL ON FUNCTION public.neo_approval_decide(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_approval_decide(uuid, text, text, text) TO authenticated;