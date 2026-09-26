CREATE OR REPLACE FUNCTION public.dashboard_metrics(_branch uuid DEFAULT NULL::uuid, _department uuid DEFAULT NULL::uuid, _station uuid DEFAULT NULL::uuid, _from timestamp with time zone DEFAULT (now() - '30 days'::interval), _to timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _uid uuid := auth.uid();
  _scope text := public.current_access_scope();
  _super boolean;
  _branches uuid[];
  _self boolean;
  _result jsonb;
  _due integer; _done integer;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'No organisation context'; END IF;

  _super := _scope IN ('organisation','organization','technical');
  _self  := _scope = 'self';

  IF _branch IS NOT NULL AND NOT public.neo_branch_in_scope(_branch) THEN
    RAISE EXCEPTION 'property_out_of_scope' USING ERRCODE = '42501';
  END IF;

  -- NULL means "no property narrowing" (superusers reading the organisation).
  _branches := CASE
    WHEN _branch IS NOT NULL THEN ARRAY[_branch]
    WHEN _super THEN NULL
    ELSE nullif(public.current_branch_ids(), '{}'::uuid[])
  END;

  SELECT count(*) FILTER (WHERE due_at BETWEEN _from AND _to),
         count(*) FILTER (WHERE due_at BETWEEN _from AND _to AND status = 'completed')
    INTO _due, _done
  FROM public.tasks
  WHERE organization_id = _org
    AND (_branches IS NULL OR branch_id = ANY(_branches))
    AND (_department IS NULL OR department_id = _department)
    AND (_station IS NULL OR station_id = _station)
    AND (NOT _self OR assignee_id = _uid OR created_by = _uid);

  SELECT jsonb_build_object(
    'organization_id', _org,
    'period_start', _from,
    'period_end', _to,
    'generated_at', now(),
    'tasks', (
      SELECT jsonb_build_object(
        'total', count(*),
        'open', count(*) FILTER (WHERE status NOT IN ('completed','cancelled')),
        'in_progress', count(*) FILTER (WHERE status = 'in-progress'),
        'completed', count(*) FILTER (WHERE status = 'completed'),
        'overdue', count(*) FILTER (WHERE due_at < now() AND status NOT IN ('completed','cancelled')),
        'mine_open', count(*) FILTER (WHERE assignee_id = _uid AND status NOT IN ('completed','cancelled')),
        'mine_overdue', count(*) FILTER (WHERE assignee_id = _uid AND due_at < now() AND status NOT IN ('completed','cancelled')),
        'unassigned', count(*) FILTER (WHERE assignee_id IS NULL AND status NOT IN ('completed','cancelled')),
        'due_in_period', _due,
        'completion_rate', CASE WHEN _due = 0 THEN NULL ELSE round((_done::numeric / _due) * 100, 1) END
      )
      FROM public.tasks
      WHERE organization_id = _org
        AND (_branches IS NULL OR branch_id = ANY(_branches))
        AND (_department IS NULL OR department_id = _department)
        AND (_station IS NULL OR station_id = _station)
        AND (NOT _self OR assignee_id = _uid OR created_by = _uid)
    ),
    'approvals', (
      -- Canonical request lifecycle: pending_approval → approved_pending_execution
      -- → executing → completed, or rejected / cancelled / returned.
      SELECT jsonb_build_object(
        'pending', count(*) FILTER (WHERE status = 'pending_approval'),
        'approved', count(*) FILTER (WHERE status IN ('approved_pending_execution','executing','completed')
                                       AND decided_at BETWEEN _from AND _to),
        'rejected', count(*) FILTER (WHERE status = 'rejected' AND decided_at BETWEEN _from AND _to),
        'mine_pending', count(*) FILTER (WHERE status IN ('pending_approval','returned_for_correction')
                                           AND requester_id = _uid),
        'delayed', count(*) FILTER (WHERE status = 'pending_approval' AND created_at < now() - interval '24 hours'),
        'avg_turnaround_hours', round(COALESCE(AVG(EXTRACT(epoch FROM (decided_at - created_at)) / 3600)
            FILTER (WHERE decided_at IS NOT NULL AND decided_at BETWEEN _from AND _to), 0)::numeric, 1)
      )
      FROM public.approval_requests
      WHERE organization_id = _org
        AND (_branches IS NULL OR branch_id = ANY(_branches))
        AND (_department IS NULL OR department_id = _department)
        AND (NOT _self OR requester_id = _uid)
    ),
    'notifications', (
      SELECT jsonb_build_object(
        'unread', count(*) FILTER (WHERE read_at IS NULL),
        'total', count(*)
      )
      FROM public.notifications
      WHERE organization_id = _org
        AND (user_id IS NULL OR user_id = _uid)
        AND (_branches IS NULL OR branch_id IS NULL OR branch_id = ANY(_branches))
    ),
    'staff', (
      SELECT jsonb_build_object(
        'active', count(*) FILTER (WHERE account_status = 'active'),
        'suspended', count(*) FILTER (WHERE account_status <> 'active'),
        'invited', count(*) FILTER (WHERE invitation_status = 'invited'),
        'unassigned', count(*) FILTER (WHERE branch_id IS NULL OR department_id IS NULL),
        'new_in_period', count(*) FILTER (WHERE created_at BETWEEN _from AND _to)
      )
      FROM public.profiles
      WHERE organization_id = _org AND account_type IN ('staff','platform_admin')
        AND (_branches IS NULL OR branch_id = ANY(_branches))
    ),
    'structure', jsonb_build_object(
      'branches', (SELECT count(*) FROM public.branches
                    WHERE organization_id = _org AND active
                      AND (_branches IS NULL OR id = ANY(_branches))),
      'departments', (SELECT count(*) FROM public.departments
                    WHERE organization_id = _org AND active
                      AND (_branches IS NULL OR branch_id = ANY(_branches))),
      'stations', (SELECT count(*) FROM public.operational_stations
                    WHERE organization_id = _org AND active
                      AND (_branches IS NULL OR branch_id = ANY(_branches))),
      'roles', (SELECT count(*) FROM public.roles WHERE organization_id = _org AND active)
    ),
    'audit', (
      SELECT jsonb_build_object(
        'events_in_period', count(*) FILTER (WHERE created_at BETWEEN _from AND _to),
        'events_24h', count(*) FILTER (WHERE created_at > now() - interval '24 hours'),
        'security_events', count(*) FILTER (WHERE module = 'security' AND created_at BETWEEN _from AND _to)
      )
      FROM public.audit_logs
      WHERE organization_id = _org
        AND (_branches IS NULL OR branch_id IS NULL OR branch_id = ANY(_branches))
    ),
    'alerts', (
      SELECT jsonb_build_object(
        'open', count(*) FILTER (WHERE status = 'open'),
        'critical', count(*) FILTER (WHERE status = 'open' AND severity = 'critical')
      )
      FROM public.dashboard_alerts
      WHERE organization_id = _org
        AND (_branches IS NULL OR branch_id IS NULL OR branch_id = ANY(_branches))
    )
  ) INTO _result;

  RETURN _result;
END; $function$;