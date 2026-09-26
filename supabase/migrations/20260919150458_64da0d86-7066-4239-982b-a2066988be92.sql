
CREATE OR REPLACE FUNCTION public.neo_rbac_baseline_open(_label text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE _run uuid;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'platform maintenance routine' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.rbac_baseline_runs(label) VALUES (_label) RETURNING id INTO _run;
  RETURN _run;
END;
$$;
REVOKE ALL ON FUNCTION public.neo_rbac_baseline_open(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_rbac_baseline_open(text) TO service_role;

CREATE OR REPLACE FUNCTION public.neo_rbac_baseline_capture_org(_run uuid, _org uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE _res jsonb;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'platform maintenance routine' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.rbac_baseline_roles
    (run_id, organization_id, role_id, role_name, normalized_role_key, template_key,
     is_system, active, access_scope, branch_scope, station_scope, department_id,
     approval_class, permission_count, permission_fingerprint)
  SELECT _run, r.organization_id, r.id, r.name, r.normalized_role_key,
         public.neo_resolve_role_template_key(r.normalized_role_key, r.name),
         coalesce(r.is_system,false), coalesce(r.active,true), r.access_scope,
         r.branch_scope, r.station_scope, r.department_id, r.approval_class,
         coalesce(x.n,0), x.fp
  FROM public.roles r
  LEFT JOIN LATERAL (
    SELECT count(*) AS n,
           md5(string_agg(p.module||'.'||p.feature||'.'||p.action, ',' ORDER BY p.module,p.feature,p.action)) AS fp
    FROM public.role_permissions rp JOIN public.permissions p ON p.id=rp.permission_id
    WHERE rp.role_id = r.id
  ) x ON true
  WHERE r.organization_id = _org
  ON CONFLICT DO NOTHING;

  INSERT INTO public.rbac_baseline_role_permissions
    (run_id, organization_id, role_id, permission_id, template_key, module, feature, action, source, classification)
  SELECT _run, rp.organization_id, rp.role_id, rp.permission_id, br.template_key,
         p.module, p.feature, p.action, rp.source,
         CASE
           WHEN br.template_key IS NULL THEN 'untemplated'
           WHEN rp.source <> 'template' THEN 'added'
           WHEN EXISTS (SELECT 1 FROM public.role_feature_templates ft
                        WHERE ft.role_key = br.template_key AND ft.module=p.module
                          AND ft.feature=p.feature AND ft.action=p.action) THEN 'default'
           ELSE 'added'
         END
  FROM public.role_permissions rp
  JOIN public.permissions p ON p.id = rp.permission_id
  JOIN public.rbac_baseline_roles br ON br.run_id=_run AND br.role_id=rp.role_id
  WHERE rp.organization_id = _org
  ON CONFLICT DO NOTHING;

  INSERT INTO public.rbac_baseline_template_omissions
    (run_id, organization_id, role_id, template_key, module, feature, action)
  SELECT _run, br.organization_id, br.role_id, br.template_key, ft.module, ft.feature, ft.action
  FROM public.rbac_baseline_roles br
  JOIN public.role_feature_templates ft ON ft.role_key = br.template_key
  WHERE br.run_id=_run AND br.organization_id=_org AND br.template_key IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.rbac_baseline_role_permissions brp
                    WHERE brp.run_id=_run AND brp.role_id=br.role_id
                      AND brp.module=ft.module AND brp.feature=ft.feature AND brp.action=ft.action);

  INSERT INTO public.rbac_baseline_assignments
    (run_id, organization_id, user_id, role_id, branch_id, kind, is_primary)
  SELECT _run, ur.organization_id, ur.user_id, ur.role_id, NULL, 'role', coalesce(ur.is_primary,false)
  FROM public.user_roles ur WHERE ur.organization_id=_org
  UNION ALL
  SELECT _run, ub.organization_id, ub.user_id, NULL, ub.branch_id, 'branch', false
  FROM public.user_branches ub WHERE ub.organization_id=_org;

  INSERT INTO public.rbac_baseline_effective_access
    (run_id, organization_id, user_id, module, feature, action, effect, source, branch_ids)
  SELECT _run, x.organization_id, x.user_id, x.module, x.feature, x.action, x.effect,
         string_agg(DISTINCT x.source,'+' ORDER BY x.source),
         coalesce((SELECT array_agg(DISTINCT ub.branch_id) FROM public.user_branches ub
                    WHERE ub.user_id=x.user_id AND ub.organization_id=x.organization_id),'{}')
  FROM (
    SELECT ur.organization_id, ur.user_id, p.module, p.feature, p.action,
           'grant'::text AS effect, 'role:'||coalesce(r.normalized_role_key,r.name) AS source
    FROM public.user_roles ur
    JOIN public.roles r ON r.id=ur.role_id AND coalesce(r.active,true)
    JOIN public.role_permissions rp ON rp.role_id=r.id
    JOIN public.permissions p ON p.id=rp.permission_id
    WHERE ur.organization_id=_org AND r.organization_id=_org AND rp.organization_id=_org
    UNION ALL
    SELECT up.organization_id, up.user_id, p.module, p.feature, p.action, up.effect, 'user-override'
    FROM public.user_permissions up JOIN public.permissions p ON p.id=up.permission_id
    WHERE up.organization_id=_org
  ) x
  GROUP BY x.organization_id, x.user_id, x.module, x.feature, x.action, x.effect
  ON CONFLICT DO NOTHING;

  SELECT jsonb_build_object(
    'organization_id', _org,
    'roles', (SELECT count(*) FROM public.rbac_baseline_roles WHERE run_id=_run AND organization_id=_org),
    'role_permissions', (SELECT count(*) FROM public.rbac_baseline_role_permissions WHERE run_id=_run AND organization_id=_org),
    'effective_rows', (SELECT count(*) FROM public.rbac_baseline_effective_access WHERE run_id=_run AND organization_id=_org)
  ) INTO _res;
  RETURN _res;
END;
$$;
REVOKE ALL ON FUNCTION public.neo_rbac_baseline_capture_org(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_rbac_baseline_capture_org(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.neo_rbac_baseline_close(_run uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE _stats jsonb;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'platform maintenance routine' USING ERRCODE = '42501';
  END IF;
  SELECT jsonb_build_object(
    'roles',(SELECT count(*) FROM public.rbac_baseline_roles WHERE run_id=_run),
    'role_permissions',(SELECT count(*) FROM public.rbac_baseline_role_permissions WHERE run_id=_run),
    'default_rows',(SELECT count(*) FROM public.rbac_baseline_role_permissions WHERE run_id=_run AND classification='default'),
    'added_rows',(SELECT count(*) FROM public.rbac_baseline_role_permissions WHERE run_id=_run AND classification='added'),
    'untemplated_rows',(SELECT count(*) FROM public.rbac_baseline_role_permissions WHERE run_id=_run AND classification='untemplated'),
    'template_omissions',(SELECT count(*) FROM public.rbac_baseline_template_omissions WHERE run_id=_run),
    'assignments',(SELECT count(*) FROM public.rbac_baseline_assignments WHERE run_id=_run),
    'effective_access_rows',(SELECT count(*) FROM public.rbac_baseline_effective_access WHERE run_id=_run),
    'users_covered',(SELECT count(DISTINCT user_id) FROM public.rbac_baseline_effective_access WHERE run_id=_run)
  ) INTO _stats;
  UPDATE public.rbac_baseline_runs SET stats=_stats WHERE id=_run;
  RETURN _stats;
END;
$$;
REVOKE ALL ON FUNCTION public.neo_rbac_baseline_close(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_rbac_baseline_close(uuid) TO service_role;
