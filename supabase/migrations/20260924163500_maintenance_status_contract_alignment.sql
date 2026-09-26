-- Align Maintenance My Jobs, RPC transitions, and the canonical work-order status constraint.
-- Removes legacy statuses that the table never accepted (on-hold, verified) and uses the
-- canonical waiting/verification states already used by the Maintenance board.

CREATE OR REPLACE FUNCTION public.neo_maint_job_advance(
  _work_order uuid,
  _status text,
  _note text DEFAULT '',
  _diagnosis text DEFAULT ''
)
RETURNS public.maintenance_work_orders
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row public.maintenance_work_orders;
  v_before text;
  v_is_supervisor boolean;
  v_allowed text[];
BEGIN
  SELECT * INTO v_row FROM public.maintenance_work_orders
   WHERE id = _work_order AND organization_id = current_org_id() FOR UPDATE;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'Work order not found'; END IF;

  v_before := v_row.status;
  v_is_supervisor := has_permission('maintenance', 'overview', 'approve') OR is_org_admin();

  IF v_row.assigned_to IS DISTINCT FROM auth.uid() AND NOT v_is_supervisor THEN
    RAISE EXCEPTION 'Only the assigned technician or a supervisor can update this job';
  END IF;

  IF _status NOT IN (
    'accepted','diagnosis','in-progress','waiting-parts','waiting-supplier',
    'completed','awaiting-verification','reopened','closed','cancelled'
  ) THEN
    RAISE EXCEPTION 'Unknown work order status %', _status;
  END IF;

  IF _status IN ('awaiting-verification','reopened','closed','cancelled') AND NOT v_is_supervisor THEN
    RAISE EXCEPTION 'Only a maintenance supervisor can move a job to %', _status;
  END IF;

  IF _status IN ('awaiting-verification','closed')
     AND v_row.assigned_to = auth.uid()
     AND NOT is_org_admin() THEN
    RAISE EXCEPTION 'You cannot verify your own work';
  END IF;

  v_allowed := CASE v_before
    WHEN 'new' THEN ARRAY['assigned','accepted','cancelled']
    WHEN 'assigned' THEN ARRAY['accepted','cancelled']
    WHEN 'accepted' THEN ARRAY['diagnosis','in-progress','waiting-parts','waiting-supplier','cancelled']
    WHEN 'diagnosis' THEN ARRAY['in-progress','waiting-parts','waiting-supplier','cancelled']
    WHEN 'in-progress' THEN ARRAY['waiting-parts','waiting-supplier','completed','cancelled']
    WHEN 'waiting-parts' THEN ARRAY['in-progress','waiting-supplier','cancelled']
    WHEN 'waiting-supplier' THEN ARRAY['in-progress','waiting-parts','cancelled']
    WHEN 'completed' THEN ARRAY['awaiting-verification','reopened']
    WHEN 'awaiting-verification' THEN ARRAY['closed','reopened']
    WHEN 'reopened' THEN ARRAY['accepted','diagnosis','in-progress','waiting-parts','waiting-supplier','cancelled']
    ELSE ARRAY[]::text[]
  END;

  IF _status <> v_before AND NOT (_status = ANY(v_allowed)) THEN
    RAISE EXCEPTION 'Cannot move work order from % to %', v_before, _status;
  END IF;
  IF _status = v_before THEN RETURN v_row; END IF;

  UPDATE public.maintenance_work_orders SET
    status = _status,
    diagnosis = coalesce(nullif(btrim(_diagnosis), ''), diagnosis),
    completion_notes = CASE WHEN _status IN ('completed','awaiting-verification','closed')
                            THEN coalesce(nullif(btrim(_note), ''), completion_notes)
                            ELSE completion_notes END,
    accepted_at = CASE WHEN _status = 'accepted' AND accepted_at IS NULL THEN now() ELSE accepted_at END,
    completed_at = CASE WHEN _status = 'completed' THEN now()
                        WHEN _status = 'reopened' THEN NULL ELSE completed_at END,
    verified_by = CASE WHEN _status = 'awaiting-verification' THEN auth.uid()
                       WHEN _status = 'reopened' THEN NULL ELSE verified_by END,
    verified_at = CASE WHEN _status = 'awaiting-verification' THEN now()
                       WHEN _status = 'reopened' THEN NULL ELSE verified_at END,
    closed_at = CASE WHEN _status = 'closed' THEN now()
                     WHEN _status = 'reopened' THEN NULL ELSE closed_at END,
    updated_at = now()
  WHERE id = _work_order
  RETURNING * INTO v_row;

  INSERT INTO public.work_order_status_history
    (organization_id, work_order_id, previous_status, new_status, reason, changed_by)
  VALUES
    (v_row.organization_id, _work_order, v_before, _status, nullif(btrim(_note), ''), auth.uid());

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_maint_job_advance(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_maint_job_advance(uuid, text, text, text) TO authenticated;
