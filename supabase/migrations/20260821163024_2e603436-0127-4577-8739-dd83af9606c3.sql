CREATE INDEX IF NOT EXISTS audit_logs_org_created_idx
  ON public.audit_logs (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_org_module_created_idx
  ON public.audit_logs (organization_id, module, created_at DESC);

CREATE TABLE IF NOT EXISTS public.integrity_repair_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  check_key text NOT NULL,
  idempotency_key text NOT NULL,
  run_window timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts int NOT NULL DEFAULT 0,
  detected_count int NOT NULL DEFAULT 0,
  repaired_count int NOT NULL DEFAULT 0,
  remaining_count int NOT NULL DEFAULT 0,
  last_error text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS integrity_repair_jobs_idem_uidx
  ON public.integrity_repair_jobs (idempotency_key);
CREATE INDEX IF NOT EXISTS integrity_repair_jobs_org_idx
  ON public.integrity_repair_jobs (organization_id, check_key, run_window DESC);

GRANT SELECT ON public.integrity_repair_jobs TO authenticated;
GRANT ALL ON public.integrity_repair_jobs TO service_role;
ALTER TABLE public.integrity_repair_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "integrity_repair_jobs read" ON public.integrity_repair_jobs;
CREATE POLICY "integrity_repair_jobs read" ON public.integrity_repair_jobs
FOR SELECT TO authenticated
USING (organization_id = public.current_org_id() AND public.is_org_admin());

CREATE OR REPLACE FUNCTION public.integrity_repair_jobs_touch()
RETURNS trigger LANGUAGE plpgsql SET search_path = public
AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS integrity_repair_jobs_touch_trg ON public.integrity_repair_jobs;
CREATE TRIGGER integrity_repair_jobs_touch_trg
BEFORE UPDATE ON public.integrity_repair_jobs
FOR EACH ROW EXECUTE FUNCTION public.integrity_repair_jobs_touch();

-- Queue-aware, idempotent repair -------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_integrity_repair_check(
  _org uuid, _check text, _apply boolean, _window timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _idem text := coalesce(_org::text,'all') || ':' || _check || ':' ||
                to_char(_window, 'YYYYMMDDHH24MI') || ':' || CASE WHEN _apply THEN 'apply' ELSE 'scan' END;
  _job public.integrity_repair_jobs;
  _detected int := 0; _repaired int := 0;
BEGIN
  INSERT INTO public.integrity_repair_jobs (organization_id, check_key, idempotency_key, run_window, status)
  VALUES (_org, _check, _idem, _window, 'pending')
  ON CONFLICT (idempotency_key) DO NOTHING;

  SELECT * INTO _job FROM public.integrity_repair_jobs WHERE idempotency_key = _idem FOR UPDATE;

  IF _job.status = 'succeeded' THEN
    RETURN jsonb_build_object('check', _check, 'job_id', _job.id, 'status', 'skipped_already_done',
      'attempts', _job.attempts, 'detected', _job.detected_count,
      'repaired', _job.repaired_count, 'remaining', _job.remaining_count);
  END IF;

  UPDATE public.integrity_repair_jobs
     SET status = 'running', attempts = attempts + 1, started_at = coalesce(started_at, now()), last_error = NULL
   WHERE id = _job.id;

  BEGIN
    IF _check = 'rooms.sellable_drift' THEN
      SELECT count(*) INTO _detected FROM public.rooms r
       WHERE (_org IS NULL OR r.organization_id = _org)
         AND r.sellable IS DISTINCT FROM public.neo_room_is_sellable(
               r.housekeeping_status, r.maintenance_status, r.occupancy_status, r.status);
      IF _apply THEN
        WITH fixed AS (
          UPDATE public.rooms r SET updated_at = now()
           WHERE (_org IS NULL OR r.organization_id = _org)
             AND r.sellable IS DISTINCT FROM public.neo_room_is_sellable(
                   r.housekeeping_status, r.maintenance_status, r.occupancy_status, r.status)
          RETURNING 1
        ) SELECT count(*) INTO _repaired FROM fixed;
      END IF;

    ELSIF _check = 'pos.order_line_routing' THEN
      SELECT count(*) INTO _detected FROM public.pos_order_items i
       WHERE i.station_id IS NULL AND (_org IS NULL OR i.organization_id = _org);
      IF _apply THEN
        WITH candidate AS (
          SELECT i.id, public.neo_resolve_item_station(
                   i.organization_id, o.branch_id, i.menu_item_id, o.order_type) AS station
            FROM public.pos_order_items i
            JOIN public.pos_orders o ON o.id = i.order_id
           WHERE i.station_id IS NULL AND (_org IS NULL OR i.organization_id = _org)
        ), fixed AS (
          UPDATE public.pos_order_items i SET station_id = c.station
            FROM candidate c WHERE c.id = i.id AND c.station IS NOT NULL
          RETURNING 1
        ) SELECT count(*) INTO _repaired FROM fixed;
      END IF;
    ELSE
      RAISE EXCEPTION 'Unknown integrity check %', _check;
    END IF;

    UPDATE public.integrity_repair_jobs
       SET status = CASE WHEN NOT _apply THEN 'scanned'
                         WHEN _detected - _repaired > 0 THEN 'partial'
                         ELSE 'succeeded' END,
           detected_count = _detected,
           repaired_count = _repaired,
           remaining_count = greatest(_detected - _repaired, 0),
           finished_at = now(),
           evidence = jsonb_build_object(
             'check', _check, 'applied', _apply, 'window', _window,
             'detected', _detected, 'repaired', _repaired,
             'remaining', greatest(_detected - _repaired, 0), 'ran_at', now())
     WHERE id = _job.id;

  EXCEPTION WHEN OTHERS THEN
    UPDATE public.integrity_repair_jobs
       SET status = 'failed', last_error = SQLERRM, finished_at = now()
     WHERE id = _job.id;
    RAISE;
  END;

  IF _org IS NOT NULL THEN
    INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
    VALUES (_org, auth.uid(), 'Integrity repair', 'integrity.repair.' || _check, 'administration',
            _job.id::text,
            jsonb_build_object('detected', _detected, 'repaired', _repaired,
                               'remaining', greatest(_detected - _repaired,0), 'applied', _apply),
            'Automated integrity reconciliation');
  END IF;

  RETURN jsonb_build_object('check', _check, 'job_id', _job.id, 'applied', _apply,
    'detected', _detected, 'repaired', _repaired, 'remaining', greatest(_detected - _repaired, 0));
END $$;

CREATE OR REPLACE FUNCTION public.neo_integrity_repair(
  _org uuid DEFAULT NULL, _apply boolean DEFAULT true
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _scope uuid := _org; _win timestamptz := date_trunc('hour', now()); _rooms jsonb; _items jsonb;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    _scope := coalesce(_scope, public.current_org_id());
    IF _scope IS DISTINCT FROM public.current_org_id() OR NOT public.is_org_admin() THEN
      RAISE EXCEPTION 'Not authorised to run the integrity repair for this organisation.';
    END IF;
  END IF;

  _rooms := public.neo_integrity_repair_check(_scope, 'rooms.sellable_drift', _apply, _win);
  _items := public.neo_integrity_repair_check(_scope, 'pos.order_line_routing', _apply, _win);

  RETURN jsonb_build_object(
    'organization_id', _scope, 'applied', _apply, 'run_window', _win, 'checked_at', now(),
    'rooms_invalid_sellable', _rooms->'detected', 'rooms_repaired', _rooms->'repaired',
    'order_items_unrouted', _items->'detected', 'order_items_routed', _items->'repaired',
    'order_items_still_unrouted', _items->'remaining',
    'jobs', jsonb_build_array(_rooms, _items));
END $$;

REVOKE ALL ON FUNCTION public.neo_integrity_repair_check(uuid,text,boolean,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_integrity_repair_check(uuid,text,boolean,timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.neo_integrity_repair(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_integrity_repair(uuid, boolean) TO authenticated, service_role;