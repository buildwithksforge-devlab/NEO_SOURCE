-- 1. Permission catalogue entries for the new Housekeeping department screens
INSERT INTO public.permissions (module, feature, action, label)
SELECT m.module, f.feature, a.action,
       initcap(a.action) || ' ' || f.feature || ' (' || m.module || ')'
FROM (VALUES ('housekeeping')) AS m(module),
     (VALUES ('my-work'), ('supplies'), ('requisitions')) AS f(feature),
     (VALUES ('view'), ('create'), ('edit')) AS a(action)
WHERE NOT EXISTS (
  SELECT 1 FROM public.permissions p
  WHERE p.module = m.module AND p.feature = f.feature AND p.action = a.action
);

-- 2. Housekeeper: own work, supply reporting, lost & found only.
DELETE FROM public.role_feature_templates
WHERE role_key = 'housekeeper'
  AND module = 'housekeeping'
  AND feature IN ('board', 'tasks', 'overview');

INSERT INTO public.role_feature_templates (role_key, module, feature, action)
SELECT 'housekeeper', 'housekeeping', f.feature, a.action
FROM (VALUES ('my-work'), ('supplies')) AS f(feature),
     (VALUES ('view'), ('create'), ('edit')) AS a(action)
WHERE NOT EXISTS (
  SELECT 1 FROM public.role_feature_templates t
  WHERE t.role_key = 'housekeeper' AND t.module = 'housekeeping'
    AND t.feature = f.feature AND t.action = a.action
);

-- 3. Stock-need notification link follows the reporting department.
CREATE OR REPLACE FUNCTION public.neo_department_stock_need_create(
  _item text,
  _quantity numeric DEFAULT 1,
  _unit text DEFAULT 'unit'::text,
  _priority text DEFAULT 'normal'::text,
  _notes text DEFAULT NULL::text,
  _module text DEFAULT 'front-office'::text,
  _department uuid DEFAULT NULL::uuid,
  _branch uuid DEFAULT NULL::uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _id uuid; _branch_final uuid; _dept uuid; _link text;
BEGIN
  IF _org IS NULL OR NOT public.is_active_staff() THEN
    RAISE EXCEPTION 'Only active staff can report a stock need';
  END IF;
  IF coalesce(btrim(_item), '') = '' THEN RAISE EXCEPTION 'Describe the item you need'; END IF;
  IF coalesce(_quantity, 0) <= 0 THEN RAISE EXCEPTION 'Quantity must be greater than zero'; END IF;

  SELECT coalesce(_branch, p.branch_id) INTO _branch_final
  FROM public.profiles p WHERE p.id = auth.uid();

  SELECT coalesce(_department, p.department_id) INTO _dept
  FROM public.profiles p WHERE p.id = auth.uid();

  INSERT INTO public.department_stock_needs (
    organization_id, branch_id, department_id, module, item, quantity, unit, priority, notes, requested_by
  ) VALUES (
    _org, _branch_final, _dept, coalesce(_module, 'front-office'), btrim(_item), _quantity,
    coalesce(nullif(btrim(_unit), ''), 'unit'), coalesce(nullif(btrim(_priority), ''), 'normal'),
    nullif(btrim(_notes), ''), auth.uid()
  ) RETURNING id INTO _id;

  _link := CASE coalesce(_module, 'front-office')
             WHEN 'housekeeping' THEN '/housekeeping/supplies'
             ELSE '/pms/requisitions'
           END;

  INSERT INTO public.notifications (organization_id, branch_id, category, title, body, link)
  VALUES (_org, _branch_final, 'operations', 'Stock need reported',
    btrim(_item) || ' — ' || _quantity::text || ' ' || coalesce(_unit, 'unit'),
    _link);

  RETURN _id;
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_department_stock_need_create(text, numeric, text, text, text, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_department_stock_need_create(text, numeric, text, text, text, text, uuid, uuid) TO authenticated;