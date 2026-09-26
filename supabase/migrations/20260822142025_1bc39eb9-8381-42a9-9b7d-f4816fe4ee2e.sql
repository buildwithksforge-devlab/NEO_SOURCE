CREATE OR REPLACE FUNCTION public.neo_reconciliation_meta(_branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH s AS (SELECT public.current_org_id() org),
  r AS (
    SELECT count(*) FILTER (WHERE p.status = 'posted')   AS posted,
           count(*) FILTER (WHERE p.status = 'failed')   AS failed,
           count(*) FILTER (WHERE p.status IN ('skipped','blocked')) AS skipped,
           max(p.posted_at)  AS last_posted_at,
           max(p.updated_at) AS last_receipt_at,
           max(p.updated_at) FILTER (WHERE p.status = 'failed') AS last_failure_at
      FROM public.finance_posting_receipts p, s
     WHERE p.organization_id = s.org
       AND (_branch IS NULL OR p.branch_id = _branch)
       AND (_from IS NULL OR coalesce(p.occurred_on, p.updated_at::date) >= _from)
       AND (_to   IS NULL OR coalesce(p.occurred_on, p.updated_at::date) <= _to)
  )
  SELECT jsonb_build_object(
    'authorised', (SELECT public.is_org_admin() OR public.has_permission('finance','view')
                     OR public.has_permission('analytics','view')),
    'sources', jsonb_build_array('neo_facts','neo_fact_reconciliation','neo_reconciliation_status',
                                 'finance_posting_receipts'),
    'period', jsonb_build_object('from', _from, 'to', _to),
    'timezone', public.neo_fact_timezone((SELECT org FROM s), _branch),
    'currency', public.neo_fact_currency((SELECT org FROM s), _branch),
    'receipts_posted', coalesce((SELECT posted FROM r),0),
    'receipts_failed', coalesce((SELECT failed FROM r),0),
    'receipts_skipped', coalesce((SELECT skipped FROM r),0),
    'last_posted_at', (SELECT last_posted_at FROM r),
    'last_reconciled_at', (SELECT last_receipt_at FROM r),
    'last_failure_at', (SELECT last_failure_at FROM r),
    'generated_at', now())
$function$;

REVOKE ALL ON FUNCTION public.neo_reconciliation_meta(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_reconciliation_meta(uuid, date, date) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_commitments(_branch uuid DEFAULT NULL::uuid, _limit integer DEFAULT 200)
 RETURNS TABLE(key text, kind text, module text, title text, detail text, severity text, due_at timestamp with time zone, overdue_minutes integer, drill_to text, reference text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    -- Reconciliation skips: eligible records the posting engine refused
    SELECT 'reconciliation_skipped:' || coalesce(p.branch_id::text,'all') || ':' || p.source_module,
           'blocked', 'finance',
           ('Reconciliation skipped ' || count(*)::text || ' ' ||
            public.neo_module_label(p.source_module) || ' record(s)')::text,
           ('These records were refused by an eligibility rule and are not in Finance. '
            || 'Latest reason: ' || coalesce(nullif(max(p.detail),''), 'no reason recorded'))::text,
           'medium', NULL::timestamptz, '/finance/posting',
           public.neo_module_label(p.source_module)
      FROM public.finance_posting_receipts p
     WHERE fin AND p.organization_id = org
       AND (_branch IS NULL OR p.branch_id = _branch)
       AND p.status IN ('skipped','blocked')
       AND p.updated_at > now() - interval '30 days'
     GROUP BY p.branch_id, p.source_module

    UNION ALL
    -- Operational value with no Finance posting at all: an analytics mismatch
    SELECT 'reconciliation_mismatch:' || coalesce(e.branch_id::text,'all') || ':' || e.source_type,
           'blocked', 'finance',
           ('Analytics mismatch: ' || count(*)::text || ' eligible ' ||
            public.neo_module_label(e.source_type) || ' record(s) are not in Finance')::text,
           ('Operational value ' || to_char(coalesce(sum(e.amount),0), 'FM999,999,999.00')
            || ' has no posting, so Analytics and Finance disagree for this property.')::text,
           'high', NULL::timestamptz, '/finance/posting',
           public.neo_module_label(e.source_type)
      FROM public.neo_finance_eligible_sources(_branch,
             (now() - interval '30 days')::date, now()::date) e
     WHERE fin
       AND NOT EXISTS (
         SELECT 1 FROM public.finance_posting_receipts p
          WHERE p.organization_id = org AND p.source_id = e.source_id
            AND p.status IN ('posted','reversed'))
     GROUP BY e.branch_id, e.source_type

    UNION ALL
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
END $function$;

REVOKE ALL ON FUNCTION public.neo_commitments(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_commitments(uuid, integer) TO authenticated, service_role;