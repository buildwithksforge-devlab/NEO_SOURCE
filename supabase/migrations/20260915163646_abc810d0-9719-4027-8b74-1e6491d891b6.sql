-- 1. Attendance tolerance wiring: apply configured grace before flagging lateness.
CREATE OR REPLACE FUNCTION public.hr_apply_attendance_tolerance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _grace integer;
  _early integer;
  _miss integer;
  _raw integer;
BEGIN
  SELECT COALESCE(s.late_threshold_minutes, 0), COALESCE(s.early_clock_in_minutes, 0), COALESCE(s.missed_clock_out_hours, 0)
    INTO _grace, _early, _miss
    FROM public.hr_settings s
   WHERE s.organization_id = NEW.organization_id
   LIMIT 1;

  IF _grace IS NULL THEN
    RETURN NEW;
  END IF;

  -- lateness only when a scheduled start exists and lateness was not entered manually
  IF NEW.scheduled_start IS NOT NULL AND NEW.clock_in_at IS NOT NULL
     AND COALESCE(NEW.late_minutes, 0) = 0 THEN
    _raw := GREATEST(0, CEIL(EXTRACT(epoch FROM (NEW.clock_in_at - NEW.scheduled_start)) / 60.0)::int);
    NEW.late_minutes := GREATEST(0, _raw - _grace);
  END IF;

  IF NEW.scheduled_end IS NOT NULL AND NEW.clock_out_at IS NOT NULL
     AND COALESCE(NEW.early_departure_minutes, 0) = 0 THEN
    NEW.early_departure_minutes :=
      GREATEST(0, CEIL(EXTRACT(epoch FROM (NEW.scheduled_end - NEW.clock_out_at)) / 60.0)::int);
  END IF;

  IF NEW.clock_in_at IS NOT NULL AND NEW.clock_out_at IS NULL AND _miss > 0
     AND now() - NEW.clock_in_at > make_interval(hours => _miss) THEN
    NEW.exception := COALESCE(NEW.exception, 'missed_clock_out');
  ELSIF COALESCE(NEW.late_minutes, 0) > 0 AND NEW.exception IS NULL THEN
    NEW.exception := 'late';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS attendance_records_tolerance ON public.attendance_records;
CREATE TRIGGER attendance_records_tolerance
BEFORE INSERT OR UPDATE ON public.attendance_records
FOR EACH ROW EXECUTE FUNCTION public.hr_apply_attendance_tolerance();

-- 2. Leave year wiring: entitlement periods follow the configured leave-year start month.
CREATE OR REPLACE FUNCTION public.hr_leave_year_of(_org uuid, _on date)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT CASE
    WHEN EXTRACT(month FROM _on)::int < COALESCE((SELECT s.leave_year_start_month FROM public.hr_settings s WHERE s.organization_id = _org LIMIT 1), 1)
      THEN EXTRACT(year FROM _on)::int - 1
    ELSE EXTRACT(year FROM _on)::int
  END;
$$;

REVOKE ALL ON FUNCTION public.hr_leave_year_of(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hr_leave_year_of(uuid, date) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.hr_apply_attendance_tolerance() FROM PUBLIC, anon;