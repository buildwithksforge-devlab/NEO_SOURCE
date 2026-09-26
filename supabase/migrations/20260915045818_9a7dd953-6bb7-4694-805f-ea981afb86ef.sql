CREATE OR REPLACE FUNCTION public.cash_open_shift(_branch uuid, _station uuid, _float numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _id uuid;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'Authenticated organization context required'; END IF;
  IF NOT (public.has_permission('pos','shifts.open')
          OR public.has_permission('pos','write')
          OR public.has_permission('finance','till.create')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to open a cashier shift'; END IF;
  IF _branch IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.branches b WHERE b.id=_branch AND b.organization_id=_org) THEN
    RAISE EXCEPTION 'The selected property does not belong to your workspace';
  END IF;
  IF _station IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.operational_stations s WHERE s.id=_station AND s.organization_id=_org
         AND (s.branch_id IS NULL OR _branch IS NULL OR s.branch_id=_branch)) THEN
    RAISE EXCEPTION 'The selected station does not belong to this property';
  END IF;
  SELECT id INTO _id FROM public.pos_shifts
   WHERE organization_id=_org AND cashier_id = auth.uid() AND status='open'
     AND COALESCE(branch_id::text,'') = COALESCE(_branch::text,'') LIMIT 1;
  IF _id IS NOT NULL THEN RETURN _id; END IF;
  INSERT INTO public.pos_shifts (organization_id, branch_id, station_id, cashier_id, opened_by,
    opening_float, status, shift_number)
  VALUES (_org, _branch, _station, auth.uid(), auth.uid(), COALESCE(_float,0), 'open',
    to_char(now(),'YYYYMMDD-HH24MI') || '-' || substr(auth.uid()::text,1,4))
  RETURNING id INTO _id;
  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (_org, auth.uid(), '', 'pos.shift.open', 'pos', _id::text, jsonb_build_object('float', _float));
  RETURN _id;
END; $function$;

-- Reuse an open cleaning job of the same type for the same room instead of
-- attempting a second insert that the duplicate guard would reject.
CREATE OR REPLACE FUNCTION public.hk_reuse_open_job(_org uuid, _room uuid, _job_type text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT j.id FROM public.housekeeping_jobs j
   WHERE j.organization_id=_org AND j.room_id=_room AND j.job_type=_job_type
     AND public.hk_job_is_open(j.status, j.superseded_by)
   ORDER BY j.created_at LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.hk_reuse_open_job(uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hk_reuse_open_job(uuid,uuid,text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.hk_guard_reuse_open_job()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  RETURN NEW;
END $$;