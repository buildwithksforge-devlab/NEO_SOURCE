
-- Catalogue of tables that belong to a workspace ------------------
CREATE OR REPLACE FUNCTION public.neo_tenant_scope_tables()
RETURNS TABLE(table_name text, has_branch boolean, recovery_class text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.relname::text,
         EXISTS (SELECT 1 FROM information_schema.columns bc
                 WHERE bc.table_schema='public' AND bc.table_name=c.relname
                   AND bc.column_name='branch_id'),
         CASE
           WHEN c.relname LIKE 'tenant\_snapshot%' OR c.relname LIKE 'tenant\_restore%'
             OR c.relname LIKE 'tenant\_deletion%' OR c.relname LIKE 'tenant\_lifecycle%'
             OR c.relname LIKE 'rbac\_baseline%' OR c.relname LIKE 'rbac\_platform%'
             THEN 'excluded_recovery_metadata'
           WHEN c.relname IN ('audit_logs','domain_events','role_grant_migration_log',
                              'role_grant_migration_log_archive','canonical_transaction_state_history',
                              'finance_posting_receipt_history','ai_query_logs','ai_messages')
             THEN 'excluded_append_only_log'
           ELSE 'captured'
         END
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN information_schema.columns col
    ON col.table_schema='public' AND col.table_name=c.relname AND col.column_name='organization_id'
  WHERE n.nspname='public' AND c.relkind='r'
  ORDER BY 1;
$$;
REVOKE ALL ON FUNCTION public.neo_tenant_scope_tables() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_tenant_scope_tables() TO authenticated, service_role;

-- Guard helper ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_recovery_require(_action text)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid;
BEGIN
  _org := public.current_org_id();
  IF _org IS NULL THEN
    RAISE EXCEPTION 'No workspace context for this session' USING ERRCODE='42501';
  END IF;
  IF NOT (public.has_permission('administration','recovery',_action)
          OR public.is_org_admin_for(_org)) THEN
    RAISE EXCEPTION 'You do not have the recovery % right', _action USING ERRCODE='42501';
  END IF;
  RETURN _org;
END $$;
REVOKE ALL ON FUNCTION public.neo_recovery_require(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_recovery_require(text) TO authenticated, service_role;

-- Begin a snapshot -------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_snapshot_begin(_branch uuid DEFAULT NULL, _label text DEFAULT NULL, _reason text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid; _id uuid;
BEGIN
  _org := public.neo_recovery_require('manage');
  IF _branch IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.branches b WHERE b.id=_branch AND b.organization_id=_org) THEN
    RAISE EXCEPTION 'That property does not belong to this workspace' USING ERRCODE='42501';
  END IF;
  INSERT INTO public.tenant_snapshots (organization_id, branch_id, scope, label, reason, created_by)
  VALUES (_org, _branch, CASE WHEN _branch IS NULL THEN 'tenant' ELSE 'property' END,
          nullif(btrim(coalesce(_label,'')),''), nullif(btrim(coalesce(_reason,'')),''), auth.uid())
  RETURNING id INTO _id;
  RETURN _id;
END $$;
REVOKE ALL ON FUNCTION public.neo_snapshot_begin(uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_snapshot_begin(uuid,text,text) TO authenticated, service_role;

-- Capture pass -------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_snapshot_capture(_snapshot uuid, _budget_seconds integer DEFAULT 15, _chunk integer DEFAULT 500, _max_rows bigint DEFAULT 250000)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _org uuid; _snap public.tenant_snapshots%ROWTYPE;
  _t record; _deadline timestamptz := clock_timestamp() + make_interval(secs => greatest(1, _budget_seconds));
  _filter text; _n bigint; _chunks integer; _sum text; _done integer := 0; _remaining integer;
  _skipped jsonb := '[]'::jsonb;
BEGIN
  _org := public.neo_recovery_require('manage');
  SELECT * INTO _snap FROM public.tenant_snapshots WHERE id=_snapshot AND organization_id=_org;
  IF _snap.id IS NULL THEN RAISE EXCEPTION 'Snapshot not found in this workspace' USING ERRCODE='42501'; END IF;
  IF _snap.status <> 'running' THEN RAISE EXCEPTION 'This snapshot is already %', _snap.status; END IF;
  _skipped := _snap.skipped_tables;

  FOR _t IN
    SELECT s.* FROM public.neo_tenant_scope_tables() s
    WHERE NOT EXISTS (SELECT 1 FROM public.tenant_snapshot_tables st
                      WHERE st.snapshot_id=_snapshot AND st.table_name=s.table_name)
      AND NOT (_skipped @> to_jsonb(ARRAY[jsonb_build_object('table', s.table_name)]))
    ORDER BY s.table_name
  LOOP
    EXIT WHEN clock_timestamp() > _deadline;

    IF _t.recovery_class <> 'captured' THEN
      _skipped := _skipped || jsonb_build_object('table', _t.table_name, 'reason', _t.recovery_class);
      CONTINUE;
    END IF;

    IF _snap.branch_id IS NOT NULL AND NOT _t.has_branch THEN
      _skipped := _skipped || jsonb_build_object('table', _t.table_name, 'reason', 'not_property_scoped');
      CONTINUE;
    END IF;

    _filter := format('t.organization_id = %L', _org);
    IF _snap.branch_id IS NOT NULL THEN
      _filter := _filter || format(' AND t.branch_id = %L', _snap.branch_id);
    END IF;

    EXECUTE format('SELECT count(*) FROM public.%I t WHERE %s', _t.table_name, _filter) INTO _n;

    IF _n > _max_rows THEN
      _skipped := _skipped || jsonb_build_object('table', _t.table_name, 'reason', 'too_large', 'rows', _n);
      CONTINUE;
    END IF;

    IF _n > 0 THEN
      EXECUTE format(
        'INSERT INTO public.tenant_snapshot_chunks (snapshot_id, organization_id, table_name, chunk_index, row_count, payload)
         SELECT %L::uuid, %L::uuid, %L, g.grp::int, count(*)::int, jsonb_agg(g.r ORDER BY g.rn)
         FROM (SELECT to_jsonb(t.*) AS r, row_number() OVER () AS rn,
                      (row_number() OVER () - 1) / %s AS grp
               FROM public.%I t WHERE %s) g
         GROUP BY g.grp',
        _snapshot, _org, _t.table_name, greatest(1,_chunk), _t.table_name, _filter);
    END IF;

    SELECT count(*), md5(coalesce(string_agg(c.payload::text, '' ORDER BY c.chunk_index),''))
      INTO _chunks, _sum
    FROM public.tenant_snapshot_chunks c
    WHERE c.snapshot_id=_snapshot AND c.table_name=_t.table_name;

    INSERT INTO public.tenant_snapshot_tables (snapshot_id, organization_id, table_name, row_count, chunk_count, checksum)
    VALUES (_snapshot, _org, _t.table_name, _n, coalesce(_chunks,0), _sum)
    ON CONFLICT (snapshot_id, table_name) DO UPDATE
      SET row_count=EXCLUDED.row_count, chunk_count=EXCLUDED.chunk_count, checksum=EXCLUDED.checksum;

    _done := _done + 1;
  END LOOP;

  UPDATE public.tenant_snapshots SET skipped_tables=_skipped WHERE id=_snapshot;

  SELECT count(*) INTO _remaining
  FROM public.neo_tenant_scope_tables() s
  WHERE NOT EXISTS (SELECT 1 FROM public.tenant_snapshot_tables st
                    WHERE st.snapshot_id=_snapshot AND st.table_name=s.table_name)
    AND NOT (_skipped @> to_jsonb(ARRAY[jsonb_build_object('table', s.table_name)]));

  RETURN jsonb_build_object('captured_this_pass', _done, 'remaining', _remaining,
                            'skipped', jsonb_array_length(_skipped));
END $$;
REVOKE ALL ON FUNCTION public.neo_snapshot_capture(uuid,integer,integer,bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_snapshot_capture(uuid,integer,integer,bigint) TO authenticated, service_role;

-- Finalise -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_snapshot_finalise(_snapshot uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid; _snap public.tenant_snapshots%ROWTYPE; _tables int; _rows bigint; _sum text; _backup uuid;
BEGIN
  _org := public.neo_recovery_require('manage');
  SELECT * INTO _snap FROM public.tenant_snapshots WHERE id=_snapshot AND organization_id=_org;
  IF _snap.id IS NULL THEN RAISE EXCEPTION 'Snapshot not found in this workspace' USING ERRCODE='42501'; END IF;

  SELECT count(*), coalesce(sum(st.row_count),0), md5(coalesce(string_agg(st.table_name||':'||coalesce(st.checksum,''), '|' ORDER BY st.table_name),''))
    INTO _tables, _rows, _sum
  FROM public.tenant_snapshot_tables st WHERE st.snapshot_id=_snapshot;

  INSERT INTO public.backup_records (organization_id, backup_type, scope, environment, taken_at,
                                     location_reference, verified, notes)
  VALUES (_org, 'application_snapshot', _snap.scope,
          CASE WHEN EXISTS (SELECT 1 FROM public.environment_registry e WHERE e.is_production) THEN 'production' ELSE 'unknown' END,
          now(), 'tenant_snapshots/'||_snapshot::text, false,
          coalesce(_snap.label, 'Workspace snapshot'))
  RETURNING id INTO _backup;

  UPDATE public.tenant_snapshots
     SET status='completed', completed_at=now(), table_count=_tables, row_count=_rows,
         checksum=_sum, backup_record_id=_backup,
         manifest=jsonb_build_object(
           'tables', (SELECT jsonb_agg(jsonb_build_object('table', st.table_name, 'rows', st.row_count,
                                                          'chunks', st.chunk_count, 'checksum', st.checksum)
                                       ORDER BY st.table_name)
                      FROM public.tenant_snapshot_tables st WHERE st.snapshot_id=_snapshot),
           'skipped', _snap.skipped_tables,
           'captured_at', now())
   WHERE id=_snapshot;

  RETURN jsonb_build_object('snapshot', _snapshot, 'tables', _tables, 'rows', _rows, 'checksum', _sum, 'backup_record', _backup);
END $$;
REVOKE ALL ON FUNCTION public.neo_snapshot_finalise(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_snapshot_finalise(uuid) TO authenticated, service_role;
