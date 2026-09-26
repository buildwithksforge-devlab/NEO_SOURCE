
-- ============ 1. SCHEMA ============
ALTER TABLE public.approval_requests
  ADD COLUMN IF NOT EXISTS source_module text,
  ADD COLUMN IF NOT EXISTS source_record_id uuid,
  ADD COLUMN IF NOT EXISTS execution_status text NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS execution_error text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS executed_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

CREATE TABLE IF NOT EXISTS public.approval_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES public.approval_requests(id) ON DELETE CASCADE,
  level integer NOT NULL,
  status text NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting','active','approved','rejected','skipped','cancelled')),
  approver_user_id uuid,
  approver_role_id uuid,
  rule_id uuid,
  activated_at timestamptz,
  decided_at timestamptz,
  decided_by uuid,
  comment text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, level)
);
CREATE INDEX IF NOT EXISTS approval_steps_active_idx ON public.approval_steps (organization_id, status);

CREATE TABLE IF NOT EXISTS public.approval_execution_failures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES public.approval_requests(id) ON DELETE CASCADE,
  source_module text,
  source_record_id uuid,
  error_message text NOT NULL DEFAULT '',
  retry_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','retrying','resolved','abandoned')),
  first_failed_at timestamptz NOT NULL DEFAULT now(),
  last_failed_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.approval_steps TO authenticated;
GRANT ALL ON public.approval_steps TO service_role;
GRANT SELECT ON public.approval_execution_failures TO authenticated;
GRANT ALL ON public.approval_execution_failures TO service_role;

ALTER TABLE public.approval_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_execution_failures ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "approval steps tenant read" ON public.approval_steps;
CREATE POLICY "approval steps tenant read" ON public.approval_steps
  FOR SELECT TO authenticated USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "approval failures tenant read" ON public.approval_execution_failures;
CREATE POLICY "approval failures tenant read" ON public.approval_execution_failures
  FOR SELECT TO authenticated USING (organization_id = public.current_org_id());

-- ============ 2. STATUS NORMALISATION ============
CREATE OR REPLACE FUNCTION public.neo_approval_normalize_status()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.status := CASE lower(coalesce(NEW.status,'pending_approval'))
    WHEN 'pending' THEN 'pending_approval'
    WHEN 'approved' THEN 'approved_pending_execution'
    WHEN 'complete' THEN 'completed'
    WHEN 'declined' THEN 'rejected'
    WHEN 'void' THEN 'cancelled'
    ELSE lower(NEW.status)
  END;
  IF NEW.status NOT IN ('draft','pending_approval','approved_pending_execution','executing',
                        'completed','rejected','cancelled','execution_failed') THEN
    RAISE EXCEPTION 'Unknown approval status %', NEW.status;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_approval_normalize_status ON public.approval_requests;
CREATE TRIGGER trg_approval_normalize_status
  BEFORE INSERT OR UPDATE ON public.approval_requests
  FOR EACH ROW EXECUTE FUNCTION public.neo_approval_normalize_status();

-- migrate existing rows onto the model
UPDATE public.approval_requests SET status = 'pending_approval' WHERE status = 'pending';
UPDATE public.approval_requests SET status = 'completed', completed_at = coalesce(decided_at, updated_at),
       execution_status = 'not_required' WHERE status = 'approved';

-- ============ 3. STEP SEEDING ============
CREATE OR REPLACE FUNCTION public.neo_approval_seed_steps()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i integer;
BEGIN
  FOR i IN 1..greatest(coalesce(NEW.max_level,1),1) LOOP
    INSERT INTO public.approval_steps (organization_id, request_id, level, status, activated_at,
      approver_user_id)
    VALUES (NEW.organization_id, NEW.id, i,
      CASE WHEN i = 1 AND NEW.status = 'pending_approval' THEN 'active' ELSE 'waiting' END,
      CASE WHEN i = 1 AND NEW.status = 'pending_approval' THEN now() ELSE NULL END,
      CASE WHEN i = 1 THEN NEW.approver_id ELSE NULL END)
    ON CONFLICT (request_id, level) DO NOTHING;
  END LOOP;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_approval_seed_steps ON public.approval_requests;
CREATE TRIGGER trg_approval_seed_steps
  AFTER INSERT ON public.approval_requests
  FOR EACH ROW EXECUTE FUNCTION public.neo_approval_seed_steps();

-- backfill steps for existing requests
INSERT INTO public.approval_steps (organization_id, request_id, level, status, activated_at)
SELECT r.organization_id, r.id, g.lvl,
       CASE WHEN g.lvl = r.level AND r.status = 'pending_approval' THEN 'active'
            WHEN g.lvl < r.level THEN 'approved'
            WHEN r.status IN ('completed','approved_pending_execution') THEN 'approved'
            WHEN r.status = 'rejected' AND g.lvl = r.level THEN 'rejected'
            WHEN r.status IN ('rejected','cancelled') THEN 'cancelled'
            ELSE 'waiting' END,
       CASE WHEN g.lvl <= r.level THEN r.created_at ELSE NULL END
FROM public.approval_requests r
CROSS JOIN LATERAL generate_series(1, greatest(coalesce(r.max_level,1),1)) AS g(lvl)
ON CONFLICT (request_id, level) DO NOTHING;

-- ============ 4. EXECUTION ============
CREATE OR REPLACE FUNCTION public.neo_approval_execute(_request uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.approval_requests; _err text; _did boolean := false;
BEGIN
  SELECT * INTO r FROM public.approval_requests WHERE id = _request FOR UPDATE;
  IF r.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not found'); END IF;
  IF r.execution_status = 'succeeded' THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true);
  END IF;
  IF r.status NOT IN ('approved_pending_execution','execution_failed','executing') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'request is not awaiting execution');
  END IF;

  UPDATE public.approval_requests SET status = 'executing', execution_status = 'running' WHERE id = r.id;

  BEGIN
    -- purchase requests carry an explicit back-reference
    UPDATE public.purchase_requests
       SET status = 'approved', approved_by = r.approver_id, approved_at = now()
     WHERE approval_request_id = r.id AND status <> 'approved';
    IF FOUND THEN _did := true; END IF;

    IF r.source_module = 'pos' AND r.source_record_id IS NOT NULL AND r.approval_type = 'void' THEN
      UPDATE public.pos_orders SET status = 'voided' WHERE id = r.source_record_id AND status <> 'voided';
      IF FOUND THEN _did := true; END IF;
    END IF;

    UPDATE public.approval_requests
       SET status = 'completed',
           execution_status = CASE WHEN _did THEN 'succeeded' ELSE 'not_required' END,
           execution_error = '', executed_at = now(), completed_at = now()
     WHERE id = r.id;
    RETURN jsonb_build_object('ok', true, 'executed', _did);
  EXCEPTION WHEN OTHERS THEN
    _err := SQLERRM;
    UPDATE public.approval_requests
       SET status = 'execution_failed', execution_status = 'failed', execution_error = _err
     WHERE id = r.id;
    INSERT INTO public.approval_execution_failures (organization_id, request_id, source_module,
      source_record_id, error_message)
    VALUES (r.organization_id, r.id, r.source_module, r.source_record_id, _err);
    RETURN jsonb_build_object('ok', false, 'error', _err);
  END;
END $$;

-- ============ 5. TRANSACTIONAL DECISION ============
CREATE OR REPLACE FUNCTION public.neo_approval_decide(
  _request uuid, _action text, _comment text DEFAULT '', _idempotency_key text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.approval_requests; s public.approval_steps; _uid uuid := auth.uid();
        _key text; _next public.approval_steps; _exec jsonb;
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

  IF NOT (public.has_permission('administration','approve')
          OR public.has_permission('administration','approvals','decide')) THEN
    RAISE EXCEPTION 'You do not have approval authority.';
  END IF;

  SELECT * INTO s FROM public.approval_steps
   WHERE request_id = r.id AND status = 'active' ORDER BY level LIMIT 1 FOR UPDATE;
  IF s.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No active approval level.');
  END IF;
  IF s.approver_user_id IS NOT NULL AND s.approver_user_id <> _uid THEN
    RAISE EXCEPTION 'This level is assigned to another approver.';
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

  -- append immutable decision
  INSERT INTO public.approval_actions (organization_id, request_id, actor_id, action, comment, level)
  VALUES (r.organization_id, r.id, _uid, _action, coalesce(_comment,''), s.level);

  UPDATE public.approval_steps
     SET status = _action, decided_at = now(), decided_by = _uid,
         comment = coalesce(_comment,''), updated_at = now()
   WHERE id = s.id;

  -- resolve the approver's actionable notification + task for this level
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

  -- approved: advance or finalise
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
END $$;

CREATE OR REPLACE FUNCTION public.neo_approval_retry_execution(_request uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _res jsonb; _org uuid;
BEGIN
  SELECT organization_id INTO _org FROM public.approval_requests WHERE id = _request;
  IF _org IS NULL OR _org <> public.current_org_id() THEN RAISE EXCEPTION 'Out of scope.'; END IF;
  IF NOT (public.has_permission('administration','approve')
          OR public.has_permission('administration','approvals','decide')) THEN
    RAISE EXCEPTION 'You do not have approval authority.';
  END IF;
  UPDATE public.approval_execution_failures
     SET status = 'retrying', retry_count = retry_count + 1, last_failed_at = now(), updated_at = now()
   WHERE request_id = _request AND status = 'open';
  _res := public.neo_approval_execute(_request);
  IF (_res->>'ok')::boolean THEN
    UPDATE public.approval_execution_failures
       SET status = 'resolved', resolved_at = now(), resolved_by = auth.uid(), updated_at = now()
     WHERE request_id = _request AND status IN ('open','retrying');
  ELSE
    UPDATE public.approval_execution_failures SET status = 'open', updated_at = now()
     WHERE request_id = _request AND status = 'retrying';
  END IF;
  RETURN _res;
END $$;

-- ============ 6. AUTHORITATIVE COUNTS ============
CREATE OR REPLACE FUNCTION public.neo_approval_counts()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'pending', count(*) FILTER (WHERE r.status = 'pending_approval'),
    'awaiting_execution', count(*) FILTER (WHERE r.status IN ('approved_pending_execution','executing')),
    'execution_failed', count(*) FILTER (WHERE r.status = 'execution_failed'),
    'completed', count(*) FILTER (WHERE r.status = 'completed'),
    'rejected', count(*) FILTER (WHERE r.status = 'rejected'),
    'cancelled', count(*) FILTER (WHERE r.status = 'cancelled'),
    'my_active', count(*) FILTER (WHERE r.requester_id = auth.uid()
        AND r.status IN ('pending_approval','approved_pending_execution','executing','execution_failed')),
    'my_inbox', count(*) FILTER (WHERE r.status = 'pending_approval' AND EXISTS (
        SELECT 1 FROM public.approval_steps s WHERE s.request_id = r.id AND s.status = 'active'
          AND (s.approver_user_id IS NULL OR s.approver_user_id = auth.uid())
          AND r.requester_id <> auth.uid()))
  )
  FROM public.approval_requests r
  WHERE r.organization_id = public.current_org_id();
$$;

REVOKE EXECUTE ON FUNCTION public.neo_approval_decide(uuid,text,text,text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_approval_execute(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_approval_retry_execution(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_approval_counts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_approval_decide(uuid,text,text,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_approval_retry_execution(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_approval_counts() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_approval_execute(uuid) TO service_role;
