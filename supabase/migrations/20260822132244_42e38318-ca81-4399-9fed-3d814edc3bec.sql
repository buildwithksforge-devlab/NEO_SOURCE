
CREATE OR REPLACE FUNCTION public.neo_intelligence(_branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  org uuid := public.current_org_id();
  tz text; cur text; today date; f date; t date; days int;
  can_view boolean; can_money boolean;
  facts jsonb;
  briefing jsonb; demand jsonb; rates jsonb; anomalies jsonb;
  menu jsonb; sentiment jsonb; departments jsonb;
  hist jsonb; fwd jsonb;
  sellable int := 0; sample_days int := 0; avg_occ numeric := 0;
  arrivals int := 0; departures int := 0; unavailable int := 0;
  overdue_tasks int := 0; pending_appr int := 0; failed_wf int := 0;
  unmatched_n int := 0; failed_postings int := 0;
  menu_total int := 0; menu_costed int := 0;
  fb_n int := 0; fb_avg numeric; fb_neg int := 0;
BEGIN
  IF org IS NULL THEN
    RETURN jsonb_build_object('authorised', false, 'reason', 'no_organisation');
  END IF;

  can_money := public.is_org_admin()
    OR public.has_permission('finance','view')
    OR public.has_permission('analytics','view')
    OR public.has_permission('reports','view');
  can_view := can_money OR public.has_permission('ai','view');

  IF NOT can_view THEN
    RETURN jsonb_build_object('authorised', false, 'reason', 'insufficient_capability');
  END IF;

  tz := public.neo_fact_timezone(org, _branch);
  cur := public.neo_fact_currency(org, _branch);
  today := (now() AT TIME ZONE tz)::date;
  t := coalesce(_to, today);
  f := coalesce(_from, t - 29);
  days := GREATEST((t - f) + 1, 1);

  facts := public.neo_facts(_branch, f, t);

  /* ---------------- executive briefing ---------------- */
  SELECT count(*) INTO arrivals FROM public.reservations r
   WHERE r.organization_id = org AND (_branch IS NULL OR r.branch_id = _branch)
     AND r.arrival_date = today AND r.status IN ('confirmed','guaranteed','tentative','pending-deposit');

  SELECT count(*) INTO departures FROM public.stays s
   WHERE s.organization_id = org AND (_branch IS NULL OR s.branch_id = _branch)
     AND s.expected_departure::date = today AND s.status IN ('checked_in','in_house');

  SELECT count(*) FILTER (WHERE coalesce(r.sellable,true)),
         count(*) FILTER (WHERE NOT coalesce(r.sellable,true)
                             OR coalesce(r.maintenance_status,'none') IN ('blocked','out_of_service','out_of_order')
                             OR (r.out_of_order_from IS NOT NULL AND r.out_of_order_from::date <= today
                                 AND coalesce(r.out_of_order_to::date, today) >= today))
    INTO sellable, unavailable
    FROM public.rooms r
   WHERE r.organization_id = org AND (_branch IS NULL OR r.branch_id = _branch);

  SELECT count(*) INTO overdue_tasks FROM public.tasks tk
   WHERE tk.organization_id = org AND (_branch IS NULL OR tk.branch_id = _branch)
     AND tk.due_at < now() AND tk.status NOT IN ('completed','cancelled','done','closed');

  SELECT count(*) INTO pending_appr FROM public.approval_requests ar
   WHERE ar.organization_id = org AND (_branch IS NULL OR ar.branch_id = _branch)
     AND ar.status IN ('pending_approval','approved_pending_execution','executing');

  SELECT count(*) INTO failed_wf FROM public.workflow_failures wf
   WHERE wf.organization_id = org AND (_branch IS NULL OR wf.branch_id = _branch)
     AND wf.status NOT IN ('resolved','ignored');

  SELECT count(*) INTO unmatched_n FROM public.neo_unmatched_facts(_branch, f, t);

  SELECT count(*) INTO failed_postings FROM public.finance_posting_receipts pr
   WHERE pr.organization_id = org AND (_branch IS NULL OR pr.branch_id = _branch)
     AND pr.status = 'failed';

  briefing := jsonb_build_object(
    'pos_open_value', facts #> '{operational,pos_open_value}',
    'pos_finalised_sales', facts #> '{operational,pos_finalised_sales}',
    'net_recognised_revenue', facts #> '{accounting,net_recognised_revenue}',
    'collected', facts #> '{collections,total}',
    'receivables', facts #> '{receivables,total}',
    'payables', facts #> '{payables,total}',
    'occupancy_rate', facts #> '{rooms,occupancy_rate}',
    'sellable_rooms', sellable,
    'unavailable_rooms', unavailable,
    'arrivals_today', arrivals,
    'departures_today', departures,
    'overdue_tasks', overdue_tasks,
    'pending_approvals', pending_appr,
    'failed_workflows', failed_wf,
    'failed_postings', failed_postings,
    'unmatched_eligible', unmatched_n,
    'event_confirmed_forecast', facts #> '{events,confirmed_forecast}',
    'event_provisional_forecast', facts #> '{events,provisional_forecast}',
    'money_visible', can_money
  );

  /* ---------------- demand and occupancy ---------------- */
  WITH d AS (
    SELECT gs::date AS day FROM generate_series(f, t, interval '1 day') gs
  ), o AS (
    SELECT d.day,
      (SELECT count(*) FROM public.reservations r
        WHERE r.organization_id = org AND (_branch IS NULL OR r.branch_id = _branch)
          AND r.arrival_date <= d.day AND r.departure_date > d.day
          AND r.status IN ('checked_in','in_house','checked-in','in-house','checked_out','departed','checked-out')) AS occupied
    FROM d
  )
  SELECT jsonb_agg(jsonb_build_object('day', day, 'occupied', occupied,
           'occupancy', CASE WHEN sellable > 0 THEN round(occupied::numeric * 100 / sellable, 1) ELSE NULL END)
           ORDER BY day),
         count(*) FILTER (WHERE occupied > 0),
         CASE WHEN sellable > 0 THEN round(avg(occupied)::numeric * 100 / sellable, 1) ELSE NULL END
    INTO hist, sample_days, avg_occ FROM o;

  WITH d AS (
    SELECT gs::date AS day FROM generate_series(today, today + 13, interval '1 day') gs
  )
  SELECT jsonb_agg(jsonb_build_object(
           'day', d.day,
           'on_the_books', (SELECT count(*) FROM public.reservations r
              WHERE r.organization_id = org AND (_branch IS NULL OR r.branch_id = _branch)
                AND r.arrival_date <= d.day AND r.departure_date > d.day
                AND r.status IN ('confirmed','guaranteed','tentative','pending-deposit','checked_in','in_house')),
           'sellable', sellable) ORDER BY d.day)
    INTO fwd FROM d;

  demand := jsonb_build_object(
    'history', coalesce(hist, '[]'::jsonb),
    'forward', coalesce(fwd, '[]'::jsonb),
    'sample_days', sample_days,
    'average_occupancy', avg_occ,
    'sufficient', sample_days >= 14,
    'method', 'Occupied room nights from checked-in, in-house and departed stays over the selected period, divided by sellable rooms. Forward pace counts reservations on the books; it is pace, not a statistical forecast.',
    'confidence', CASE WHEN sample_days >= 60 THEN 'high' WHEN sample_days >= 14 THEN 'moderate' ELSE 'insufficient' END
  );

  /* ---------------- advisory rate suggestions ---------------- */
  SELECT coalesce(jsonb_agg(x ORDER BY x->>'room_type'), '[]'::jsonb) INTO rates FROM (
    SELECT jsonb_build_object(
      'room_type', rt.name,
      'rate_plan', rp.name,
      'current_rate', CASE WHEN can_money THEN rp.base_rate ELSE NULL END,
      'currency', cur,
      'rooms_of_type', (SELECT count(*) FROM public.rooms r WHERE r.organization_id = org
                          AND r.room_type_id = rt.id AND coalesce(r.sellable,true)
                          AND (_branch IS NULL OR r.branch_id = _branch)),
      'on_the_books_next_14', (SELECT count(*) FROM public.reservations r
          WHERE r.organization_id = org AND r.room_type_id = rt.id
            AND (_branch IS NULL OR r.branch_id = _branch)
            AND r.arrival_date <= today + 13 AND r.departure_date > today
            AND r.status IN ('confirmed','guaranteed','tentative','pending-deposit','checked_in','in_house')),
      'direction', 'advisory',
      'evidence', 'Compares reservations on the books for the next 14 days with sellable rooms of this type and the published rate plan. Advisory only — NEØ never changes or publishes a rate.'
    ) AS x
    FROM public.room_types rt
    LEFT JOIN LATERAL (
      SELECT p.name, p.base_rate FROM public.rate_plans p
       WHERE p.organization_id = org AND p.room_type_id = rt.id AND p.status = 'active'
         AND (_branch IS NULL OR p.branch_id = _branch)
       ORDER BY p.valid_from DESC NULLS LAST LIMIT 1
    ) rp ON true
    WHERE rt.organization_id = org AND (_branch IS NULL OR rt.branch_id = _branch)
      AND coalesce(rt.status,'active') = 'active'
    LIMIT 25
  ) s;

  /* ---------------- anomalies and reconciliation ---------------- */
  SELECT coalesce(jsonb_agg(x), '[]'::jsonb) INTO anomalies FROM (
    SELECT jsonb_build_object(
      'key', 'unmatched_eligible',
      'severity', CASE WHEN unmatched_n > 0 THEN 'warning' ELSE 'ok' END,
      'title', 'Eligible operational records not posted to Finance',
      'detail', unmatched_n || ' eligible record(s) in this period have no matching finance posting.',
      'evidence', 'neo_unmatched_facts for the selected property and period.',
      'drill_to', '/finance/posting') AS x
    WHERE unmatched_n > 0
    UNION ALL
    SELECT jsonb_build_object(
      'key', 'failed_postings',
      'severity', 'warning',
      'title', 'Finance postings that failed',
      'detail', failed_postings || ' posting attempt(s) failed and are awaiting a retry.',
      'evidence', 'finance_posting_receipts with status failed.',
      'drill_to', '/finance/posting')
    WHERE failed_postings > 0
    UNION ALL
    SELECT jsonb_build_object(
      'key', 'pos_voids',
      'severity', 'info',
      'title', 'Voided point-of-sale orders',
      'detail', (SELECT count(*) FROM public.pos_orders po
                  WHERE po.organization_id = org AND (_branch IS NULL OR po.branch_id = _branch)
                    AND po.status IN ('void','voided','cancelled')
                    AND po.created_at::date BETWEEN f AND t) || ' order(s) were voided or cancelled in this period.',
      'evidence', 'Pattern only — this is not an accusation. Review the void reasons and approvals.',
      'drill_to', '/pos/orders')
    WHERE (SELECT count(*) FROM public.pos_orders po
             WHERE po.organization_id = org AND (_branch IS NULL OR po.branch_id = _branch)
               AND po.status IN ('void','voided','cancelled')
               AND po.created_at::date BETWEEN f AND t) > 0
    UNION ALL
    SELECT jsonb_build_object(
      'key', 'failed_workflows',
      'severity', 'warning',
      'title', 'Failed automation workflows',
      'detail', failed_wf || ' workflow run(s) failed and have not been resolved.',
      'evidence', 'workflow_failures that are neither resolved nor ignored.',
      'drill_to', '/automation/failures')
    WHERE failed_wf > 0
    UNION ALL
    SELECT jsonb_build_object(
      'key', 'overdue_tasks',
      'severity', 'warning',
      'title', 'Overdue operational commitments',
      'detail', overdue_tasks || ' task(s) are past their due time.',
      'evidence', 'tasks past due_at that are not completed or cancelled.',
      'drill_to', '/tasks')
    WHERE overdue_tasks > 0
  ) a;

  /* ---------------- menu and recipe profitability ---------------- */
  SELECT count(*), count(*) FILTER (WHERE rc.portion_cost IS NOT NULL AND rc.portion_cost > 0)
    INTO menu_total, menu_costed
    FROM public.menu_items mi
    LEFT JOIN LATERAL (
      SELECT r.portion_cost FROM public.recipes r
       WHERE r.organization_id = org AND r.menu_item_id = mi.id AND coalesce(r.status,'active') <> 'archived'
       ORDER BY r.version DESC LIMIT 1) rc ON true
   WHERE mi.organization_id = org AND (_branch IS NULL OR mi.branch_id = _branch);

  SELECT jsonb_build_object(
    'items_total', menu_total,
    'items_costed', menu_costed,
    'coverage_percent', CASE WHEN menu_total > 0 THEN round(menu_costed::numeric * 100 / menu_total, 1) ELSE NULL END,
    'items', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'item', mi.name,
               'price', CASE WHEN can_money THEN mi.base_price ELSE NULL END,
               'cost', CASE WHEN can_money THEN rc.portion_cost ELSE NULL END,
               'margin_percent', CASE WHEN can_money AND mi.base_price > 0
                    THEN round((mi.base_price - rc.portion_cost) * 100 / mi.base_price, 1) ELSE NULL END)
               ORDER BY (mi.base_price - rc.portion_cost) / NULLIF(mi.base_price,0))
      FROM public.menu_items mi
      JOIN LATERAL (
        SELECT r.portion_cost FROM public.recipes r
         WHERE r.organization_id = org AND r.menu_item_id = mi.id AND coalesce(r.status,'active') <> 'archived'
         ORDER BY r.version DESC LIMIT 1) rc ON rc.portion_cost > 0
      WHERE mi.organization_id = org AND (_branch IS NULL OR mi.branch_id = _branch)
        AND mi.base_price > 0
      LIMIT 10), '[]'::jsonb),
    'note', 'Margin is only shown where a menu price and a costed recipe both exist. Items without a costed recipe are reported as missing coverage, never estimated.'
  ) INTO menu;

  /* ---------------- guest sentiment ---------------- */
  SELECT count(*), round(avg(cf.rating)::numeric, 2), count(*) FILTER (WHERE cf.rating <= 2)
    INTO fb_n, fb_avg, fb_neg
    FROM public.customer_feedback cf
   WHERE cf.organization_id = org AND (_branch IS NULL OR cf.branch_id = _branch)
     AND cf.received_at::date BETWEEN f AND t AND cf.rating IS NOT NULL;

  sentiment := jsonb_build_object(
    'responses', fb_n,
    'average_rating', fb_avg,
    'detractors', fb_neg,
    'method', 'rating_derived',
    'note', 'Derived arithmetically from submitted ratings. No text was analysed by a model and no guest identity is exposed here.',
    'themes', coalesce((
      SELECT jsonb_agg(jsonb_build_object('category', cat, 'responses', n, 'average_rating', avg_r) ORDER BY n DESC)
      FROM (
        SELECT coalesce(cf.category, cf.feedback_type, 'Uncategorised') AS cat,
               count(*) AS n, round(avg(cf.rating)::numeric, 2) AS avg_r
          FROM public.customer_feedback cf
         WHERE cf.organization_id = org AND (_branch IS NULL OR cf.branch_id = _branch)
           AND cf.received_at::date BETWEEN f AND t AND cf.rating IS NOT NULL
         GROUP BY 1 ORDER BY 2 DESC LIMIT 8) th), '[]'::jsonb)
  );

  /* ---------------- department advisories ---------------- */
  SELECT coalesce(jsonb_agg(x), '[]'::jsonb) INTO departments FROM (
    SELECT jsonb_build_object('department','Front Office','headline',
      arrivals || ' arrival(s) and ' || departures || ' departure(s) expected today.',
      'drill_to','/pms/arrivals') AS x
    UNION ALL
    SELECT jsonb_build_object('department','Housekeeping','headline',
      (SELECT count(*) FROM public.housekeeping_jobs j WHERE j.organization_id = org
         AND (_branch IS NULL OR j.branch_id = _branch)
         AND j.status NOT IN ('completed','cancelled','inspected')) || ' open housekeeping job(s); '
      || unavailable || ' room(s) unavailable.',
      'drill_to','/housekeeping')
    UNION ALL
    SELECT jsonb_build_object('department','Food & Beverage','headline',
      (SELECT count(*) FROM public.pos_orders po WHERE po.organization_id = org
         AND (_branch IS NULL OR po.branch_id = _branch)
         AND po.status IN ('draft','sent','ready','served')) || ' order(s) still open in service.',
      'drill_to','/pos/orders')
    UNION ALL
    SELECT jsonb_build_object('department','Events','headline',
      (SELECT count(*) FROM public.event_bookings eb WHERE eb.organization_id = org
         AND (_branch IS NULL OR eb.branch_id = _branch)
         AND eb.status IN ('confirmed','provisional','tentative')) || ' live event booking(s) in the pipeline.',
      'drill_to','/events/bookings')
    UNION ALL
    SELECT jsonb_build_object('department','Finance','headline',
      unmatched_n || ' unmatched eligible record(s) and ' || failed_postings || ' failed posting(s).',
      'drill_to','/finance/posting')
    UNION ALL
    SELECT jsonb_build_object('department','Inventory & Procurement','headline',
      (SELECT count(*) FROM public.menu_items mi WHERE mi.organization_id = org
         AND (_branch IS NULL OR mi.branch_id = _branch)) - menu_costed
      || ' menu item(s) without a costed recipe.',
      'drill_to','/kitchen/recipes')
    UNION ALL
    SELECT jsonb_build_object('department','Delivery','headline',
      (SELECT count(*) FROM public.delivery_orders d WHERE d.organization_id = org
         AND (_branch IS NULL OR d.branch_id = _branch)
         AND d.order_status NOT IN ('delivered','cancelled','rejected')) || ' delivery order(s) in flight.',
      'drill_to','/delivery')
  ) dep;

  RETURN jsonb_build_object(
    'authorised', true,
    'generated_at', now(),
    'timezone', tz,
    'currency', cur,
    'period', jsonb_build_object('from', f, 'to', t, 'days', days),
    'money_visible', can_money,
    'briefing', briefing,
    'demand', demand,
    'rate_suggestions', rates,
    'anomalies', anomalies,
    'menu', menu,
    'sentiment', sentiment,
    'departments', departments
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_intelligence(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_intelligence(uuid, date, date) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_outbox_health(_branch uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  org uuid := public.current_org_id();
  res jsonb;
BEGIN
  IF org IS NULL THEN RETURN jsonb_build_object('authorised', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.is_org_admin() OR public.has_permission('automation','view')
          OR public.has_permission('analytics','view') OR public.has_permission('finance','view')) THEN
    RETURN jsonb_build_object('authorised', false, 'reason', 'insufficient_capability');
  END IF;

  SELECT jsonb_build_object(
    'authorised', true,
    'generated_at', now(),
    'pending', count(*) FILTER (WHERE de.status = 'pending'),
    'retrying', count(*) FILTER (WHERE de.status = 'pending' AND coalesce(de.attempts,0) > 0),
    'processing', count(*) FILTER (WHERE de.status = 'processing'),
    'dead_lettered', count(*) FILTER (WHERE de.status = 'dead_letter' OR de.dead_lettered_at IS NOT NULL),
    'failed', count(*) FILTER (WHERE de.status = 'failed'),
    'processed_24h', count(*) FILTER (WHERE de.status = 'processed' AND de.processed_at > now() - interval '24 hours'),
    'oldest_pending_at', min(de.occurred_at) FILTER (WHERE de.status = 'pending')
  ) INTO res
  FROM public.domain_events de
  WHERE de.organization_id = org AND (_branch IS NULL OR de.branch_id = _branch);

  RETURN res;
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_outbox_health(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_outbox_health(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_outbox_failures(_branch uuid DEFAULT NULL, _limit integer DEFAULT 50)
RETURNS TABLE(
  id uuid, event_type text, source_module text, source_record_id uuid,
  status text, attempts integer, max_attempts integer, last_error text,
  occurred_at timestamptz, next_attempt_at timestamptz, dead_lettered_at timestamptz)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE org uuid := public.current_org_id();
BEGIN
  IF org IS NULL THEN RETURN; END IF;
  IF NOT (public.is_org_admin() OR public.has_permission('automation','view')
          OR public.has_permission('analytics','view') OR public.has_permission('finance','view')) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT de.id, de.event_type, de.source_module, de.source_record_id,
         de.status, coalesce(de.attempts,0), coalesce(de.max_attempts,5), de.last_error,
         de.occurred_at, de.next_attempt_at, de.dead_lettered_at
    FROM public.domain_events de
   WHERE de.organization_id = org
     AND (_branch IS NULL OR de.branch_id = _branch)
     AND (de.status IN ('failed','dead_letter') OR de.dead_lettered_at IS NOT NULL
          OR (de.status = 'pending' AND coalesce(de.attempts,0) > 0))
   ORDER BY coalesce(de.dead_lettered_at, de.occurred_at) DESC
   LIMIT GREATEST(coalesce(_limit, 50), 1);
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_outbox_failures(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_outbox_failures(uuid, integer) TO authenticated, service_role;
