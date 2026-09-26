
-- ===== Notifications: taxonomy, actionability, workflow history =====
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS action_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS source_module text,
  ADD COLUMN IF NOT EXISTS source_record_id uuid,
  ADD COLUMN IF NOT EXISTS event_type text,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS acted_at timestamptz,
  ADD COLUMN IF NOT EXISTS acted_by uuid;

CREATE UNIQUE INDEX IF NOT EXISTS notifications_idem_uidx
  ON public.notifications (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.notification_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  notification_id uuid NOT NULL REFERENCES public.notifications(id) ON DELETE CASCADE,
  actor_id uuid,
  action text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.notification_history TO authenticated;
GRANT ALL ON public.notification_history TO service_role;
ALTER TABLE public.notification_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_history_read ON public.notification_history;
CREATE POLICY notification_history_read ON public.notification_history
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.notifications n
                  WHERE n.id = notification_history.notification_id
                    AND n.organization_id = public.current_org_id()
                    AND (n.user_id IS NULL OR n.user_id = auth.uid())));
DROP POLICY IF EXISTS notification_history_write ON public.notification_history;
CREATE POLICY notification_history_write ON public.notification_history
  FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id() AND actor_id = auth.uid());

CREATE INDEX IF NOT EXISTS notification_history_notification_idx
  ON public.notification_history (notification_id, created_at DESC);

-- Central emitter: one place that creates every operational notification.
CREATE OR REPLACE FUNCTION public.neo_notify(
  _org uuid, _user uuid, _branch uuid, _category text, _title text, _body text,
  _link text, _priority text, _action_required boolean,
  _module text, _record uuid, _event_type text, _idem text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _id uuid;
BEGIN
  IF _org IS NULL THEN RETURN NULL; END IF;
  INSERT INTO notifications (organization_id, user_id, branch_id, category, title, body, link,
                             priority, action_required, source_module, source_record_id,
                             event_type, idempotency_key)
  VALUES (_org, _user, _branch, _category, _title, coalesce(_body,''), _link,
          coalesce(_priority,'normal'), coalesce(_action_required,false), _module, _record,
          _event_type, _idem)
  ON CONFLICT DO NOTHING
  RETURNING id INTO _id;
  RETURN _id;
END $$;
REVOKE EXECUTE ON FUNCTION public.neo_notify(uuid,uuid,uuid,text,text,text,text,text,boolean,text,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_notify(uuid,uuid,uuid,text,text,text,text,text,boolean,text,uuid,text,text) TO service_role;

-- Approvals -> "approvals" / action-required for the approver
CREATE OR REPLACE FUNCTION public.neo_notify_approval()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'pending' THEN
    PERFORM public.neo_notify(NEW.organization_id, NEW.approver_id, NEW.branch_id, 'approvals',
      format('Approval required: %s', coalesce(NEW.approval_type,'request')),
      coalesce(NEW.reason, 'A request is waiting for your decision.'),
      '/approvals?request=' || NEW.id::text, 'high', true,
      'approvals', NEW.id, 'approval.requested', 'approval:' || NEW.id::text || ':requested');
  ELSIF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'pending' THEN
    PERFORM public.neo_notify(NEW.organization_id, NEW.requester_id, NEW.branch_id, 'workflow',
      format('Request %s', NEW.status),
      format('%s was %s.', coalesce(NEW.approval_type,'Your request'), NEW.status),
      '/approvals?request=' || NEW.id::text, 'normal', false,
      'approvals', NEW.id, 'approval.' || NEW.status, 'approval:' || NEW.id::text || ':' || NEW.status);
    UPDATE notifications SET status = 'resolved', acted_at = now()
      WHERE source_module = 'approvals' AND source_record_id = NEW.id AND status = 'open';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS neo_notify_approval_trg ON public.approval_requests;
CREATE TRIGGER neo_notify_approval_trg AFTER INSERT OR UPDATE ON public.approval_requests
  FOR EACH ROW EXECUTE FUNCTION public.neo_notify_approval();

-- Tasks -> "tasks" for the assignee
CREATE OR REPLACE FUNCTION public.neo_notify_task()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.assignee_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.assignee_id IS DISTINCT FROM OLD.assignee_id) THEN
    PERFORM public.neo_notify(NEW.organization_id, NEW.assignee_id, NEW.branch_id, 'tasks',
      format('Task assigned: %s', NEW.title),
      coalesce(NEW.description, 'A task has been assigned to you.'),
      '/tasks?task=' || NEW.id::text,
      CASE WHEN NEW.priority IN ('high','urgent') THEN 'high' ELSE 'normal' END, true,
      'tasks', NEW.id, 'task.assigned',
      'task:' || NEW.id::text || ':assigned:' || NEW.assignee_id::text);
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed' THEN
    UPDATE notifications SET status = 'resolved', acted_at = now()
      WHERE source_module = 'tasks' AND source_record_id = NEW.id AND status = 'open';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS neo_notify_task_trg ON public.tasks;
CREATE TRIGGER neo_notify_task_trg AFTER INSERT OR UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.neo_notify_task();
