-- 1. Permanent reporting rule -------------------------------------------------
UPDATE public.role_catalogue
   SET reports_to_role_keys = ARRAY['operations-manager']
 WHERE managerial_scope = 'department'
   AND management_level >= 60
   AND role_key <> 'operations-manager';

UPDATE public.role_catalogue
   SET reports_to_role_keys = ARRAY['owner']
 WHERE role_key = 'operations-manager';

-- No reporting line may point at the removed General Manager role.
UPDATE public.role_catalogue
   SET reports_to_role_keys = (
     SELECT COALESCE(array_agg(k), '{}')
       FROM unnest(reports_to_role_keys) k
      WHERE k <> 'general-manager'
   )
 WHERE 'general-manager' = ANY(reports_to_role_keys);

UPDATE public.roles
   SET reports_to_role_keys = NULL
 WHERE reports_to_role_keys IS NOT NULL
   AND 'general-manager' = ANY(reports_to_role_keys);

-- 2. Automatic recommendation --------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_recommended_reporting_manager(
  _user uuid,
  _branch uuid DEFAULT NULL,
  _department uuid DEFAULT NULL,
  _station uuid DEFAULT NULL,
  _role_ids uuid[] DEFAULT NULL
) RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.profile_id
    FROM public.neo_reporting_candidates(_user, _branch, _department, _station, _role_ids) c
   ORDER BY CASE WHEN c.property_match = 'property' THEN 0 ELSE 1 END,
            c.management_level DESC,
            c.full_name
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.neo_recommended_reporting_manager(uuid, uuid, uuid, uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_recommended_reporting_manager(uuid, uuid, uuid, uuid, uuid[]) TO authenticated;

-- 3. Assign the reporting line automatically on role grant/transfer -------------
CREATE OR REPLACE FUNCTION public.neo_apply_reporting_rule()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _profile public.profiles;
  _roles uuid[];
  _manager uuid;
BEGIN
  SELECT * INTO _profile FROM public.profiles WHERE id = NEW.user_id;
  IF _profile.id IS NULL OR _profile.account_type <> 'staff' THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(array_agg(ur.role_id), '{}') INTO _roles
    FROM public.user_roles ur WHERE ur.user_id = NEW.user_id;

  -- Only fill a line that is missing or now invalid; never silently rewrite a
  -- deliberate, still-eligible assignment.
  IF _profile.reporting_manager_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.neo_reporting_candidate_rows(
         _profile.organization_id, NEW.user_id, _profile.branch_id, _roles) c
        WHERE c.profile_id = _profile.reporting_manager_id
     ) THEN
    RETURN NEW;
  END IF;

  SELECT c.profile_id INTO _manager
    FROM public.neo_reporting_candidate_rows(
      _profile.organization_id, NEW.user_id, _profile.branch_id, _roles) c
   ORDER BY CASE WHEN c.property_match = 'property' THEN 0 ELSE 1 END,
            c.management_level DESC,
            c.full_name
   LIMIT 1;

  IF _manager IS NULL OR _manager = _profile.reporting_manager_id THEN
    RETURN NEW;
  END IF;

  UPDATE public.profiles
     SET reporting_manager_id = _manager, updated_at = now()
   WHERE id = NEW.user_id;

  INSERT INTO public.audit_logs (organization_id, branch_id, action, module, actor_id,
    record_id, previous_value, new_value, reason)
  VALUES (_profile.organization_id, _profile.branch_id, 'users.reporting_line.auto_assign',
    'administration', auth.uid(), NEW.user_id::text,
    jsonb_build_object('reporting_manager_id', _profile.reporting_manager_id),
    jsonb_build_object('reporting_manager_id', _manager),
    'Applied the standing reporting rule for the granted role');

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS neo_apply_reporting_rule_trg ON public.user_roles;
CREATE TRIGGER neo_apply_reporting_rule_trg
AFTER INSERT OR UPDATE OF role_id ON public.user_roles
FOR EACH ROW EXECUTE FUNCTION public.neo_apply_reporting_rule();

-- 4. Reservation lifecycle history (immutable) ---------------------------------
CREATE OR REPLACE FUNCTION public.neo_reservation_status_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.reservation_history (organization_id, reservation_id, action, field,
      previous_value, new_value, reason, changed_by)
    VALUES (NEW.organization_id, NEW.id,
      CASE NEW.status
        WHEN 'checked-in' THEN 'checked-in'
        WHEN 'checked-out' THEN 'checked-out'
        WHEN 'cancelled' THEN 'cancelled'
        WHEN 'no-show' THEN 'no-show'
        ELSE 'status-changed'
      END,
      'status', OLD.status, NEW.status,
      CASE NEW.status
        WHEN 'checked-in' THEN 'Guest checked in'
        WHEN 'checked-out' THEN 'Guest checked out'
        ELSE NULL
      END,
      auth.uid());
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS neo_reservation_status_history_trg ON public.reservations;
CREATE TRIGGER neo_reservation_status_history_trg
AFTER UPDATE OF status ON public.reservations
FOR EACH ROW EXECUTE FUNCTION public.neo_reservation_status_history();

CREATE OR REPLACE FUNCTION public.neo_reservation_history_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Reservation history is immutable';
END;
$$;

DROP TRIGGER IF EXISTS neo_reservation_history_immutable_trg ON public.reservation_history;
CREATE TRIGGER neo_reservation_history_immutable_trg
BEFORE UPDATE OR DELETE ON public.reservation_history
FOR EACH ROW EXECUTE FUNCTION public.neo_reservation_history_immutable();