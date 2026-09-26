
ALTER TABLE public.audit_logs
  ADD COLUMN IF NOT EXISTS station_id uuid,
  ADD COLUMN IF NOT EXISTS role_names text[],
  ADD COLUMN IF NOT EXISTS permission_used text,
  ADD COLUMN IF NOT EXISTS correlation_id uuid,
  ADD COLUMN IF NOT EXISTS delegation_context jsonb;

CREATE OR REPLACE FUNCTION public.log_audit_event(
  _action text,
  _module text DEFAULT 'administration',
  _record_id text DEFAULT NULL,
  _previous jsonb DEFAULT NULL,
  _new jsonb DEFAULT NULL,
  _reason text DEFAULT NULL,
  _permission_used text DEFAULT NULL,
  _branch uuid DEFAULT NULL,
  _department uuid DEFAULT NULL,
  _station uuid DEFAULT NULL,
  _correlation uuid DEFAULT NULL,
  _delegation jsonb DEFAULT NULL,
  _device text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _actor uuid := auth.uid();
  _name text;
  _roles text[];
  _id uuid;
BEGIN
  IF _actor IS NULL OR _org IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT p.full_name, coalesce(_branch, p.branch_id), coalesce(_department, p.department_id)
    INTO _name, _branch, _department
  FROM public.profiles p WHERE p.id = _actor;

  SELECT array_agg(DISTINCT r.name) INTO _roles
  FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
  WHERE ur.user_id = _actor;

  INSERT INTO public.audit_logs (
    organization_id, branch_id, department_id, station_id, user_id, user_name,
    action, module, record_id, previous_value, new_value, reason, device,
    role_names, permission_used, correlation_id, delegation_context
  ) VALUES (
    _org, _branch, _department, _station, _actor, coalesce(_name, ''),
    _action, coalesce(_module, 'administration'), _record_id, _previous, _new, _reason, _device,
    _roles, _permission_used, coalesce(_correlation, gen_random_uuid()), _delegation
  ) RETURNING id INTO _id;

  RETURN _id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.log_audit_event(text, text, text, jsonb, jsonb, text, text, uuid, uuid, uuid, uuid, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_audit_event(text, text, text, jsonb, jsonb, text, text, uuid, uuid, uuid, uuid, jsonb, text) TO authenticated;
