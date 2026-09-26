ALTER TABLE public.banquet_event_orders
  ADD COLUMN IF NOT EXISTS setup_done_at timestamptz,
  ADD COLUMN IF NOT EXISTS service_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS service_ended_at timestamptz,
  ADD COLUMN IF NOT EXISTS cleanup_done_at timestamptz;

CREATE OR REPLACE FUNCTION public.neo_beo_stamp(_beo uuid, _moment text, _at timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.banquet_event_orders;
  v_at timestamptz := coalesce(_at, now());
BEGIN
  SELECT * INTO v_row FROM public.banquet_event_orders WHERE id = _beo;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF v_row.organization_id IS DISTINCT FROM public.current_org_id() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;
  IF NOT public.has_permission('events', 'banqueting', 'update') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_permitted');
  END IF;
  IF _moment NOT IN ('setup_done', 'service_started', 'service_ended', 'cleanup_done') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_moment');
  END IF;
  IF _moment = 'service_ended' AND v_row.service_started_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'service_not_started');
  END IF;
  IF _moment = 'service_ended' AND v_at < v_row.service_started_at THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ends_before_start');
  END IF;
  IF _moment = 'cleanup_done' AND v_row.service_ended_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'service_not_ended');
  END IF;
  IF _moment = 'cleanup_done' AND v_at < v_row.service_ended_at THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'cleanup_before_service_end');
  END IF;

  UPDATE public.banquet_event_orders
     SET setup_done_at = CASE WHEN _moment = 'setup_done' THEN v_at ELSE setup_done_at END,
         service_started_at = CASE WHEN _moment = 'service_started' THEN v_at ELSE service_started_at END,
         service_ended_at = CASE WHEN _moment = 'service_ended' THEN v_at ELSE service_ended_at END,
         cleanup_done_at = CASE WHEN _moment = 'cleanup_done' THEN v_at ELSE cleanup_done_at END,
         updated_by = auth.uid(),
         updated_at = now()
   WHERE id = _beo;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, action, module, record_id, new_value)
  VALUES (v_row.organization_id, v_row.branch_id, auth.uid(), 'events.beo.stamp', 'events', _beo::text,
          jsonb_build_object('moment', _moment, 'at', v_at));

  RETURN jsonb_build_object('ok', true, 'moment', _moment, 'at', v_at);
END;
$$;

REVOKE ALL ON FUNCTION public.neo_beo_stamp(uuid, text, timestamptz) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_beo_stamp(uuid, text, timestamptz) TO authenticated;