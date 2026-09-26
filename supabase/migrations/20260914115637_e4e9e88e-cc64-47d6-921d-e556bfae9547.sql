
-- 1. Housekeeping stale-task reconciliation from real evidence -----------------

CREATE OR REPLACE FUNCTION public.hk_reconcile_stale_jobs(_branch uuid DEFAULT NULL, _hours integer DEFAULT 24)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.current_org_id();
  v_hours integer := GREATEST(COALESCE(_hours, 24), 1);
  v_cutoff timestamptz;
  r record;
  v_closed int := 0;
  v_evidence jsonb := '[]'::jsonb;
BEGIN
  IF v_org IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation');
  END IF;
  IF NOT (public.has_permission('housekeeping','tasks.manage')
          OR public.has_permission('housekeeping','tasks.assign')
          OR public.is_org_admin_for(v_org)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_permitted');
  END IF;
  IF _branch IS NOT NULL AND NOT public.neo_branch_in_scope(_branch) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_permitted');
  END IF;

  v_cutoff := now() - make_interval(hours => v_hours);

  FOR r IN
    SELECT j.id,
           j.job_number,
           j.branch_id,
           j.room_id,
           j.status,
           j.job_type,
           COALESCE(j.due_at, j.started_at, j.created_at) AS reference_at,
           ins.id            AS inspection_id,
           ins.inspected_at  AS inspection_at,
           ins.job_id        AS inspection_job_id,
           later.id          AS later_job_id,
           later.job_number  AS later_job_number,
           later.completed_at AS later_completed_at
      FROM public.housekeeping_jobs j
      LEFT JOIN LATERAL (
        SELECT i.id, i.inspected_at, i.job_id
          FROM public.room_inspections i
         WHERE i.organization_id = j.organization_id
           AND i.result = 'passed'
           AND (i.job_id = j.id OR (j.room_id IS NOT NULL AND i.room_id = j.room_id AND i.inspected_at >= j.created_at))
         ORDER BY i.inspected_at DESC
         LIMIT 1
      ) ins ON true
      LEFT JOIN LATERAL (
        SELECT k.id, k.job_number, k.completed_at
          FROM public.housekeeping_jobs k
         WHERE k.organization_id = j.organization_id
           AND k.room_id IS NOT NULL
           AND k.room_id = j.room_id
           AND k.id <> j.id
           AND k.status = 'completed'
           AND k.completed_at IS NOT NULL
           AND k.completed_at >= j.created_at
         ORDER BY k.completed_at DESC
         LIMIT 1
      ) later ON true
     WHERE j.organization_id = v_org
       AND public.hk_job_is_open(j.status, j.superseded_by)
       AND (_branch IS NULL OR j.branch_id = _branch)
       AND public.neo_branch_in_scope(j.branch_id)
       AND COALESCE(j.due_at, j.started_at, j.created_at) < v_cutoff
       AND (ins.id IS NOT NULL OR later.id IS NOT NULL)
  LOOP
    IF r.inspection_id IS NOT NULL THEN
      UPDATE public.housekeeping_jobs
         SET status = 'completed',
             completed_at = COALESCE(r.inspection_at, now()),
             inspection_status = 'passed',
             updated_at = now()
       WHERE id = r.id;

      INSERT INTO public.audit_logs(organization_id, branch_id, user_id, user_name, action, module, record_id,
                                    previous_value, new_value, reason, permission_used)
      VALUES (v_org, r.branch_id, auth.uid(), 'Housekeeping reconciliation',
              'housekeeping.task.closed_on_evidence', 'housekeeping', r.id::text,
              jsonb_build_object('status', r.status),
              jsonb_build_object('status','completed','evidence','inspection','inspection_id', r.inspection_id,
                                 'inspected_at', r.inspection_at),
              'Task left open past ' || v_hours || 'h; a passed inspection proves the work was done.',
              'housekeeping.tasks.manage');

      v_evidence := v_evidence || jsonb_build_object(
        'job_id', r.id, 'job_number', r.job_number, 'room_id', r.room_id,
        'outcome', 'completed', 'evidence', 'inspection',
        'evidence_id', r.inspection_id, 'evidence_at', r.inspection_at);
      v_closed := v_closed + 1;

    ELSE
      UPDATE public.housekeeping_jobs
         SET status = 'superseded',
             superseded_by = r.later_job_id,
             superseded_at = now(),
             supersede_reason = 'A later clean of the same room was completed; this task is no longer outstanding.',
             updated_at = now()
       WHERE id = r.id;

      INSERT INTO public.audit_logs(organization_id, branch_id, user_id, user_name, action, module, record_id,
                                    previous_value, new_value, reason, permission_used)
      VALUES (v_org, r.branch_id, auth.uid(), 'Housekeeping reconciliation',
              'housekeeping.task.superseded_on_evidence', 'housekeeping', r.id::text,
              jsonb_build_object('status', r.status),
              jsonb_build_object('status','superseded','evidence','later_clean',
                                 'superseded_by', r.later_job_id, 'completed_at', r.later_completed_at),
              'Task left open past ' || v_hours || 'h; a later clean of the same room was completed.',
              'housekeeping.tasks.manage');

      v_evidence := v_evidence || jsonb_build_object(
        'job_id', r.id, 'job_number', r.job_number, 'room_id', r.room_id,
        'outcome', 'superseded', 'evidence', 'later_clean',
        'evidence_id', r.later_job_id, 'evidence_reference', r.later_job_number,
        'evidence_at', r.later_completed_at);
      v_closed := v_closed + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'resolved', v_closed, 'hours', v_hours,
                            'branch_id', _branch, 'generated_at', now(), 'evidence', v_evidence);
END;
$$;

GRANT EXECUTE ON FUNCTION public.hk_reconcile_stale_jobs(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hk_reconcile_stale_jobs(uuid, integer) TO service_role;

-- Read side: stale open tasks with the evidence that would close them ----------

CREATE OR REPLACE FUNCTION public.hk_stale_job_candidates(_branch uuid DEFAULT NULL, _hours integer DEFAULT 24)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'ok', true,
    'hours', GREATEST(COALESCE(_hours, 24), 1),
    'generated_at', now(),
    'tasks', COALESCE(jsonb_agg(t ORDER BY t->>'reference_at'), '[]'::jsonb))
  FROM (
    SELECT jsonb_build_object(
             'job_id', j.id,
             'job_number', j.job_number,
             'job_type', j.job_type,
             'status', j.status,
             'room_number', rm.room_number,
             'reference_at', COALESCE(j.due_at, j.started_at, j.created_at),
             'evidence', CASE WHEN ins.id IS NOT NULL THEN 'inspection'
                              WHEN later.id IS NOT NULL THEN 'later_clean'
                              ELSE 'none' END,
             'evidence_at', COALESCE(ins.inspected_at, later.completed_at),
             'evidence_reference', later.job_number
           ) AS t
      FROM public.housekeeping_jobs j
      LEFT JOIN public.rooms rm ON rm.id = j.room_id
      LEFT JOIN LATERAL (
        SELECT i.id, i.inspected_at FROM public.room_inspections i
         WHERE i.organization_id = j.organization_id AND i.result = 'passed'
           AND (i.job_id = j.id OR (j.room_id IS NOT NULL AND i.room_id = j.room_id AND i.inspected_at >= j.created_at))
         ORDER BY i.inspected_at DESC LIMIT 1
      ) ins ON true
      LEFT JOIN LATERAL (
        SELECT k.id, k.job_number, k.completed_at FROM public.housekeeping_jobs k
         WHERE k.organization_id = j.organization_id AND k.room_id = j.room_id AND k.id <> j.id
           AND k.status = 'completed' AND k.completed_at IS NOT NULL AND k.completed_at >= j.created_at
         ORDER BY k.completed_at DESC LIMIT 1
      ) later ON true
     WHERE j.organization_id = public.current_org_id()
       AND public.hk_job_is_open(j.status, j.superseded_by)
       AND (_branch IS NULL OR j.branch_id = _branch)
       AND public.neo_branch_in_scope(j.branch_id)
       AND COALESCE(j.due_at, j.started_at, j.created_at) < now() - make_interval(hours => GREATEST(COALESCE(_hours, 24), 1))
     LIMIT 200
  ) s;
$$;

GRANT EXECUTE ON FUNCTION public.hk_stale_job_candidates(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hk_stale_job_candidates(uuid, integer) TO service_role;

-- 2. Stock count reconciliation against the live ledger ------------------------

ALTER TABLE public.stock_take_lines
  ADD COLUMN IF NOT EXISTS ledger_quantity numeric,
  ADD COLUMN IF NOT EXISTS ledger_variance numeric,
  ADD COLUMN IF NOT EXISTS discrepancy_flag text,
  ADD COLUMN IF NOT EXISTS reconciled_at timestamptz;

CREATE OR REPLACE FUNCTION public.neo_stores_count_reconcile(_take uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.current_org_id();
  s record;
  v_lines int := 0; v_match int := 0; v_short int := 0; v_over int := 0; v_uncounted int := 0;
  v_value numeric := 0;
BEGIN
  IF v_org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.has_permission('stores','edit')
          OR public.has_permission('inventory','stocktake.manage')
          OR public.is_org_admin_for(v_org)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_permitted');
  END IF;

  SELECT * INTO s FROM public.stock_takes WHERE id = _take AND organization_id = v_org;
  IF s IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;

  UPDATE public.stock_take_lines l
     SET ledger_quantity = COALESCE(lv.quantity_on_hand, 0),
         ledger_variance = CASE WHEN l.counted_quantity IS NULL THEN NULL
                                ELSE l.counted_quantity - COALESCE(lv.quantity_on_hand, 0) END,
         discrepancy_flag = CASE
             WHEN l.counted_quantity IS NULL THEN 'not-counted'
             WHEN l.counted_quantity - COALESCE(lv.quantity_on_hand, 0) = 0 THEN 'match'
             WHEN l.counted_quantity - COALESCE(lv.quantity_on_hand, 0) < 0 THEN 'shortage'
             ELSE 'overage' END,
         reconciled_at = now(),
         updated_at = now()
    FROM (SELECT stock_item_id, quantity_on_hand FROM public.stock_levels
           WHERE organization_id = v_org AND location_id = s.location_id) lv
   WHERE l.stock_take_id = _take AND l.stock_item_id = lv.stock_item_id;

  -- Lines with no ledger row at all: the ledger holds nothing for that item here.
  UPDATE public.stock_take_lines l
     SET ledger_quantity = 0,
         ledger_variance = l.counted_quantity,
         discrepancy_flag = CASE WHEN l.counted_quantity IS NULL THEN 'not-counted'
                                 WHEN l.counted_quantity = 0 THEN 'match' ELSE 'overage' END,
         reconciled_at = now(),
         updated_at = now()
   WHERE l.stock_take_id = _take AND l.reconciled_at IS DISTINCT FROM now()
     AND NOT EXISTS (SELECT 1 FROM public.stock_levels sl
                      WHERE sl.organization_id = v_org AND sl.location_id = s.location_id
                        AND sl.stock_item_id = l.stock_item_id);

  SELECT count(*),
         count(*) FILTER (WHERE discrepancy_flag = 'match'),
         count(*) FILTER (WHERE discrepancy_flag = 'shortage'),
         count(*) FILTER (WHERE discrepancy_flag = 'overage'),
         count(*) FILTER (WHERE discrepancy_flag = 'not-counted'),
         COALESCE(sum(abs(COALESCE(ledger_variance,0) * COALESCE(NULLIF(unit_cost,0),0))), 0)
    INTO v_lines, v_match, v_short, v_over, v_uncounted, v_value
    FROM public.stock_take_lines WHERE stock_take_id = _take;

  INSERT INTO public.audit_logs(organization_id, branch_id, user_id, user_name, action, module, record_id,
                                previous_value, new_value, reason, permission_used)
  VALUES (v_org, s.branch_id, auth.uid(), 'Stock count reconciliation',
          'inventory.count.reconciled', 'inventory', _take::text, NULL,
          jsonb_build_object('lines', v_lines, 'match', v_match, 'shortage', v_short,
                             'overage', v_over, 'not_counted', v_uncounted, 'value_at_risk', v_value),
          'Physical count compared against the live stock ledger.', 'inventory.stocktake.manage');

  RETURN jsonb_build_object('ok', true, 'take_id', _take, 'lines', v_lines, 'match', v_match,
                            'shortage', v_short, 'overage', v_over, 'not_counted', v_uncounted,
                            'value_at_risk', v_value, 'generated_at', now());
END;
$$;

GRANT EXECUTE ON FUNCTION public.neo_stores_count_reconcile(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_stores_count_reconcile(uuid) TO service_role;

-- 3. Manager decision on a pending stock correction ----------------------------

CREATE OR REPLACE FUNCTION public.neo_stores_adjustment_decide(_adjustment uuid, _decision text, _notes text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.current_org_id();
  a record;
  v_result jsonb;
BEGIN
  IF v_org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF _decision NOT IN ('approve','reject') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_decision');
  END IF;
  IF NOT (public.has_permission('inventory','adjustments.approve') OR public.is_org_admin_for(v_org)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_permitted');
  END IF;

  SELECT * INTO a FROM public.stock_adjustments WHERE id = _adjustment AND organization_id = v_org;
  IF a IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF a.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_pending', 'status', a.status);
  END IF;
  IF a.requested_by IS NOT NULL AND a.requested_by = auth.uid() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'self_approval');
  END IF;

  IF _decision = 'approve' THEN
    v_result := public.inventory_post_adjustment(_adjustment);
    UPDATE public.stock_takes
       SET status = 'closed', completed_at = COALESCE(completed_at, now()), approved_by = auth.uid()
     WHERE organization_id = v_org AND location_id = a.location_id AND status = 'awaiting-approval';
  ELSE
    UPDATE public.stock_adjustments
       SET status = 'rejected', approved_by = auth.uid(), approved_at = now(),
           notes = COALESCE(notes, '') || CASE WHEN _notes IS NULL THEN '' ELSE ' | Declined: ' || _notes END,
           updated_at = now()
     WHERE id = _adjustment;
    v_result := jsonb_build_object('status','rejected');
  END IF;

  INSERT INTO public.audit_logs(organization_id, branch_id, user_id, user_name, action, module, record_id,
                                previous_value, new_value, reason, permission_used)
  VALUES (v_org, a.branch_id, auth.uid(), 'Stock correction decision',
          CASE WHEN _decision = 'approve' THEN 'inventory.adjustment.approved' ELSE 'inventory.adjustment.rejected' END,
          'inventory', _adjustment::text,
          jsonb_build_object('status', a.status),
          COALESCE(v_result, '{}'::jsonb),
          COALESCE(_notes, 'Stock correction ' || _decision || 'd from the counts screen.'),
          'inventory.adjustments.approve');

  RETURN jsonb_build_object('ok', true, 'decision', _decision, 'adjustment', _adjustment, 'result', v_result);
END;
$$;

GRANT EXECUTE ON FUNCTION public.neo_stores_adjustment_decide(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_stores_adjustment_decide(uuid, text, text) TO service_role;

-- 4. Live stock board: expose the reorder point and below-reorder counts -------

CREATE OR REPLACE FUNCTION public.neo_stock_live_board(_branch uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _org uuid := public.current_org_id(); _stores jsonb; _totals jsonb;
BEGIN
  IF _org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF _branch IS NOT NULL AND NOT public.neo_branch_in_scope(_branch) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_permitted');
  END IF;

  WITH lines AS (
    SELECT sl.location_id,
           loc.name AS location_name,
           loc.location_type,
           loc.branch_id,
           sl.stock_item_id,
           i.name AS item_name,
           i.sku,
           i.base_unit,
           coalesce(sl.quantity_on_hand, 0) AS on_hand,
           coalesce(i.min_level, i.reorder_point, 0) AS minimum_stock,
           coalesce(i.reorder_point, i.min_level, 0) AS reorder_point,
           coalesce(i.average_cost, i.last_cost, 0) AS unit_cost,
           sl.last_movement_at
      FROM public.stock_levels sl
      JOIN public.stock_locations loc ON loc.id = sl.location_id
      JOIN public.stock_items i ON i.id = sl.stock_item_id
     WHERE sl.organization_id = _org
       AND (_branch IS NULL OR loc.branch_id = _branch)
       AND public.neo_branch_in_scope(loc.branch_id)
  )
  SELECT jsonb_agg(store ORDER BY store->>'location_name'), jsonb_build_object(
           'lines', coalesce(sum((store->>'lines')::int), 0),
           'value', coalesce(sum((store->>'value')::numeric), 0),
           'below_minimum', coalesce(sum((store->>'below_minimum')::int), 0),
           'below_reorder', coalesce(sum((store->>'below_reorder')::int), 0),
           'out_of_stock', coalesce(sum((store->>'out_of_stock')::int), 0))
    INTO _stores, _totals
  FROM (
    SELECT jsonb_build_object(
             'location_id', location_id,
             'location_name', location_name,
             'location_type', location_type,
             'branch_id', branch_id,
             'lines', count(*),
             'value', round(sum(on_hand * unit_cost), 2),
             'below_minimum', count(*) FILTER (WHERE minimum_stock > 0 AND on_hand <= minimum_stock AND on_hand > 0),
             'below_reorder', count(*) FILTER (WHERE reorder_point > 0 AND on_hand <= reorder_point),
             'out_of_stock', count(*) FILTER (WHERE on_hand <= 0),
             'last_movement_at', max(last_movement_at),
             'items', jsonb_agg(jsonb_build_object(
                        'stock_item_id', stock_item_id,
                        'name', item_name,
                        'sku', sku,
                        'unit', base_unit,
                        'on_hand', on_hand,
                        'minimum_stock', minimum_stock,
                        'reorder_point', reorder_point,
                        'value', round(on_hand * unit_cost, 2),
                        'last_movement_at', last_movement_at)
                      ORDER BY item_name)
           ) AS store
      FROM lines
     GROUP BY location_id, location_name, location_type, branch_id
  ) grouped;

  RETURN jsonb_build_object(
    'ok', true,
    'generated_at', now(),
    'branch_id', _branch,
    'stores', coalesce(_stores, '[]'::jsonb),
    'totals', coalesce(_totals, jsonb_build_object('lines', 0, 'value', 0, 'below_minimum', 0, 'below_reorder', 0, 'out_of_stock', 0))
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.neo_stock_live_board(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_stock_live_board(uuid) TO service_role;
