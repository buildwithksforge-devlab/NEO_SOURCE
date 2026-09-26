-- Reason strings were appended to a text[] as untyped literals, which Postgres
-- parsed as array literals ("malformed array literal"). Every leave entitlement
-- sync and application failed. Cast each reason to text so array_append is used.
CREATE OR REPLACE FUNCTION public.neo_hr_leave_applicability(_employee uuid, _leave_type uuid, _on date DEFAULT CURRENT_DATE)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := current_org_id();
  _emp public.employees;
  _lt public.leave_types;
  _service_days numeric;
  _reasons text[] := '{}';
  _gender text;
BEGIN
  SELECT * INTO _emp FROM public.employees WHERE id = _employee AND organization_id = _org;
  SELECT * INTO _lt FROM public.leave_types WHERE id = _leave_type AND organization_id = _org;
  IF _emp.id IS NULL OR _lt.id IS NULL THEN
    RETURN jsonb_build_object('eligible', false, 'reasons', to_jsonb(ARRAY['Record not found in this organisation']));
  END IF;

  IF NOT _lt.active THEN
    _reasons := _reasons || 'This leave policy is not active'::text;
  END IF;

  IF _lt.effective_from IS NOT NULL AND _on < _lt.effective_from THEN
    _reasons := _reasons || format('This policy starts on %s', to_char(_lt.effective_from, 'DD Mon YYYY'));
  END IF;
  IF _lt.effective_to IS NOT NULL AND _on > _lt.effective_to THEN
    _reasons := _reasons || format('This policy ended on %s', to_char(_lt.effective_to, 'DD Mon YYYY'));
  END IF;

  IF _lt.branch_id IS NOT NULL AND _emp.branch_id IS NOT NULL AND _lt.branch_id <> _emp.branch_id THEN
    _reasons := _reasons || 'This policy applies to another property'::text;
  END IF;

  IF array_length(_lt.department_ids, 1) IS NOT NULL
     AND NOT (_emp.department_id IS NOT NULL AND _emp.department_id = ANY (_lt.department_ids)) THEN
    _reasons := _reasons || 'This policy applies to selected departments only'::text;
  END IF;

  IF array_length(_lt.employment_types, 1) IS NOT NULL
     AND NOT (COALESCE(NULLIF(lower(_emp.employment_type::text), ''), 'unset') = ANY (
        SELECT lower(t) FROM unnest(_lt.employment_types) t)) THEN
    _reasons := _reasons || 'This policy applies to selected employment types only'::text;
  END IF;

  IF COALESCE(lower(_lt.gender_scope), 'any') <> 'any' THEN
    _gender := NULLIF(lower(COALESCE(_emp.gender::text, '')), '');
    IF _gender IS NULL THEN
      _reasons := _reasons || 'This policy applies to a specific sex; the employee record does not record one'::text;
    ELSIF _gender <> lower(_lt.gender_scope) THEN
      _reasons := _reasons || format('This policy applies to %s employees only', lower(_lt.gender_scope));
    END IF;
  END IF;

  _service_days := GREATEST(0, _on - COALESCE(_emp.employment_date, _on));
  IF _lt.minimum_service_days > 0 AND _service_days < _lt.minimum_service_days THEN
    _reasons := _reasons || format('Requires %s day(s) of service', _lt.minimum_service_days);
  END IF;

  RETURN jsonb_build_object(
    'eligible', array_length(_reasons, 1) IS NULL,
    'reasons', to_jsonb(_reasons),
    'service_days', _service_days
  );
END;
$function$;