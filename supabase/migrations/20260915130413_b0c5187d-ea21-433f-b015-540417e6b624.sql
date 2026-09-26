CREATE OR REPLACE FUNCTION public.log_audit_event(
  _organization uuid,
  _action text,
  _module text,
  _record_id text,
  _previous jsonb,
  _new jsonb,
  _reason text DEFAULT ''::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _id uuid;
BEGIN
  -- Organisation is resolved from the caller's session by the canonical
  -- logger; the parameter is accepted for callers that pass it explicitly.
  _id := public.log_audit_event(
    _action := _action,
    _module := _module,
    _record_id := _record_id,
    _previous := _previous,
    _new := _new,
    _reason := COALESCE(_reason, '')
  );
  RETURN _id;
END;
$function$;

REVOKE ALL ON FUNCTION public.log_audit_event(uuid, text, text, text, jsonb, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_audit_event(uuid, text, text, text, jsonb, jsonb, text) TO authenticated, service_role;