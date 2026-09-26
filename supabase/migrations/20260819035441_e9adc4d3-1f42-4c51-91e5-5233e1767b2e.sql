-- Stage 3: durable, atomic document references
ALTER TABLE public.number_sequences
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS number_sequences_org_doc_branch_idx
  ON public.number_sequences (organization_id, doc_type, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE OR REPLACE FUNCTION public.next_document_number(_doc_type text, _prefix text DEFAULT NULL, _branch uuid DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _year int := extract(year from now())::int;
  _pfx text := upper(coalesce(nullif(_prefix,''), left(regexp_replace(_doc_type,'[^A-Za-z]','','g'), 3)));
  _code text;
  _row public.number_sequences;
BEGIN
  IF _org IS NULL THEN
    RAISE EXCEPTION 'No active organization for the current user';
  END IF;

  INSERT INTO public.number_sequences (organization_id, doc_type, branch_id, prefix, year, padding, next_number)
  VALUES (_org, _doc_type, _branch, _pfx, _year, 6, 1)
  ON CONFLICT (organization_id, doc_type, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
  DO UPDATE SET
    next_number = CASE WHEN public.number_sequences.year = _year
                       THEN public.number_sequences.next_number + 1 ELSE 1 END,
    year = _year,
    updated_at = now()
  RETURNING * INTO _row;

  IF _row.branch_id IS NOT NULL THEN
    SELECT upper(code) INTO _code FROM public.branches WHERE id = _row.branch_id;
  END IF;

  RETURN _row.prefix
    || CASE WHEN _code IS NULL OR _code = '' THEN '' ELSE '-' || _code END
    || '-' || _row.year::text
    || '-' || lpad(_row.next_number::text, greatest(_row.padding, 4), '0');
END;
$function$;

REVOKE ALL ON FUNCTION public.next_document_number(text, text, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.next_document_number(text, text, uuid) TO authenticated;

-- Stage 4: canonical module.feature.action permission registry (additive; '*' means module-wide)
ALTER TABLE public.permissions
  ADD COLUMN IF NOT EXISTS feature text NOT NULL DEFAULT '*';

CREATE UNIQUE INDEX IF NOT EXISTS permissions_module_feature_action_idx
  ON public.permissions (module, feature, action);

-- Stage 6: single effective-access resolver used by both the UI and RLS
CREATE OR REPLACE FUNCTION public.has_permission(_module text, _feature text, _action text)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM public.user_permissions up
      JOIN public.permissions p ON p.id = up.permission_id
      WHERE up.user_id = auth.uid() AND up.effect = 'deny'
        AND p.module = _module AND p.action = _action
        AND p.feature IN (_feature, '*')
        AND up.organization_id = public.current_org_id()
    ) THEN false
    WHEN public.is_org_admin() THEN true
    ELSE EXISTS (
      SELECT 1 FROM public.user_roles ur
      JOIN public.roles r ON r.id = ur.role_id AND r.active
      JOIN public.role_permissions rp ON rp.role_id = r.id
      JOIN public.permissions p ON p.id = rp.permission_id
      WHERE ur.user_id = auth.uid()
        AND p.module = _module AND p.action = _action
        AND p.feature IN (_feature, '*')
        AND ur.organization_id = public.current_org_id()
        AND r.organization_id = public.current_org_id()
        AND rp.organization_id = public.current_org_id()
    ) OR EXISTS (
      SELECT 1 FROM public.user_permissions up
      JOIN public.permissions p ON p.id = up.permission_id
      WHERE up.user_id = auth.uid() AND up.effect = 'grant'
        AND p.module = _module AND p.action = _action
        AND p.feature IN (_feature, '*')
        AND up.organization_id = public.current_org_id()
    )
  END;
$function$;

REVOKE ALL ON FUNCTION public.has_permission(text, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.has_permission(text, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.my_effective_permissions()
RETURNS TABLE(module text, feature text, action text)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH org AS (SELECT public.current_org_id() AS id),
  denied AS (
    SELECT p.id FROM public.user_permissions up
    JOIN public.permissions p ON p.id = up.permission_id
    WHERE up.user_id = auth.uid() AND up.effect = 'deny'
      AND up.organization_id = (SELECT id FROM org)
  ),
  base AS (
    SELECT p.id, p.module, p.feature, p.action
    FROM public.permissions p
    WHERE public.is_org_admin()
    UNION
    SELECT p.id, p.module, p.feature, p.action
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id AND r.active
    JOIN public.role_permissions rp ON rp.role_id = r.id
    JOIN public.permissions p ON p.id = rp.permission_id
    WHERE ur.user_id = auth.uid()
      AND ur.organization_id = (SELECT id FROM org)
      AND r.organization_id = (SELECT id FROM org)
      AND rp.organization_id = (SELECT id FROM org)
    UNION
    SELECT p.id, p.module, p.feature, p.action
    FROM public.user_permissions up
    JOIN public.permissions p ON p.id = up.permission_id
    WHERE up.user_id = auth.uid() AND up.effect = 'grant'
      AND up.organization_id = (SELECT id FROM org)
  )
  SELECT b.module, b.feature, b.action
  FROM base b
  WHERE b.id NOT IN (SELECT id FROM denied);
$function$;

REVOKE ALL ON FUNCTION public.my_effective_permissions() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.my_effective_permissions() TO authenticated;