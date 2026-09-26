-- 1. Event emission triggers ------------------------------------------------

CREATE OR REPLACE FUNCTION public.neo_event_pos_order_created()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  PERFORM public.emit_domain_event(
    NEW.organization_id, NEW.branch_id, 'order.created', 'restaurant', NEW.id,
    jsonb_build_object(
      'reference', COALESCE(NEW.order_number, ''),
      'order_type', COALESCE(NEW.order_type, ''),
      'status', COALESCE(NEW.status, ''),
      'total_amount', COALESCE(NEW.grand_total, 0),
      'waiter_id', NEW.waiter_id,
      'branch_id', NEW.branch_id
    ),
    'order.created:' || NEW.id::text,
    NEW.customer_id
  );
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS neo_event_pos_order_created ON public.pos_orders;
CREATE TRIGGER neo_event_pos_order_created
AFTER INSERT ON public.pos_orders
FOR EACH ROW EXECUTE FUNCTION public.neo_event_pos_order_created();

CREATE OR REPLACE FUNCTION public.neo_event_station_ticket_created()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _ref text;
BEGIN
  SELECT order_number INTO _ref FROM public.pos_orders WHERE id = NEW.order_id;
  PERFORM public.emit_domain_event(
    NEW.organization_id, NEW.branch_id, 'pos.ticket_routed', 'kitchen', NEW.order_id,
    jsonb_build_object(
      'reference', COALESCE(_ref, NEW.ticket_number, ''),
      'ticket_id', NEW.id,
      'ticket_number', COALESCE(NEW.ticket_number, ''),
      'station_id', NEW.station_id,
      'department_id', NEW.department_id,
      'branch_id', NEW.branch_id,
      'priority', COALESCE(NEW.priority, 'normal')
    ),
    'pos.ticket_routed:' || NEW.id::text
  );
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS neo_event_station_ticket_created ON public.station_tickets;
CREATE TRIGGER neo_event_station_ticket_created
AFTER INSERT ON public.station_tickets
FOR EACH ROW EXECUTE FUNCTION public.neo_event_station_ticket_created();

CREATE OR REPLACE FUNCTION public.neo_event_task_assigned()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NEW.assignee_id IS NULL THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND OLD.assignee_id IS NOT DISTINCT FROM NEW.assignee_id THEN RETURN NULL; END IF;
  PERFORM public.emit_domain_event(
    NEW.organization_id, NEW.branch_id, 'task.assigned', 'operations', NEW.id,
    jsonb_build_object(
      'reference', COALESCE(NEW.reference, ''),
      'title', COALESCE(NEW.title, ''),
      'priority', COALESCE(NEW.priority, 'normal'),
      'assignee_id', NEW.assignee_id,
      'department_id', NEW.department_id,
      'station_id', NEW.station_id,
      'branch_id', NEW.branch_id
    ),
    'task.assigned:' || NEW.id::text || ':' || NEW.assignee_id::text
  );
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS neo_event_task_assigned ON public.tasks;
CREATE TRIGGER neo_event_task_assigned
AFTER INSERT OR UPDATE OF assignee_id ON public.tasks
FOR EACH ROW EXECUTE FUNCTION public.neo_event_task_assigned();

-- 2. Notification wording for the newly emitted events -----------------------

INSERT INTO public.notification_templates
  (organization_id, event_type, category, priority, source_module, title_template, body_template, link_template, action_required, active)
SELECT NULL, 'order.created', 'operational-alert', 'normal', 'restaurant',
       'New order {{reference}}', 'A new {{order_type}} order has been opened.', '/pos/orders?order={{record}}', false, true
WHERE NOT EXISTS (SELECT 1 FROM public.notification_templates WHERE event_type='order.created' AND organization_id IS NULL);

INSERT INTO public.notification_templates
  (organization_id, event_type, category, priority, source_module, title_template, body_template, link_template, action_required, active)
SELECT NULL, 'task.assigned', 'tasks', 'high', 'operations',
       'Task assigned — {{title}}', 'You have been assigned task {{reference}}.', '/tasks?task={{record}}', true, true
WHERE NOT EXISTS (SELECT 1 FROM public.notification_templates WHERE event_type='task.assigned' AND organization_id IS NULL);

-- 3. Route notifications to the right recipient / department / station -------

CREATE OR REPLACE FUNCTION public.neo_notify_event_routed(
  _org uuid, _branch uuid, _event text, _record uuid, _payload jsonb, _idem text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _user uuid; _dept uuid; _station uuid; _id uuid;
BEGIN
  _payload := COALESCE(_payload, '{}'::jsonb);
  BEGIN _user := NULLIF(_payload->>'assignee_id','')::uuid; EXCEPTION WHEN OTHERS THEN _user := NULL; END;
  BEGIN _dept := NULLIF(_payload->>'department_id','')::uuid; EXCEPTION WHEN OTHERS THEN _dept := NULL; END;
  BEGIN _station := NULLIF(_payload->>'station_id','')::uuid; EXCEPTION WHEN OTHERS THEN _station := NULL; END;

  _id := public.neo_notify_event(_org, _user, _branch, _event, _record, _payload, _idem);

  IF _id IS NOT NULL AND (_dept IS NOT NULL OR _station IS NOT NULL) THEN
    UPDATE public.notifications
       SET department_id = COALESCE(_dept, department_id),
           station_id = COALESCE(_station, station_id)
     WHERE id = _id;
  END IF;
  RETURN _id;
END $$;

REVOKE ALL ON FUNCTION public.neo_notify_event_routed(uuid, uuid, text, uuid, jsonb, text) FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION public.outbox_process(_limit integer DEFAULT 50, _worker text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _w text := COALESCE(_worker, 'pg:' || md5(clock_timestamp()::text));
        _rec public.domain_events; _ok int := 0; _failed int := 0;
BEGIN
  PERFORM public.outbox_reap_expired_leases();
  FOR _rec IN SELECT * FROM public.outbox_claim(_w, _limit, 60) LOOP
    BEGIN
      PERFORM public.neo_notify_event_routed(_rec.organization_id, _rec.branch_id, _rec.event_type,
        _rec.source_record_id, _rec.payload, 'outbox:' || _rec.id::text);
      PERFORM public.outbox_ack(_rec.id);
      _ok := _ok + 1;
    EXCEPTION WHEN OTHERS THEN
      PERFORM public.outbox_fail(_rec.id, SQLERRM);
      _failed := _failed + 1;
    END;
  END LOOP;
  RETURN jsonb_build_object('worker', _w, 'processed', _ok, 'failed', _failed, 'ran_at', now());
END $$;

-- 4. Default workflows per workspace ----------------------------------------

CREATE OR REPLACE FUNCTION public.neo_install_default_workflows(_org uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _installed int := 0; _wf uuid; _spec record;
BEGIN
  IF _org IS NULL THEN RETURN 0; END IF;
  FOR _spec IN
    SELECT * FROM (VALUES
      ('New restaurant order raised', 'restaurant', 'order.created',
       'Notifies the restaurant service team whenever a new order is opened.',
       '[{"type":"notify_department","config":{"category":"operational-alert","title":"New order {{reference}}"}}]'::jsonb),
      ('Station ticket routed', 'kitchen', 'pos.ticket_routed',
       'Notifies the receiving station (kitchen, pastry, bar or coffee) when a production ticket is created.',
       '[{"type":"notify_department","config":{"category":"tasks","title":"New station ticket {{reference}}","scope":"station"}}]'::jsonb),
      ('Task assigned to a team member', 'operations', 'task.assigned',
       'Notifies the assignee as soon as a task is assigned to them.',
       '[{"type":"notify_user","config":{"category":"tasks","title":"Task assigned — {{title}}"}}]'::jsonb),
      ('Purchase request awaiting approval', 'procurement', 'purchase_request.created',
       'Notifies approvers when a purchase request is raised.',
       '[{"type":"notify_role","config":{"category":"approvals","title":"Purchase request {{reference}} needs approval"}}]'::jsonb)
    ) AS t(name, category, trigger_event, description, actions)
  LOOP
    IF EXISTS (SELECT 1 FROM public.workflow_definitions
                WHERE organization_id = _org AND name = _spec.name) THEN
      CONTINUE;
    END IF;

    INSERT INTO public.workflow_definitions
      (organization_id, name, category, description, trigger_type, trigger_event,
       status, is_system_template, current_version, published_version, published_at)
    VALUES (_org, _spec.name, _spec.category, _spec.description, 'event', _spec.trigger_event,
            'active', true, 1, 1, now())
    RETURNING id INTO _wf;

    INSERT INTO public.workflow_versions
      (organization_id, workflow_id, version, trigger, conditions, actions, published, notes)
    VALUES (_org, _wf, 1,
            jsonb_build_object('type','event','event',_spec.trigger_event),
            '[]'::jsonb, _spec.actions, true, 'Installed default NEØ workflow');

    _installed := _installed + 1;
  END LOOP;
  RETURN _installed;
END $$;

REVOKE ALL ON FUNCTION public.neo_install_default_workflows(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_install_default_workflows(uuid) TO authenticated, service_role;

DO $$
DECLARE _o uuid;
BEGIN
  FOR _o IN SELECT id FROM public.organizations LOOP
    PERFORM public.neo_install_default_workflows(_o);
  END LOOP;
END $$;