CREATE OR REPLACE FUNCTION public.neo_rider_lifecycle_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE _title text; _body text; _event text; _key text;
BEGIN
  IF NEW.profile_id IS NULL THEN RETURN NEW; END IF;

  IF TG_OP = 'INSERT' THEN
    _title := 'You are on the delivery roster';
    _body  := 'Rider code ' || coalesce(NEW.rider_code, '—');
    _event := 'delivery.rider.enrolled';
    _key   := 'delivery.rider.enrol:' || NEW.id::text || ':' || coalesce(NEW.rider_code, '');
  ELSIF coalesce(OLD.active, false) IS DISTINCT FROM coalesce(NEW.active, false) THEN
    IF NEW.active THEN
      _title := 'You are back on the delivery roster';
      _body  := 'Rider code ' || coalesce(NEW.rider_code, '—');
      _event := 'delivery.rider.reinstated';
      _key   := 'delivery.rider.reinstate:' || NEW.id::text || ':' || to_char(now(),'YYYYMMDDHH24MI');
    ELSE
      _title := 'You have been retired from the delivery roster';
      _body  := 'You will not receive new delivery assignments.';
      _event := 'delivery.rider.retired';
      _key   := 'delivery.rider.retire:' || NEW.id::text || ':' || to_char(now(),'YYYYMMDDHH24MI');
    END IF;
  ELSIF coalesce(OLD.rider_code,'') IS DISTINCT FROM coalesce(NEW.rider_code,'') THEN
    _title := 'Your rider code changed';
    _body  := 'New rider code ' || coalesce(NEW.rider_code, '—');
    _event := 'delivery.rider.code_changed';
    _key   := 'delivery.rider.code:' || NEW.id::text || ':' || coalesce(NEW.rider_code,'');
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO public.notifications
    (organization_id, branch_id, user_id, category, title, body, link,
     source_module, source_record_id, event_type, idempotency_key)
  VALUES (NEW.organization_id, NEW.branch_id, NEW.profile_id, 'operations',
    _title, _body, '/rider', 'delivery', NEW.id, _event, _key)
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS neo_rider_lifecycle_notify_trg ON public.rider_profiles;
CREATE TRIGGER neo_rider_lifecycle_notify_trg
AFTER INSERT OR UPDATE ON public.rider_profiles
FOR EACH ROW EXECUTE FUNCTION public.neo_rider_lifecycle_notify();

CREATE OR REPLACE FUNCTION public.neo_rider_shift_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE _profile uuid; _branch uuid;
BEGIN
  SELECT rp.profile_id, rp.branch_id INTO _profile, _branch
    FROM public.rider_profiles rp WHERE rp.id = NEW.rider_id;
  IF _profile IS NULL THEN RETURN NEW; END IF;

  INSERT INTO public.notifications
    (organization_id, branch_id, user_id, category, title, body, link,
     source_module, source_record_id, event_type, idempotency_key)
  VALUES (NEW.organization_id, _branch, _profile, 'operations',
    'Delivery shift scheduled',
    to_char(NEW.starts_at, 'DD Mon HH24:MI') || ' — ' || to_char(NEW.ends_at, 'HH24:MI'),
    '/rider', 'delivery', NEW.id, 'delivery.rider.shift_scheduled',
    'delivery.rider.shift:' || NEW.id::text || ':' || to_char(NEW.starts_at,'YYYYMMDDHH24MI'))
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS neo_rider_shift_notify_trg ON public.rider_shifts;
CREATE TRIGGER neo_rider_shift_notify_trg
AFTER INSERT ON public.rider_shifts
FOR EACH ROW EXECUTE FUNCTION public.neo_rider_shift_notify();

REVOKE EXECUTE ON FUNCTION public.neo_rider_lifecycle_notify() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.neo_rider_shift_notify() FROM PUBLIC, anon, authenticated;