-- Group 3 / Stages 9-12: durable, idempotent, correctly-targeted notifications

ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS notifications_idem_idx
  ON public.notifications (organization_id, user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Fan-out helper: only active staff of the same organization receive a
-- notification, optionally narrowed to a property and/or department.
-- Re-running with the same idempotency key never duplicates.
CREATE OR REPLACE FUNCTION public.notify_recipients(
  _category text,
  _title text,
  _body text DEFAULT '',
  _link text DEFAULT NULL,
  _priority text DEFAULT 'normal',
  _branch uuid DEFAULT NULL,
  _department uuid DEFAULT NULL,
  _role_names text[] DEFAULT NULL,
  _idem text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _count int := 0;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'No active organization for the current user'; END IF;

  INSERT INTO public.notifications
    (organization_id, user_id, branch_id, department_id, category, title, body, link, priority, idempotency_key)
  SELECT _org, p.id, coalesce(_branch, p.branch_id), coalesce(_department, p.department_id),
         _category, _title, coalesce(_body, ''), _link, coalesce(_priority, 'normal'), _idem
  FROM public.profiles p
  WHERE p.organization_id = _org
    AND coalesce(p.account_type, 'staff') = 'staff'
    AND coalesce(p.account_status, 'active') = 'active'
    AND (_branch IS NULL OR p.branch_id IS NULL OR p.branch_id = _branch)
    AND (_department IS NULL OR p.department_id = _department)
    AND (
      _role_names IS NULL OR EXISTS (
        SELECT 1 FROM public.user_roles ur
        JOIN public.roles r ON r.id = ur.role_id AND r.active
        WHERE ur.user_id = p.id AND ur.organization_id = _org AND r.name = ANY (_role_names)
      )
    )
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS _count = ROW_COUNT;
  RETURN _count;
END;
$function$;

REVOKE ALL ON FUNCTION public.notify_recipients(text, text, text, text, text, uuid, uuid, text[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.notify_recipients(text, text, text, text, text, uuid, uuid, text[], text) TO authenticated, service_role;

-- External messages stay queued when a provider is unavailable: a failed
-- attempt below max_attempts returns to 'queued' with a backoff instead of
-- being dropped.
CREATE OR REPLACE FUNCTION public.communication_queue_retry_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status = 'failed' AND NEW.attempt_count < NEW.max_attempts THEN
    NEW.status := 'queued';
    NEW.scheduled_for := now() + (power(3, greatest(NEW.attempt_count, 1)) || ' minutes')::interval;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS communication_queue_retry ON public.communication_queue;
CREATE TRIGGER communication_queue_retry
BEFORE UPDATE ON public.communication_queue
FOR EACH ROW EXECUTE FUNCTION public.communication_queue_retry_guard();

REVOKE ALL ON FUNCTION public.communication_queue_retry_guard() FROM PUBLIC, anon, authenticated;