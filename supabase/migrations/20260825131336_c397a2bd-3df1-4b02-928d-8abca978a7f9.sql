-- ============================================================
-- Inspection & auditability: transaction history completeness
-- ============================================================
CREATE OR REPLACE FUNCTION public.neo_audit_completeness(_branch uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _org uuid := public.current_org_id();
  _rows jsonb := '[]'::jsonb;
BEGIN
  IF _org IS NULL THEN
    RETURN jsonb_build_object('generated_at', now(), 'branch_id', _branch, 'transactions', '[]'::jsonb, 'gaps', 0);
  END IF;

  WITH src AS (
    SELECT 'reservations' AS module, 'Reservations' AS label, r.id, r.created_by AS actor,
           NULL::uuid AS approval, (SELECT count(*) > 0 FROM public.folios f WHERE f.reservation_id = r.id) AS handoff,
           'Folio opened' AS handoff_label, false AS approval_required
      FROM public.reservations r
     WHERE r.organization_id = _org AND (_branch IS NULL OR r.branch_id = _branch)
    UNION ALL
    SELECT 'folios', 'Guest folios', f.id, f.created_by, NULL::uuid,
           f.status <> 'open' OR f.total_charges > 0, 'Charge or closure recorded', false
      FROM public.folios f
     WHERE f.organization_id = _org AND (_branch IS NULL OR f.branch_id = _branch)
    UNION ALL
    SELECT 'pos_orders', 'Restaurant & bar orders', o.id, o.created_by, NULL::uuid,
           o.folio_post_status IN ('posted', 'not_required'), 'Revenue posted', false
      FROM public.pos_orders o
     WHERE o.organization_id = _org AND (_branch IS NULL OR o.branch_id = _branch)
       AND o.status NOT IN ('draft', 'open')
    UNION ALL
    SELECT 'payments', 'Payments & receipts', p.id, p.received_by, NULL::uuid,
           p.posted_journal_id IS NOT NULL, 'Posted to the ledger', false
      FROM public.payments p
     WHERE p.organization_id = _org AND (_branch IS NULL OR p.branch_id = _branch)
    UNION ALL
    SELECT 'journal_entries', 'Finance journals', j.id, j.created_by, j.approval_request_id,
           j.posted_at IS NOT NULL, 'Journal posted', false
      FROM public.journal_entries j
     WHERE j.organization_id = _org AND (_branch IS NULL OR j.branch_id = _branch)
    UNION ALL
    SELECT 'purchase_requests', 'Requisitions', pr.id, pr.requested_by, pr.approval_request_id,
           (SELECT count(*) > 0 FROM public.purchase_orders po WHERE po.request_id = pr.id)
             OR pr.status IN ('draft', 'submitted', 'rejected', 'cancelled'),
           'Reached procurement', true
      FROM public.purchase_requests pr
     WHERE pr.organization_id = _org AND (_branch IS NULL OR pr.branch_id = _branch)
    UNION ALL
    SELECT 'purchase_orders', 'Purchase orders', po.id, po.created_by, po.approval_request_id,
           (SELECT count(*) > 0 FROM public.goods_receipts gr WHERE gr.order_id = po.id)
             OR po.status IN ('draft', 'pending_approval', 'cancelled', 'rejected'),
           'Goods received', true
      FROM public.purchase_orders po
     WHERE po.organization_id = _org AND (_branch IS NULL OR po.branch_id = _branch)
    UNION ALL
    SELECT 'goods_receipts', 'Goods receipts', gr.id, gr.received_by, NULL::uuid,
           gr.posted_at IS NOT NULL, 'Stock updated', false
      FROM public.goods_receipts gr
     WHERE gr.organization_id = _org AND (_branch IS NULL OR gr.branch_id = _branch)
    UNION ALL
    SELECT 'event_bookings', 'Event bookings', eb.id, eb.created_by, NULL::uuid,
           eb.billing_generated_at IS NOT NULL OR eb.status IN ('enquiry', 'provisional', 'tentative', 'cancelled'),
           'Billing generated', false
      FROM public.event_bookings eb
     WHERE eb.organization_id = _org AND (_branch IS NULL OR eb.branch_id = _branch)
    UNION ALL
    SELECT 'guest_laundry_orders', 'Guest laundry', gl.id, gl.created_by, NULL::uuid,
           gl.posted_at IS NOT NULL OR gl.status IN ('requested', 'collected', 'processing', 'cancelled'),
           'Charge posted', false
      FROM public.guest_laundry_orders gl
     WHERE gl.organization_id = _org AND (_branch IS NULL OR gl.branch_id = _branch)
    UNION ALL
    SELECT 'delivery_orders', 'Delivery orders', d.id, d.created_by, NULL::uuid,
           d.delivered_at IS NOT NULL OR d.cancelled_at IS NOT NULL
             OR d.order_status NOT IN ('delivered', 'completed'),
           'Dispatch completed', false
      FROM public.delivery_orders d
     WHERE d.organization_id = _org AND (_branch IS NULL OR d.branch_id = _branch)
    UNION ALL
    SELECT 'housekeeping_jobs', 'Cleaning jobs', h.id, h.created_by, NULL::uuid,
           h.completed_at IS NOT NULL OR h.status NOT IN ('completed', 'inspected'),
           'Completion stamped', false
      FROM public.housekeeping_jobs h
     WHERE h.organization_id = _org AND (_branch IS NULL OR h.branch_id = _branch)
  ), trail AS (
    SELECT DISTINCT record_id
      FROM public.audit_logs
     WHERE organization_id = _org AND record_id IS NOT NULL
       AND (_branch IS NULL OR branch_id = _branch OR branch_id IS NULL)
  ), scored AS (
    SELECT s.module, s.label, s.handoff_label, s.approval_required,
           count(*) AS total,
           count(*) FILTER (WHERE s.actor IS NOT NULL) AS with_actor,
           count(*) FILTER (WHERE s.id::text IN (SELECT record_id FROM trail)) AS with_trail,
           count(*) FILTER (WHERE s.approval IS NOT NULL) AS with_approval,
           count(*) FILTER (WHERE s.handoff) AS handoff_ok
      FROM src s
     GROUP BY 1, 2, 3, 4
  )
  SELECT jsonb_agg(
           jsonb_build_object(
             'module', module,
             'label', label,
             'total', total,
             'with_actor', with_actor,
             'with_trail', with_trail,
             'with_approval', with_approval,
             'approval_required', approval_required,
             'handoff_label', handoff_label,
             'handoff_ok', handoff_ok,
             'missing_actor', total - with_actor,
             'missing_trail', total - with_trail,
             'missing_handoff', total - handoff_ok,
             'status', CASE
               WHEN total = 0 THEN 'unknown'
               WHEN total - with_actor > 0 OR total - handoff_ok > 0 THEN 'attention'
               WHEN total - with_trail > 0 THEN 'partial'
               ELSE 'ready' END
           ) ORDER BY label
         )
    INTO _rows
    FROM scored;

  RETURN jsonb_build_object(
    'generated_at', now(),
    'branch_id', _branch,
    'transactions', COALESCE(_rows, '[]'::jsonb),
    'gaps', (
      SELECT COALESCE(sum((t->>'missing_actor')::int + (t->>'missing_handoff')::int), 0)
        FROM jsonb_array_elements(COALESCE(_rows, '[]'::jsonb)) t
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.neo_audit_completeness(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_audit_completeness(uuid) TO authenticated;

-- ============================================================
-- Notification & escalation integrity
-- ============================================================
CREATE OR REPLACE FUNCTION public.neo_notification_integrity(_branch uuid DEFAULT NULL, _days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _org uuid := public.current_org_id();
  _since timestamptz := now() - make_interval(days => GREATEST(COALESCE(_days, 30), 1));
  _rows jsonb := '[]'::jsonb;
  _fanout_limit int := 12;
BEGIN
  IF _org IS NULL THEN
    RETURN jsonb_build_object('generated_at', now(), 'branch_id', _branch, 'events', '[]'::jsonb,
                              'missing', 0, 'spam', 0, 'unconfigured', 0);
  END IF;

  WITH ev AS (
    SELECT de.event_type, de.id, de.source_record_id, de.status, de.occurred_at
      FROM public.domain_events de
     WHERE de.organization_id = _org
       AND (_branch IS NULL OR de.branch_id = _branch)
       AND de.occurred_at >= _since
  ), nt AS (
    SELECT n.event_type, n.source_record_id, n.user_id, n.action_required, n.read_at, n.acted_at, n.created_at
      FROM public.notifications n
     WHERE n.organization_id = _org
       AND (_branch IS NULL OR n.branch_id = _branch OR n.branch_id IS NULL)
       AND n.created_at >= _since
       AND n.event_type IS NOT NULL
  ), types AS (
    SELECT event_type FROM ev
    UNION SELECT event_type FROM nt
    UNION SELECT event_type FROM public.notification_rules WHERE organization_id = _org AND active
  ), agg AS (
    SELECT t.event_type,
           (SELECT count(*) FROM ev WHERE ev.event_type = t.event_type) AS triggers,
           (SELECT count(DISTINCT ev.source_record_id) FROM ev
             WHERE ev.event_type = t.event_type
               AND EXISTS (SELECT 1 FROM nt WHERE nt.event_type = t.event_type
                            AND nt.source_record_id = ev.source_record_id)) AS covered,
           (SELECT count(*) FROM nt WHERE nt.event_type = t.event_type) AS notices,
           (SELECT count(DISTINCT nt.user_id) FROM nt WHERE nt.event_type = t.event_type) AS recipients,
           (SELECT COALESCE(max(c), 0) FROM (
              SELECT count(DISTINCT user_id) AS c FROM nt
               WHERE nt.event_type = t.event_type AND nt.source_record_id IS NOT NULL
               GROUP BY nt.source_record_id) f) AS fanout_max,
           (SELECT COALESCE(sum(c - 1), 0) FROM (
              SELECT count(*) AS c FROM nt
               WHERE nt.event_type = t.event_type AND nt.source_record_id IS NOT NULL
               GROUP BY nt.source_record_id, nt.user_id HAVING count(*) > 1) d) AS duplicates,
           (SELECT count(*) FROM nt
             WHERE nt.event_type = t.event_type AND nt.action_required
               AND nt.acted_at IS NULL AND nt.created_at < now() - interval '24 hours') AS stale_actions,
           (SELECT count(*) FROM ev WHERE ev.event_type = t.event_type
              AND ev.status NOT IN ('processed', 'completed', 'ignored')) AS unprocessed,
           EXISTS (SELECT 1 FROM public.notification_rules r
                    WHERE r.organization_id = _org AND r.active AND r.event_type = t.event_type
                      AND (_branch IS NULL OR r.branch_id IS NULL OR r.branch_id = _branch))
             OR EXISTS (SELECT 1 FROM public.notification_templates tp
                    WHERE tp.organization_id = _org AND tp.active AND tp.event_type = t.event_type)
             AS rule_configured
      FROM types t
  )
  SELECT jsonb_agg(
           jsonb_build_object(
             'event_type', event_type,
             'triggers', triggers,
             'covered', covered,
             'missing', GREATEST(triggers - covered, 0),
             'notices', notices,
             'recipients', recipients,
             'fanout_max', fanout_max,
             'duplicates', duplicates,
             'stale_actions', stale_actions,
             'unprocessed', unprocessed,
             'rule_configured', rule_configured,
             'status', CASE
               WHEN NOT rule_configured THEN 'unconfigured'
               WHEN triggers > 0 AND covered < triggers THEN 'missing-alerts'
               WHEN fanout_max > _fanout_limit OR duplicates > 0 THEN 'spam'
               WHEN stale_actions > 0 THEN 'unattended'
               WHEN triggers = 0 AND notices = 0 THEN 'unknown'
               ELSE 'ok' END
           ) ORDER BY event_type
         )
    INTO _rows
    FROM agg;

  RETURN jsonb_build_object(
    'generated_at', now(),
    'branch_id', _branch,
    'window_days', GREATEST(COALESCE(_days, 30), 1),
    'fanout_limit', _fanout_limit,
    'events', COALESCE(_rows, '[]'::jsonb),
    'escalations_open', (
      SELECT count(*) FROM public.escalation_events e
       WHERE e.organization_id = _org AND (_branch IS NULL OR e.branch_id = _branch)
         AND e.resolved_at IS NULL AND e.created_at >= _since
    ),
    'escalations_unacknowledged', (
      SELECT count(*) FROM public.escalation_events e
       WHERE e.organization_id = _org AND (_branch IS NULL OR e.branch_id = _branch)
         AND e.acknowledged_at IS NULL AND e.created_at >= _since
    ),
    'missing', (SELECT COALESCE(sum((t->>'missing')::int), 0) FROM jsonb_array_elements(COALESCE(_rows,'[]'::jsonb)) t),
    'spam', (SELECT count(*) FROM jsonb_array_elements(COALESCE(_rows,'[]'::jsonb)) t WHERE t->>'status' = 'spam'),
    'unconfigured', (SELECT count(*) FROM jsonb_array_elements(COALESCE(_rows,'[]'::jsonb)) t WHERE t->>'status' = 'unconfigured')
  );
END;
$$;

REVOKE ALL ON FUNCTION public.neo_notification_integrity(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_notification_integrity(uuid, integer) TO authenticated;