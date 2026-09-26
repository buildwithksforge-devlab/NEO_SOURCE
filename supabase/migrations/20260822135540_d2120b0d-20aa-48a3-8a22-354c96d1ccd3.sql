-- NEØ: outbox replay + capability-checked commitments inbox. Additive only.

CREATE OR REPLACE FUNCTION public.neo_module_label(_module text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN _module IN ('pos','pos_order') THEN 'pos'
    WHEN _module IN ('folio','folio_charge','folio_payment') THEN 'folio'
    WHEN _module IN ('events','event_earned','event_deposit','event_invoice','event_cancellation') THEN 'events'
    WHEN _module IN ('laundry','laundry_order') THEN 'laundry'
    WHEN _module IN ('delivery','delivery_order') THEN 'delivery'
    WHEN _module IN ('procurement','supplier_invoice','supplier_payment') THEN 'procurement'
    ELSE coalesce(_module,'other') END
$$;
REVOKE ALL ON FUNCTION public.neo_module_label(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_module_label(text) TO authenticated, service_role;

-- Retries one failed or dead-lettered handoff. Safe to press twice: an event
-- already processed is reported, never replayed, and the finance post it drives
-- is itself idempotent.
CREATE OR REPLACE FUNCTION public.neo_outbox_replay(_event uuid, _reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE org uuid := public.current_org_id(); e public.domain_events; res jsonb;
BEGIN
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.is_org_admin() OR public.has_permission('finance','edit')
          OR public.has_permission('finance','approve')) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('outbox-replay:' || _event::text, 0));

  SELECT * INTO e FROM public.domain_events
   WHERE id = _event AND organization_id = org FOR UPDATE;
  IF e.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;

  IF e.status IN ('processed','completed') THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_processed',
      'detail', 'This handoff already succeeded - nothing was replayed.');
  END IF;

  UPDATE public.domain_events
     SET status = 'pending', next_attempt_at = now(), dead_lettered_at = NULL,
         locked_by = NULL, locked_until = NULL,
         max_attempts = greatest(coalesce(max_attempts,5), coalesce(attempts,0) + 1),
         updated_at = now()
   WHERE id = e.id;

  -- Finance handoffs are re-driven immediately; the posting engine refuses a
  -- second journal for the same source.
  IF e.source_module IS NOT NULL AND e.source_record_id IS NOT NULL
     AND (e.event_type LIKE 'finance.%' OR e.source_module IN
          ('pos_order','folio_charge','folio_payment','event_earned','event_deposit',
           'event_invoice','event_cancellation','delivery_order','laundry_order',
           'supplier_invoice','supplier_payment')) THEN
    BEGIN
      res := public.neo_finance_post_txn(e.source_module, e.source_record_id, true);
    EXCEPTION WHEN OTHERS THEN
      res := jsonb_build_object('ok', false, 'reason', 'retry_failed', 'detail', SQLERRM);
    END;
  END IF;

  INSERT INTO public.audit_logs (organization_id, branch_id, action, module, actor_id,
                                 record_id, reason, new_value)
  VALUES (org, e.branch_id, 'outbox.replay', 'finance', auth.uid(), e.id::text,
          coalesce(_reason, 'Manual replay of a failed handoff'),
          jsonb_build_object('event_type', e.event_type, 'attempts', e.attempts, 'result', res));

  RETURN jsonb_build_object('ok', true, 'reason', 'requeued', 'event_id', e.id,
                            'posting', res);
END $$;
REVOKE ALL ON FUNCTION public.neo_outbox_replay(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_outbox_replay(uuid,text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_outbox_replay_batch(
  _branch uuid DEFAULT NULL, _limit integer DEFAULT 25, _reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE org uuid := public.current_org_id(); r record;
        requeued int := 0; skipped int := 0; failed int := 0; out jsonb;
BEGIN
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.is_org_admin() OR public.has_permission('finance','edit')
          OR public.has_permission('finance','approve')) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  FOR r IN
    SELECT id FROM public.domain_events
     WHERE organization_id = org
       AND (_branch IS NULL OR branch_id = _branch)
       AND (status IN ('failed','dead_lettered') OR dead_lettered_at IS NOT NULL)
     ORDER BY occurred_at
     LIMIT greatest(coalesce(_limit,25), 1)
  LOOP
    out := public.neo_outbox_replay(r.id, _reason);
    IF coalesce((out->>'ok')::boolean,false) AND out->>'reason' = 'requeued' THEN
      requeued := requeued + 1;
    ELSIF out->>'reason' = 'already_processed' THEN skipped := skipped + 1;
    ELSE failed := failed + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'requeued', requeued,
                            'already_processed', skipped, 'failed', failed);
END $$;
REVOKE ALL ON FUNCTION public.neo_outbox_replay_batch(uuid,integer,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_outbox_replay_batch(uuid,integer,text) TO authenticated, service_role;

-- Overdue commitments and blocked operational items for the signed-in reader.
-- Every row carries one stable key so the same obligation cannot appear twice,
-- and one deep link to the screen that clears it.
CREATE OR REPLACE FUNCTION public.neo_commitments(_branch uuid DEFAULT NULL, _limit integer DEFAULT 200)
RETURNS TABLE (
  key text, kind text, module text, title text, detail text, severity text,
  due_at timestamptz, overdue_minutes integer, drill_to text, reference text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE org uuid := public.current_org_id(); uid uuid := auth.uid();
        admin boolean; fin boolean; ops boolean; hk boolean;
BEGIN
  IF org IS NULL OR uid IS NULL THEN RETURN; END IF;
  admin := public.is_org_admin();
  fin := admin OR public.has_permission('finance','view');
  ops := admin OR public.has_permission('operations','view') OR public.has_permission('tasks','view');
  hk := admin OR public.has_permission('housekeeping','view');

  RETURN QUERY
  WITH items AS (
    -- Approvals waiting on this reader
    SELECT ('approval:' || a.id::text) AS key, 'commitment'::text AS kind, 'approvals'::text AS module,
           ('Approval ' || coalesce(a.reference, left(a.id::text, 8)) || ' awaits your decision')::text AS title,
           coalesce(nullif(a.reason,''), a.approval_type)::text AS detail,
           'high'::text AS severity, a.created_at + interval '24 hours' AS due_at,
           '/approvals'::text AS drill_to, coalesce(a.reference, a.id::text)::text AS reference
      FROM public.approval_requests a
      JOIN public.approval_steps s ON s.request_id = a.id AND s.status = 'active'
     WHERE a.organization_id = org
       AND (_branch IS NULL OR a.branch_id = _branch)
       AND a.status = 'pending_approval'
       AND (s.approver_user_id = uid
            OR EXISTS (SELECT 1 FROM public.user_roles ur
                        WHERE ur.user_id = uid AND ur.role_id = s.approver_role_id))

    UNION ALL
    -- Tasks assigned to this reader and past due
    SELECT 'task:' || t.id::text, 'commitment', 'tasks',
           ('Task overdue: ' || t.title)::text,
           coalesce(nullif(t.description,''), 'No further detail recorded.')::text,
           CASE WHEN t.priority IN ('urgent','high') THEN 'high' ELSE 'medium' END,
           t.due_at, '/tasks', coalesce(t.reference, t.id::text)
      FROM public.tasks t
     WHERE t.organization_id = org
       AND (_branch IS NULL OR t.branch_id = _branch)
       AND t.assignee_id = uid
       AND t.status NOT IN ('completed','cancelled','done')
       AND t.due_at IS NOT NULL AND t.due_at < now()

    UNION ALL
    -- Guest requests past their promised time
    SELECT 'guest_request:' || g.id::text, 'commitment', 'guest-requests',
           ('Guest request overdue: ' || coalesce(g.category,'request'))::text,
           coalesce(nullif(g.description,''), 'No further detail recorded.')::text,
           CASE WHEN g.priority IN ('urgent','high') THEN 'high' ELSE 'medium' END,
           g.due_at, '/guest-requests', g.id::text
      FROM public.guest_requests g
     WHERE ops AND g.organization_id = org
       AND (_branch IS NULL OR g.branch_id = _branch)
       AND g.status NOT IN ('completed','closed','cancelled')
       AND g.due_at IS NOT NULL AND g.due_at < now()

    UNION ALL
    -- Housekeeping jobs past due
    SELECT 'housekeeping:' || j.id::text, 'blocked', 'housekeeping',
           ('Housekeeping job overdue: ' || coalesce(j.job_type,'clean'))::text,
           ('Job ' || coalesce(j.job_number, left(j.id::text,8)) || ' is ' || j.status)::text,
           'medium', j.due_at, '/housekeeping', coalesce(j.job_number, j.id::text)
      FROM public.housekeeping_jobs j
     WHERE hk AND j.organization_id = org
       AND (_branch IS NULL OR j.branch_id = _branch)
       AND j.status NOT IN ('completed','verified','cancelled','skipped')
       AND j.due_at IS NOT NULL AND j.due_at < now()

    UNION ALL
    -- Release-blocking maintenance defects
    SELECT 'defect:' || d.id::text, 'blocked', 'maintenance',
           ('Blocking defect: ' || d.summary)::text,
           ('Severity ' || coalesce(d.severity,'unclassified') || ' - status ' || d.status)::text,
           CASE WHEN coalesce(d.release_blocking,false) THEN 'high' ELSE 'medium' END,
           NULL::timestamptz, '/maintenance', coalesce(d.reference, d.id::text)
      FROM public.defects d
     WHERE ops AND d.organization_id = org
       AND (_branch IS NULL OR d.branch_id = _branch)
       AND d.status NOT IN ('closed','resolved','rejected')
       AND coalesce(d.release_blocking,false)

    UNION ALL
    -- Postings that failed and need a retry
    SELECT 'posting:' || p.id::text, 'blocked', 'finance',
           ('Finance posting failed: ' || public.neo_module_label(p.source_module))::text,
           coalesce(nullif(p.last_error,''), 'The posting attempt did not complete.')::text,
           'high', NULL::timestamptz, '/finance/posting',
           coalesce(p.source_reference, p.source_id::text)
      FROM public.finance_posting_receipts p
     WHERE fin AND p.organization_id = org
       AND (_branch IS NULL OR p.branch_id = _branch)
       AND p.status = 'failed'

    UNION ALL
    -- Handoffs that gave up and are waiting on a manual replay
    SELECT 'outbox:' || e.id::text, 'blocked', 'finance',
           ('Handoff needs replay: ' || e.event_type)::text,
           coalesce(nullif(e.last_error,''), 'The handoff exhausted its automatic attempts.')::text,
           'high', NULL::timestamptz, '/finance/outbox', e.id::text
      FROM public.domain_events e
     WHERE fin AND e.organization_id = org
       AND (_branch IS NULL OR e.branch_id = _branch)
       AND (e.status IN ('failed','dead_lettered') OR e.dead_lettered_at IS NOT NULL)
  )
  SELECT DISTINCT ON (i.key)
         i.key, i.kind, i.module, i.title, i.detail, i.severity, i.due_at,
         CASE WHEN i.due_at IS NULL THEN NULL
              ELSE greatest(0, (EXTRACT(EPOCH FROM (now() - i.due_at)) / 60)::int) END,
         i.drill_to, i.reference
    FROM items i
   ORDER BY i.key, i.due_at NULLS LAST
   LIMIT greatest(coalesce(_limit,200), 1);
END $$;
REVOKE ALL ON FUNCTION public.neo_commitments(uuid,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_commitments(uuid,integer) TO authenticated, service_role;