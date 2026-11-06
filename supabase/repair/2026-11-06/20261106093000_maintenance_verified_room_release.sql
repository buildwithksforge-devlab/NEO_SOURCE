BEGIN;
DO $neo_guard$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
  WHERE t.tgrelid='public.rooms'::regclass AND NOT t.tgisinternal AND t.tgenabled IN ('O','A')
  AND p.oid=to_regprocedure('public.rooms_derive_state()')) THEN
  RAISE EXCEPTION 'An enabled reviewed room-state trigger is required';
 END IF;
 IF (SELECT md5(replace(prosrc,E'\r\n',E'\n')) FROM pg_proc WHERE oid='public.rooms_derive_state()'::regprocedure)
  <> ALL(ARRAY['c776aac33760edc450ce8f717ea3d272','1d8cf89d05805c1b084292441d74eee6','b42d37b196439cb1c4d53a34da0810ee']) THEN
  RAISE EXCEPTION 'The room-state trigger differs from reviewed source';
 END IF;
 IF replace((SELECT prosrc FROM pg_proc WHERE oid='public.neo_maint_job_advance(uuid,text,text,text)'::regprocedure),E'\r\n',E'\n') IS DISTINCT FROM replace($neo_expected$
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
  -- O07: Verification is confirmed at closure, not when review begins.
  IF _status = 'closed' THEN
    IF nullif(btrim(coalesce(_note,'')), '') IS NULL THEN
      RAISE EXCEPTION 'A verification note is required before closing this work order'
        USING ERRCODE = '23514';
    END IF;

    IF v_row.completed_at IS NULL THEN
      RAISE EXCEPTION 'The repair must be completed before verification'
        USING ERRCODE = '23514';
    END IF;

    IF v_row.assigned_to = auth.uid() THEN
      RAISE EXCEPTION 'The assigned technician cannot verify their own repair'
        USING ERRCODE = '42501';
    END IF;
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
    verified_by = CASE WHEN _status = 'closed' THEN auth.uid()
                       WHEN _status IN ('reopened','awaiting-verification') THEN NULL ELSE verified_by END,
    verified_at = CASE WHEN _status = 'closed' THEN now()
                       WHEN _status IN ('reopened','awaiting-verification') THEN NULL ELSE verified_at END,
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
END; $neo_expected$,E'\r\n',E'\n') THEN RAISE EXCEPTION 'Maintenance function differs from reviewed source; inspect deployment before applying'; END IF;
 IF replace((SELECT prosrc FROM pg_proc WHERE oid='public.wo_set_block(uuid,boolean,text,text)'::regprocedure),E'\r\n',E'\n') IS DISTINCT FROM replace($neo_expected$
DECLARE v_org uuid := current_org_id(); v_wo record;
BEGIN
  IF NOT (has_permission('maintenance','approve') OR has_permission('maintenance','edit') OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to block or release rooms';
  END IF;
  SELECT * INTO v_wo FROM maintenance_work_orders WHERE id=_work_order AND organization_id=v_org FOR UPDATE;
  IF v_wo IS NULL THEN RAISE EXCEPTION 'Unknown work order'; END IF;
  IF v_wo.room_id IS NULL THEN RAISE EXCEPTION 'This work order is not linked to a room'; END IF;

  IF _block THEN
    PERFORM ops_set_room_status(v_wo.room_id, NULL, _severity, COALESCE(_reason, v_wo.description), 'maintenance', _work_order);
    UPDATE maintenance_work_orders SET blocks_room=true, block_status=_severity WHERE id=_work_order;
  ELSE
    PERFORM ops_set_room_status(v_wo.room_id, 'dirty', 'operational', COALESCE(_reason,'Repair verified'), 'maintenance', _work_order);
    UPDATE maintenance_work_orders SET blocks_room=false, block_status=NULL WHERE id=_work_order;
  END IF;
  RETURN jsonb_build_object('ok', true, 'blocked', _block);
END $neo_expected$,E'\r\n',E'\n') THEN RAISE EXCEPTION 'Maintenance function differs from reviewed source; inspect deployment before applying'; END IF;
 IF replace((SELECT prosrc FROM pg_proc WHERE oid='public.wo_track_status()'::regprocedure),E'\r\n',E'\n') IS DISTINCT FROM replace($neo_expected$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO work_order_status_history (organization_id, work_order_id, previous_status, new_status, changed_by)
    VALUES (NEW.organization_id, NEW.id, CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.status END, NEW.status, auth.uid());
  END IF;
  RETURN NEW;
END $neo_expected$,E'\r\n',E'\n') THEN RAISE EXCEPTION 'Maintenance history trigger differs from reviewed source';END IF;
END
$neo_guard$;
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
  v_prior_note text:=coalesce(current_setting('neo.maintenance_transition_note',true),'');
BEGIN
  SELECT * INTO v_row FROM public.maintenance_work_orders
   WHERE id = _work_order AND organization_id = current_org_id() FOR UPDATE;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'Work order not found'; END IF;

  IF auth.uid() IS NULL OR NOT public.neo_branch_in_scope(v_row.branch_id) THEN
    RAISE EXCEPTION 'Work order outside authorised property' USING ERRCODE='42501';
  END IF;
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
  -- O07: Verification is confirmed at closure, not when review begins.
  IF _status = 'closed' THEN
    IF nullif(btrim(coalesce(_note,'')), '') IS NULL THEN
      RAISE EXCEPTION 'A verification note is required before closing this work order'
        USING ERRCODE = '23514';
    END IF;

    IF v_row.completed_at IS NULL THEN
      RAISE EXCEPTION 'The repair must be completed before verification'
        USING ERRCODE = '23514';
    END IF;

    IF v_row.assigned_to = auth.uid() THEN
      RAISE EXCEPTION 'The assigned technician cannot verify their own repair'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  IF _status = v_before THEN RETURN v_row; END IF;

  PERFORM set_config('neo.maintenance_transition_note',coalesce(_note,''),true);
  UPDATE public.maintenance_work_orders SET
    status = _status,
    diagnosis = coalesce(nullif(btrim(_diagnosis), ''), diagnosis),
    completion_notes = CASE WHEN _status IN ('completed','awaiting-verification','closed')
                            THEN coalesce(nullif(btrim(_note), ''), completion_notes)
                            ELSE completion_notes END,
    accepted_at = CASE WHEN _status = 'accepted' AND accepted_at IS NULL THEN now() ELSE accepted_at END,
    completed_at = CASE WHEN _status = 'completed' THEN now()
                        WHEN _status = 'reopened' THEN NULL ELSE completed_at END,
    verified_by = CASE WHEN _status = 'closed' THEN auth.uid()
                       WHEN _status IN ('reopened','awaiting-verification') THEN NULL ELSE verified_by END,
    verified_at = CASE WHEN _status = 'closed' THEN now()
                       WHEN _status IN ('reopened','awaiting-verification') THEN NULL ELSE verified_at END,
    closed_at = CASE WHEN _status = 'closed' THEN now()
                     WHEN _status = 'reopened' THEN NULL ELSE closed_at END,
    updated_at = now()
  WHERE id = _work_order
  RETURNING * INTO v_row;
  PERFORM set_config('neo.maintenance_transition_note',v_prior_note,true);

  -- The existing status trigger already records each transition, when enabled.
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.maintenance_work_orders'::regclass
    AND tgfoid=to_regprocedure('public.wo_track_status()') AND NOT tgisinternal AND tgenabled<>'D') THEN
    INSERT INTO public.work_order_status_history
      (organization_id, work_order_id, previous_status, new_status, reason, changed_by)
    VALUES (v_row.organization_id, _work_order, v_before, _status, nullif(btrim(_note), ''), auth.uid());
  END IF;

  RETURN v_row;
END; $$;
CREATE OR REPLACE FUNCTION public.wo_track_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
BEGIN
 IF TG_OP='INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
  INSERT INTO public.work_order_status_history(organization_id,work_order_id,previous_status,new_status,reason,changed_by)
  VALUES(NEW.organization_id,NEW.id,CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.status END,NEW.status,
   CASE WHEN TG_OP='UPDATE' THEN coalesce(nullif(btrim(current_setting('neo.maintenance_transition_note',true)),''),
    CASE WHEN NEW.status IN ('completed','awaiting-verification','closed') THEN nullif(btrim(NEW.completion_notes),'') END) END,auth.uid());
 END IF;
 RETURN NEW;
END
$function$;
CREATE OR REPLACE FUNCTION public.neo_maintenance_lifecycle_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE v_supervisor boolean;v_allowed text[];
BEGIN
 IF auth.uid() IS NULL OR OLD.organization_id IS DISTINCT FROM public.current_org_id()
  OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
  OR NOT public.neo_branch_in_scope(OLD.branch_id) THEN
  RAISE EXCEPTION 'Work order outside authorised property' USING ERRCODE='42501';
 END IF;
 v_supervisor:=public.has_permission('maintenance','overview','approve') OR public.is_org_admin();
 IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to THEN
  IF NOT (public.has_permission('maintenance','edit') OR public.has_permission('maintenance','approve') OR public.is_org_admin()) THEN RAISE EXCEPTION 'Not permitted to assign work orders' USING ERRCODE='42501'; END IF;
  IF OLD.status IN ('completed','awaiting-verification','closed','cancelled') THEN RAISE EXCEPTION 'Reopen the repair before changing its technician'; END IF;
 END IF;
 IF NEW.status IS DISTINCT FROM OLD.status THEN
  IF NEW.status='assigned' THEN
   IF NOT (public.has_permission('maintenance','edit') OR public.has_permission('maintenance','approve') OR public.is_org_admin()) OR NEW.assigned_to IS NULL THEN RAISE EXCEPTION 'An authorised assignment and technician are required'; END IF;
  ELSIF OLD.assigned_to IS DISTINCT FROM auth.uid() AND NOT v_supervisor THEN
   RAISE EXCEPTION 'Only the assigned technician or a supervisor can update this job' USING ERRCODE='42501';
  END IF;
  IF NEW.status IN ('awaiting-verification','reopened','closed','cancelled') AND NOT v_supervisor THEN RAISE EXCEPTION 'Only a maintenance supervisor can review or close this job' USING ERRCODE='42501'; END IF;
  v_allowed:=CASE OLD.status
   WHEN 'new' THEN ARRAY['assigned','accepted','cancelled']
   WHEN 'assigned' THEN ARRAY['accepted','cancelled']
   WHEN 'accepted' THEN ARRAY['diagnosis','in-progress','waiting-parts','waiting-supplier','cancelled']
   WHEN 'diagnosis' THEN ARRAY['in-progress','waiting-parts','waiting-supplier','cancelled']
   WHEN 'in-progress' THEN ARRAY['waiting-parts','waiting-supplier','completed','cancelled']
   WHEN 'waiting-parts' THEN ARRAY['in-progress','waiting-supplier','cancelled']
   WHEN 'waiting-supplier' THEN ARRAY['in-progress','waiting-parts','cancelled']
   WHEN 'completed' THEN ARRAY['awaiting-verification','reopened']
   WHEN 'awaiting-verification' THEN ARRAY['closed','reopened']
   WHEN 'reopened' THEN ARRAY['assigned','accepted','diagnosis','in-progress','waiting-parts','waiting-supplier','cancelled']
   ELSE ARRAY[]::text[] END;
  IF NOT coalesce(NEW.status=ANY(v_allowed),false) THEN RAISE EXCEPTION 'Cannot move work order from % to %',OLD.status,NEW.status; END IF;
  IF NEW.status='cancelled' AND OLD.blocks_room THEN RAISE EXCEPTION 'A room-holding repair must be resolved before cancellation'; END IF;
  IF NEW.status='closed' THEN
   IF OLD.assigned_to IS NULL OR OLD.completed_at IS NULL OR nullif(btrim(NEW.completion_notes),'') IS NULL THEN RAISE EXCEPTION 'Completed repair and verification note required before closure'; END IF;
   IF OLD.assigned_to=auth.uid() THEN RAISE EXCEPTION 'The assigned technician cannot verify their own repair' USING ERRCODE='42501'; END IF;
   NEW.verified_by:=auth.uid();NEW.verified_at:=now();NEW.closed_at:=now();
  ELSE
   NEW.verified_by:=NULL;NEW.verified_at:=NULL;NEW.closed_at:=NULL;
   IF NEW.status='completed' THEN NEW.completed_at:=now();END IF;
   IF NEW.status='reopened' THEN NEW.completed_at:=NULL;END IF;
  END IF;
 ELSE
  IF NEW.verified_by IS DISTINCT FROM OLD.verified_by OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
   OR NEW.closed_at IS DISTINCT FROM OLD.closed_at OR NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
   RAISE EXCEPTION 'Lifecycle evidence is set by the authorised status transition';
  END IF;
 END IF;
 RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION public.neo_maintenance_lifecycle_guard() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS neo_maintenance_lifecycle_guard_trg ON public.maintenance_work_orders;
CREATE TRIGGER neo_maintenance_lifecycle_guard_trg
 BEFORE UPDATE OF status,assigned_to,verified_by,verified_at,completed_at,closed_at,organization_id,branch_id
 ON public.maintenance_work_orders FOR EACH ROW EXECUTE FUNCTION public.neo_maintenance_lifecycle_guard();

CREATE OR REPLACE FUNCTION public.wo_set_block(_work_order uuid,_block boolean,_severity text DEFAULT 'out-of-order',_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE v_org uuid:=public.current_org_id();v_wo public.maintenance_work_orders;v_room public.rooms;
 v_state jsonb;v_remaining integer;v_audit uuid;
BEGIN
 IF auth.uid() IS NULL OR v_org IS NULL OR NOT (public.has_permission('maintenance','approve') OR public.has_permission('maintenance','edit') OR public.is_org_admin()) THEN RAISE EXCEPTION 'Not permitted to block or release rooms' USING ERRCODE='42501';END IF;
 -- Serialise every hold mutation on this room before locking the work order.
 SELECT * INTO v_wo FROM public.maintenance_work_orders WHERE id=_work_order AND organization_id=v_org;
 IF v_wo.id IS NULL OR v_wo.room_id IS NULL THEN RAISE EXCEPTION 'Unknown room-linked work order';END IF;
 IF NOT public.neo_branch_in_scope(v_wo.branch_id) THEN RAISE EXCEPTION 'Work order outside authorised property' USING ERRCODE='42501';END IF;
 SELECT * INTO v_room FROM public.rooms WHERE id=v_wo.room_id AND organization_id=v_org AND branch_id=v_wo.branch_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'The work order room does not match its property';END IF;
 SELECT * INTO v_wo FROM public.maintenance_work_orders WHERE id=_work_order AND organization_id=v_org FOR UPDATE;
 IF v_wo.room_id IS DISTINCT FROM v_room.id OR v_wo.branch_id IS DISTINCT FROM v_room.branch_id THEN RAISE EXCEPTION 'The work order changed; reload before changing the room hold';END IF;
 IF _block IS NULL THEN RAISE EXCEPTION 'Choose whether to hold or release this room';END IF;
 IF _block THEN
  IF _severity IS NULL OR _severity NOT IN ('out-of-order','out-of-service','under-maintenance') THEN RAISE EXCEPTION 'Unsupported maintenance hold severity';END IF;
  IF v_wo.status IN ('closed','cancelled') THEN RAISE EXCEPTION 'Reopen the work order before blocking its room';END IF;
  v_state:=public.ops_set_room_status(v_room.id,NULL,_severity,coalesce(_reason,v_wo.description),'maintenance',_work_order,NULL);
  UPDATE public.maintenance_work_orders SET blocks_room=true,block_status=_severity WHERE id=_work_order;
 ELSE
  IF NOT coalesce(v_wo.blocks_room,false) THEN
   RETURN jsonb_build_object('ok',true,'idempotent',true,'work_order_id',_work_order,'room_id',v_room.id,'blocked',false,'room_released',v_room.maintenance_status='operational');
  END IF;
  IF v_wo.assigned_to IS NULL OR v_wo.status<>'closed' OR v_wo.completed_at IS NULL OR v_wo.verified_at IS NULL OR v_wo.verified_by IS NULL
   OR v_wo.verified_by IS NOT DISTINCT FROM v_wo.assigned_to OR nullif(btrim(v_wo.completion_notes),'') IS NULL THEN
   RAISE EXCEPTION 'Independent verification and closure are required before releasing this room' USING ERRCODE='23514';
  END IF;
  SELECT count(*) INTO v_remaining FROM public.maintenance_work_orders WHERE room_id=v_room.id AND organization_id=v_org AND branch_id=v_room.branch_id AND id<>_work_order AND blocks_room;
  IF v_remaining=0 THEN
   v_state:=public.ops_set_room_status(v_room.id,'dirty','operational',coalesce(_reason,'Repair independently verified'),'maintenance',_work_order,NULL);
  END IF;
  UPDATE public.maintenance_work_orders SET blocks_room=false,block_status=NULL WHERE id=_work_order;
 END IF;
 IF (_block OR coalesce(v_remaining,0)=0) AND coalesce((v_state->>'ok')::boolean,false) IS NOT TRUE THEN RAISE EXCEPTION 'The room state change was not confirmed';END IF;
 SELECT * INTO v_room FROM public.rooms WHERE id=v_room.id;
 IF _block AND v_room.maintenance_status IS DISTINCT FROM _severity THEN RAISE EXCEPTION 'The maintenance hold was not saved';END IF;
 IF NOT _block AND v_remaining=0 AND (v_room.maintenance_status<>'operational' OR v_room.housekeeping_status<>'dirty') THEN RAISE EXCEPTION 'The verified repair was not handed back for cleaning';END IF;
 v_audit:=public.log_audit_event('maintenance.room_hold.changed','maintenance',_work_order::text,NULL,jsonb_build_object('blocked',_block,'room_id',v_room.id,'remaining_holds',coalesce(v_remaining,0)),'Maintenance room hold','maintenance.room_hold',v_room.branch_id,NULL,NULL,NULL,NULL,NULL);
 IF v_audit IS NULL THEN RAISE EXCEPTION 'The maintenance hold audit was not saved';END IF;
 RETURN jsonb_build_object('ok',true,'work_order_id',_work_order,'room_id',v_room.id,'blocked',_block,
  'room_released',NOT _block AND coalesce(v_remaining,0)=0,'remaining_holds',coalesce(v_remaining,0),'audit_id',v_audit);
END
$function$;
REVOKE ALL ON FUNCTION public.wo_set_block(uuid,boolean,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.wo_set_block(uuid,boolean,text,text) TO authenticated;
COMMIT;