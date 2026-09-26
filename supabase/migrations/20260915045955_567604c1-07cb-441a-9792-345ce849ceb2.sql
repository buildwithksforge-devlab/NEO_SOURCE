DROP FUNCTION IF EXISTS public.hk_guard_reuse_open_job();

CREATE OR REPLACE FUNCTION public.tg_checkout_housekeeping_handoff()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_room public.rooms; v_department uuid; v_job uuid; v_task uuid; v_key text; v_notification uuid; v_existing uuid;
BEGIN
  IF NEW.status='checked-out' AND OLD.status IS DISTINCT FROM 'checked-out' AND NEW.room_id IS NOT NULL THEN
    SELECT * INTO v_room FROM public.rooms WHERE id=NEW.room_id FOR UPDATE;
    v_key:='checkout:'||NEW.reservation_id::text;
    IF NOT EXISTS(SELECT 1 FROM public.housekeeping_jobs WHERE organization_id=NEW.organization_id AND idempotency_key=v_key) THEN
      v_existing := public.hk_reuse_open_job(NEW.organization_id, NEW.room_id, 'checkout-cleaning');
      IF v_existing IS NOT NULL THEN
        UPDATE public.housekeeping_jobs
           SET reservation_id=COALESCE(reservation_id,NEW.reservation_id),
               priority='high', source=COALESCE(source,'checkout'),
               source_record_id=COALESCE(source_record_id,NEW.reservation_id), updated_at=now()
         WHERE id=v_existing;
        UPDATE public.rooms SET occupancy_status='vacant',housekeeping_status='dirty',inspection_status='pending',room_condition='vacant-dirty',sellable=false,updated_at=now() WHERE id=NEW.room_id;
        INSERT INTO public.audit_logs(organization_id,branch_id,department_id,user_id,user_name,action,module,record_id,new_value,reason,correlation_id)
        SELECT NEW.organization_id,NEW.branch_id,j.department_id,auth.uid(),'','housekeeping.checkout_handoff.reused','housekeeping',j.id::text,
               jsonb_build_object('room_id',NEW.room_id,'reservation_id',NEW.reservation_id),
               'Departure cleaning attached to the cleaning task already open for this room',gen_random_uuid()::text
          FROM public.housekeeping_jobs j WHERE j.id=v_existing;
        RETURN NEW;
      END IF;

      -- Automatic handoff: the manual duplicate check must never block a checkout.
      PERFORM set_config('neo.hk_allow_duplicate','on',true);
      SELECT id INTO v_department FROM public.departments WHERE organization_id=NEW.organization_id AND name ILIKE 'housekeeping%' ORDER BY name LIMIT 1;
      INSERT INTO public.tasks(organization_id,branch_id,department_id,reference,title,description,created_by,priority,status)
      VALUES(NEW.organization_id,NEW.branch_id,v_department,'HK-OUT-'||left(NEW.id::text,8),'Clean room '||coalesce(v_room.room_number,''),'Departure cleaning required.',auth.uid(),'high','open') RETURNING id INTO v_task;
      INSERT INTO public.housekeeping_jobs(organization_id,branch_id,department_id,job_number,task_id,room_id,room_type_id,job_type,reservation_id,priority,status,inspection_required,inspection_status,idempotency_key,source,source_record_id,created_by)
      VALUES(NEW.organization_id,NEW.branch_id,v_department,public.next_document_number('housekeeping-job'),v_task,NEW.room_id,v_room.room_type_id,'checkout-cleaning',NEW.reservation_id,'high','pending',true,'pending',v_key,'checkout',NEW.reservation_id,auth.uid()) RETURNING id INTO v_job;
      PERFORM set_config('neo.hk_allow_duplicate','',true);
      UPDATE public.rooms SET occupancy_status='vacant',housekeeping_status='dirty',inspection_status='pending',room_condition='vacant-dirty',sellable=false,updated_at=now() WHERE id=NEW.room_id;
      INSERT INTO public.notifications(organization_id,branch_id,department_id,category,title,body,link,priority,idempotency_key,action_required,source_module,source_record_id,event_type)
      SELECT NEW.organization_id,NEW.branch_id,v_department,'task','Departure cleaning — Room '||coalesce(v_room.room_number,''),'Guest checkout created a cleaning task.','/housekeeping/tasks','high','hk-checkout-notify:'||v_job::text,true,'housekeeping',v_job,'housekeeping.task.created'
      RETURNING id INTO v_notification;
      PERFORM public.emit_domain_event(NEW.organization_id,NEW.branch_id,'housekeeping.task.created','housekeeping',v_job,jsonb_build_object('room_id',NEW.room_id,'reservation_id',NEW.reservation_id,'task_id',v_task,'notification_id',v_notification),'hk-checkout:'||NEW.reservation_id::text,NULL);
      INSERT INTO public.audit_logs(organization_id,branch_id,department_id,user_id,user_name,action,module,record_id,new_value,reason,correlation_id)
      VALUES(NEW.organization_id,NEW.branch_id,v_department,auth.uid(),'','housekeeping.checkout_handoff','housekeeping',v_job::text,jsonb_build_object('room_id',NEW.room_id,'reservation_id',NEW.reservation_id,'task_id',v_task,'notification_id',v_notification),'Automatic checkout handoff',gen_random_uuid()::text);
    END IF;
  END IF;
  RETURN NEW;
END $$;