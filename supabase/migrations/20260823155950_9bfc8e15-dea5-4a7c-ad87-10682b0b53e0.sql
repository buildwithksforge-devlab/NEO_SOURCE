-- Maintenance work-order lifecycle: record the real timestamps for each state
-- change and mirror the change into the central audit trail. Without this,
-- completion time was never stored, so "completed today" and downtime
-- reporting could not be derived from the record.
CREATE OR REPLACE FUNCTION public.wo_stamp_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'accepted' AND NEW.accepted_at IS NULL THEN
      NEW.accepted_at := now();
    END IF;
    IF NEW.status IN ('completed', 'awaiting-verification') AND NEW.completed_at IS NULL THEN
      NEW.completed_at := now();
    END IF;
    IF NEW.status = 'closed' THEN
      NEW.completed_at := COALESCE(NEW.completed_at, now());
      NEW.closed_at := COALESCE(NEW.closed_at, now());
    END IF;
    IF NEW.status = 'reopened' THEN
      NEW.completed_at := NULL;
      NEW.closed_at := NULL;
      NEW.verified_at := NULL;
      NEW.verified_by := NULL;
    END IF;
    IF NEW.completed_at IS NOT NULL AND NEW.downtime_minutes IS NULL THEN
      NEW.downtime_minutes := GREATEST(0, (EXTRACT(EPOCH FROM (NEW.completed_at - NEW.reported_at)) / 60)::int);
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_wo_stamp_lifecycle ON public.maintenance_work_orders;
CREATE TRIGGER trg_wo_stamp_lifecycle
BEFORE UPDATE ON public.maintenance_work_orders
FOR EACH ROW EXECUTE FUNCTION public.wo_stamp_lifecycle();

CREATE OR REPLACE FUNCTION public.wo_track_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _actor text;
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO work_order_status_history (organization_id, work_order_id, previous_status, new_status, changed_by)
    VALUES (NEW.organization_id, NEW.id, CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.status END, NEW.status, auth.uid());

    SELECT COALESCE(full_name, email, 'System') INTO _actor FROM public.profiles WHERE id = auth.uid();

    INSERT INTO public.audit_logs (
      organization_id, branch_id, department_id, user_id, user_name,
      action, module, record_id, previous_value, new_value
    ) VALUES (
      NEW.organization_id, NEW.branch_id, NEW.requesting_department_id, auth.uid(), COALESCE(_actor, 'System'),
      CASE WHEN TG_OP = 'INSERT' THEN 'work-order.raised' ELSE 'work-order.' || NEW.status END,
      'maintenance', NEW.id::text,
      CASE WHEN TG_OP = 'INSERT' THEN NULL
           ELSE jsonb_build_object('status', OLD.status, 'assigned_to', OLD.assigned_to, 'block_status', OLD.block_status) END,
      jsonb_build_object(
        'work_order_number', NEW.work_order_number,
        'status', NEW.status,
        'assigned_to', NEW.assigned_to,
        'block_status', NEW.block_status,
        'room_id', NEW.room_id,
        'completed_at', NEW.completed_at
      )
    );
  END IF;
  RETURN NEW;
END
$$;
