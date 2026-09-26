
CREATE TABLE IF NOT EXISTS public.tenant_migration_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_organization_id uuid NOT NULL REFERENCES public.organizations(id),
  target_organization_id uuid REFERENCES public.organizations(id),
  branch_id uuid NOT NULL REFERENCES public.branches(id),
  mode text NOT NULL CHECK (mode IN ('plan','execute')),
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','failed')),
  reason text,
  plan jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  orphans jsonb NOT NULL DEFAULT '[]'::jsonb,
  performed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.tenant_migration_runs TO authenticated;
GRANT ALL ON public.tenant_migration_runs TO service_role;

ALTER TABLE public.tenant_migration_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_migration_runs_select ON public.tenant_migration_runs FOR SELECT TO authenticated
  USING (source_organization_id = current_org_id() OR target_organization_id = current_org_id());

CREATE OR REPLACE FUNCTION public.neo_tenant_migration_plan(_branch uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE src uuid; t record; n bigint; o bigint;
        tables jsonb := '[]'::jsonb; orphans jsonb := '[]'::jsonb; shared jsonb := '[]'::jsonb;
        people bigint; total bigint := 0;
BEGIN
  SELECT organization_id INTO src FROM branches WHERE id = _branch;
  IF src IS NULL THEN RAISE EXCEPTION 'Property not found'; END IF;
  IF src <> current_org_id() THEN RAISE EXCEPTION 'Property belongs to another workspace'; END IF;
  IF NOT is_org_admin_for(src) THEN RAISE EXCEPTION 'permission_denied'; END IF;

  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
     WHERE c.table_schema='public' AND c.column_name='branch_id'
       AND EXISTS (SELECT 1 FROM information_schema.columns c2
                    WHERE c2.table_schema='public' AND c2.table_name=c.table_name AND c2.column_name='organization_id')
       AND EXISTS (SELECT 1 FROM pg_class pc JOIN pg_namespace pn ON pn.oid=pc.relnamespace
                    WHERE pn.nspname='public' AND pc.relname=c.table_name AND pc.relkind IN ('r','p'))
     ORDER BY c.table_name
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE branch_id = $1', t.table_name) INTO n USING _branch;
    EXECUTE format('SELECT count(*) FROM public.%I WHERE branch_id = $1 AND organization_id IS DISTINCT FROM $2', t.table_name)
      INTO o USING _branch, src;
    IF n > 0 THEN
      tables := tables || jsonb_build_object('table', t.table_name, 'rows', n);
      total := total + n;
    END IF;
    IF o > 0 THEN
      orphans := orphans || jsonb_build_object('table', t.table_name, 'rows', o, 'issue', 'row workspace does not match property workspace');
    END IF;
  END LOOP;

  SELECT count(*) INTO people FROM organization_memberships m
   WHERE m.organization_id = src AND m.status = 'active';

  shared := shared || jsonb_build_object(
    'note', 'Group-level configuration without a property (chart of accounts, roles, policies) is not moved by this operation.');

  INSERT INTO tenant_migration_runs(source_organization_id, branch_id, mode, reason, plan, orphans, performed_by)
  VALUES (src, _branch, 'plan', NULL,
          jsonb_build_object('tables', tables, 'total_rows', total, 'active_members', people, 'notes', shared),
          orphans, auth.uid());

  RETURN jsonb_build_object('branch', _branch, 'source_organization', src, 'tables', tables,
                            'total_rows', total, 'active_members', people, 'orphans', orphans, 'notes', shared);
END $$;

CREATE OR REPLACE FUNCTION public.neo_tenant_migrate_property(
  _branch uuid, _reason text, _target_organization uuid DEFAULT NULL, _new_organization_name text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE src uuid; tgt uuid := _target_organization; t record; n bigint;
        moved jsonb := '[]'::jsonb; skipped jsonb := '[]'::jsonb; total bigint := 0; run uuid;
BEGIN
  SELECT organization_id INTO src FROM branches WHERE id = _branch;
  IF src IS NULL THEN RAISE EXCEPTION 'Property not found'; END IF;
  IF src <> current_org_id() THEN RAISE EXCEPTION 'Property belongs to another workspace'; END IF;
  IF NOT is_org_admin_for(src) THEN RAISE EXCEPTION 'permission_denied'; END IF;
  IF coalesce(trim(_reason),'') = '' THEN RAISE EXCEPTION 'A reason is required'; END IF;
  IF (SELECT count(*) FROM branches WHERE organization_id = src) <= 1 THEN
    RAISE EXCEPTION 'This is the only property in the workspace; move is not required';
  END IF;

  IF tgt IS NULL THEN
    IF coalesce(trim(_new_organization_name),'') = '' THEN
      RAISE EXCEPTION 'Provide an existing destination workspace or a name for the new one';
    END IF;
    INSERT INTO organizations(name) VALUES (trim(_new_organization_name)) RETURNING id INTO tgt;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = tgt) THEN RAISE EXCEPTION 'Destination workspace not found'; END IF;
  END IF;

  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
     WHERE c.table_schema='public' AND c.column_name='branch_id'
       AND EXISTS (SELECT 1 FROM information_schema.columns c2
                    WHERE c2.table_schema='public' AND c2.table_name=c.table_name AND c2.column_name='organization_id')
       AND EXISTS (SELECT 1 FROM pg_class pc JOIN pg_namespace pn ON pn.oid=pc.relnamespace
                    WHERE pn.nspname='public' AND pc.relname=c.table_name AND pc.relkind IN ('r','p'))
       AND c.table_name <> 'branches'
     ORDER BY c.table_name
  LOOP
    BEGIN
      EXECUTE format('UPDATE public.%I SET organization_id = $1 WHERE branch_id = $2 AND organization_id = $3', t.table_name)
        USING tgt, _branch, src;
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n > 0 THEN
        moved := moved || jsonb_build_object('table', t.table_name, 'rows', n);
        total := total + n;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      skipped := skipped || jsonb_build_object('table', t.table_name, 'error', SQLERRM);
    END;
  END LOOP;

  UPDATE branches SET organization_id = tgt WHERE id = _branch;

  INSERT INTO tenant_migration_runs(source_organization_id, target_organization_id, branch_id, mode, status, reason, result, performed_by)
  VALUES (src, tgt, _branch, 'execute',
          CASE WHEN jsonb_array_length(skipped) > 0 THEN 'failed' ELSE 'completed' END,
          _reason,
          jsonb_build_object('moved', moved, 'skipped', skipped, 'total_rows', total),
          auth.uid())
  RETURNING id INTO run;

  RETURN jsonb_build_object('run', run, 'source_organization', src, 'target_organization', tgt,
                            'moved', moved, 'skipped', skipped, 'total_rows', total,
                            'people_note', 'Workspace access was not transferred. Invite the people who should work in the new workspace.');
END $$;

REVOKE ALL ON FUNCTION public.neo_tenant_migration_plan(uuid) FROM anon, public;
REVOKE ALL ON FUNCTION public.neo_tenant_migrate_property(uuid,text,uuid,text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.neo_tenant_migration_plan(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_tenant_migrate_property(uuid,text,uuid,text) TO authenticated;
