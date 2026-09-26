
-- Tables that a restore must never overwrite ------------------------
CREATE OR REPLACE FUNCTION public.neo_restore_is_protected(_table text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT _table LIKE '%journal%' OR _table LIKE '%payment%' OR _table LIKE '%folio%'
      OR _table LIKE '%invoice%' OR _table LIKE '%ledger%' OR _table LIKE '%receipt%'
      OR _table LIKE '%posting%' OR _table LIKE 'audit%' OR _table LIKE 'etims%'
      OR _table LIKE '%credit_note%' OR _table LIKE '%cash_%';
$$;

-- Build the comparison for one snapshot ------------------------------
CREATE OR REPLACE FUNCTION public.neo_restore_build_plan(_snapshot uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _org uuid; _snap public.tenant_snapshots%ROWTYPE; _t record;
  _filter text; _missing bigint; _changed bigint; _extra bigint; _hasid boolean;
  _tables jsonb := '[]'::jsonb;
BEGIN
  _org := public.neo_recovery_require('manage');
  SELECT * INTO _snap FROM public.tenant_snapshots WHERE id=_snapshot AND organization_id=_org;
  IF _snap.id IS NULL THEN RAISE EXCEPTION 'Snapshot not found in this workspace' USING ERRCODE='42501'; END IF;
  IF _snap.status <> 'completed' THEN RAISE EXCEPTION 'This snapshot is not complete'; END IF;

  FOR _t IN SELECT st.table_name, st.row_count FROM public.tenant_snapshot_tables st
            WHERE st.snapshot_id=_snapshot ORDER BY st.table_name
  LOOP
    SELECT EXISTS (SELECT 1 FROM information_schema.columns c
                   WHERE c.table_schema='public' AND c.table_name=_t.table_name AND c.column_name='id')
      INTO _hasid;

    IF NOT _hasid THEN
      _tables := _tables || jsonb_build_object('table', _t.table_name, 'status','no_identity',
                                               'snapshot_rows', _t.row_count);
      CONTINUE;
    END IF;

    _filter := format('t.organization_id = %L', _org);
    IF _snap.branch_id IS NOT NULL THEN
      _filter := _filter || format(' AND t.branch_id = %L', _snap.branch_id);
    END IF;

    EXECUTE format($q$
      WITH snap AS (
        SELECT (e ->> 'id')::uuid AS id, e AS r
        FROM public.tenant_snapshot_chunks c, jsonb_array_elements(c.payload) e
        WHERE c.snapshot_id = %L AND c.table_name = %L
      ), cur AS (
        SELECT t.id, to_jsonb(t.*) AS r FROM public.%I t WHERE %s
      )
      SELECT (SELECT count(*) FROM snap s LEFT JOIN cur c ON c.id=s.id WHERE c.id IS NULL),
             (SELECT count(*) FROM snap s JOIN cur c ON c.id=s.id WHERE c.r IS DISTINCT FROM s.r),
             (SELECT count(*) FROM cur c LEFT JOIN snap s ON s.id=c.id WHERE s.id IS NULL)
    $q$, _snapshot, _t.table_name, _t.table_name, _filter)
    INTO _missing, _changed, _extra;

    _tables := _tables || jsonb_build_object(
      'table', _t.table_name,
      'status', CASE WHEN public.neo_restore_is_protected(_t.table_name) THEN 'protected' ELSE 'restorable' END,
      'snapshot_rows', _t.row_count,
      'would_restore', _missing,
      'would_overwrite', _changed,
      'not_in_snapshot', _extra);
  END LOOP;

  RETURN jsonb_build_object(
    'snapshot', _snapshot,
    'scope', _snap.scope,
    'branch_id', _snap.branch_id,
    'built_at', now(),
    'tables', _tables,
    'totals', jsonb_build_object(
      'would_restore', (SELECT coalesce(sum((x->>'would_restore')::bigint),0) FROM jsonb_array_elements(_tables) x WHERE x->>'status'='restorable'),
      'would_overwrite', (SELECT coalesce(sum((x->>'would_overwrite')::bigint),0) FROM jsonb_array_elements(_tables) x WHERE x->>'status'='restorable'),
      'protected_tables', (SELECT count(*) FROM jsonb_array_elements(_tables) x WHERE x->>'status'='protected'),
      'not_in_snapshot', (SELECT coalesce(sum((x->>'not_in_snapshot')::bigint),0) FROM jsonb_array_elements(_tables) x)),
    'skipped', _snap.skipped_tables);
END $$;
REVOKE ALL ON FUNCTION public.neo_restore_build_plan(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_restore_build_plan(uuid) TO authenticated, service_role;

-- Dry run / request --------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_restore_open(_snapshot uuid, _mode text, _reason text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid; _snap public.tenant_snapshots%ROWTYPE; _plan jsonb; _run uuid;
BEGIN
  _org := public.neo_recovery_require('manage');
  IF _mode NOT IN ('dry_run','apply') THEN RAISE EXCEPTION 'Unknown restore mode %', _mode; END IF;
  SELECT * INTO _snap FROM public.tenant_snapshots WHERE id=_snapshot AND organization_id=_org;
  IF _snap.id IS NULL THEN RAISE EXCEPTION 'Snapshot not found in this workspace' USING ERRCODE='42501'; END IF;
  IF _mode='apply' AND coalesce(btrim(_reason),'')='' THEN
    RAISE EXCEPTION 'A reason is required to request a restore';
  END IF;

  _plan := public.neo_restore_build_plan(_snapshot);

  INSERT INTO public.tenant_restore_runs (organization_id, snapshot_id, branch_id, scope, mode, status, reason, plan, requested_by)
  VALUES (_org, _snapshot, _snap.branch_id, _snap.scope, _mode,
          CASE WHEN _mode='dry_run' THEN 'completed' ELSE 'awaiting_approval' END,
          nullif(btrim(coalesce(_reason,'')),''), _plan, auth.uid())
  RETURNING id INTO _run;
  RETURN _run;
END $$;
REVOKE ALL ON FUNCTION public.neo_restore_open(uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_restore_open(uuid,text,text) TO authenticated, service_role;

-- Approval -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_restore_approve(_run uuid, _reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid; _r public.tenant_restore_runs%ROWTYPE;
BEGIN
  _org := public.neo_recovery_require('approve');
  SELECT * INTO _r FROM public.tenant_restore_runs WHERE id=_run AND organization_id=_org;
  IF _r.id IS NULL THEN RAISE EXCEPTION 'Restore request not found in this workspace' USING ERRCODE='42501'; END IF;
  IF _r.status <> 'awaiting_approval' THEN RAISE EXCEPTION 'This restore is already %', _r.status; END IF;
  IF _r.requested_by = auth.uid() THEN RAISE EXCEPTION 'A restore cannot be approved by the person who requested it'; END IF;

  UPDATE public.tenant_restore_runs
     SET status='approved', approved_by=auth.uid(), approved_at=now(),
         reason=coalesce(nullif(btrim(coalesce(_reason,'')),''), reason)
   WHERE id=_run;
  RETURN jsonb_build_object('run', _run, 'status','approved');
END $$;
REVOKE ALL ON FUNCTION public.neo_restore_approve(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_restore_approve(uuid,text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_restore_cancel(_run uuid, _reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid;
BEGIN
  _org := public.neo_recovery_require('manage');
  UPDATE public.tenant_restore_runs
     SET status='cancelled', reason=coalesce(nullif(btrim(coalesce(_reason,'')),''), reason)
   WHERE id=_run AND organization_id=_org AND status IN ('planned','awaiting_approval','approved');
  IF NOT FOUND THEN RAISE EXCEPTION 'That restore cannot be cancelled'; END IF;
  RETURN jsonb_build_object('run', _run, 'status','cancelled');
END $$;
REVOKE ALL ON FUNCTION public.neo_restore_cancel(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_restore_cancel(uuid,text) TO authenticated, service_role;

-- Execute an approved restore -------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_restore_execute(_run uuid, _budget_seconds integer DEFAULT 15)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _org uuid; _r public.tenant_restore_runs%ROWTYPE; _snap public.tenant_snapshots%ROWTYPE;
  _t record; _filter text; _cols text; _ins bigint; _upd bigint; _done jsonb; _remaining int;
  _deadline timestamptz := clock_timestamp() + make_interval(secs => greatest(1,_budget_seconds));
BEGIN
  _org := public.neo_recovery_require('manage');
  SELECT * INTO _r FROM public.tenant_restore_runs WHERE id=_run AND organization_id=_org;
  IF _r.id IS NULL THEN RAISE EXCEPTION 'Restore not found in this workspace' USING ERRCODE='42501'; END IF;
  IF _r.mode <> 'apply' THEN RAISE EXCEPTION 'Only an approved restore can be executed'; END IF;
  IF _r.status NOT IN ('approved','running') THEN RAISE EXCEPTION 'This restore is %', _r.status; END IF;
  IF _r.approved_by IS NULL THEN RAISE EXCEPTION 'This restore has not been approved'; END IF;

  SELECT * INTO _snap FROM public.tenant_snapshots WHERE id=_r.snapshot_id;
  _done := coalesce(_r.result -> 'tables', '{}'::jsonb);
  UPDATE public.tenant_restore_runs SET status='running' WHERE id=_run;

  FOR _t IN SELECT st.table_name FROM public.tenant_snapshot_tables st
            WHERE st.snapshot_id=_r.snapshot_id
              AND NOT public.neo_restore_is_protected(st.table_name)
              AND NOT (_done ? st.table_name)
            ORDER BY st.table_name
  LOOP
    EXIT WHEN clock_timestamp() > _deadline;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns c
                   WHERE c.table_schema='public' AND c.table_name=_t.table_name AND c.column_name='id') THEN
      _done := _done || jsonb_build_object(_t.table_name, jsonb_build_object('status','no_identity'));
      CONTINUE;
    END IF;

    _filter := format('t.organization_id = %L', _org);
    IF _snap.branch_id IS NOT NULL THEN
      _filter := _filter || format(' AND t.branch_id = %L', _snap.branch_id);
    END IF;

    SELECT string_agg(format('%I', c.column_name), ', ' ORDER BY c.ordinal_position)
      INTO _cols
    FROM information_schema.columns c
    WHERE c.table_schema='public' AND c.table_name=_t.table_name AND c.column_name <> 'id';

    EXECUTE format($q$
      WITH snap AS (
        SELECT (e ->> 'id')::uuid AS id, e AS r
        FROM public.tenant_snapshot_chunks c, jsonb_array_elements(c.payload) e
        WHERE c.snapshot_id = %L AND c.table_name = %L
      ), ins AS (
        INSERT INTO public.%I
        SELECT (jsonb_populate_record(NULL::public.%I, s.r)).*
        FROM snap s
        WHERE NOT EXISTS (SELECT 1 FROM public.%I x WHERE x.id = s.id)
        ON CONFLICT (id) DO NOTHING
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM ins)
    $q$, _r.snapshot_id, _t.table_name, _t.table_name, _t.table_name, _t.table_name)
    INTO _ins;

    IF _cols IS NOT NULL THEN
      EXECUTE format($q$
        WITH snap AS (
          SELECT (e ->> 'id')::uuid AS id, e AS r
          FROM public.tenant_snapshot_chunks c, jsonb_array_elements(c.payload) e
          WHERE c.snapshot_id = %L AND c.table_name = %L
        ), upd AS (
          UPDATE public.%I t
             SET (%s) = (SELECT %s FROM jsonb_populate_record(NULL::public.%I, s.r) p)
            FROM snap s
           WHERE t.id = s.id AND %s AND to_jsonb(t.*) IS DISTINCT FROM s.r
          RETURNING 1
        )
        SELECT (SELECT count(*) FROM upd)
      $q$, _r.snapshot_id, _t.table_name, _t.table_name, _cols,
           (SELECT string_agg('p.'||format('%I', c.column_name), ', ' ORDER BY c.ordinal_position)
            FROM information_schema.columns c
            WHERE c.table_schema='public' AND c.table_name=_t.table_name AND c.column_name<>'id'),
           _t.table_name, _filter)
      INTO _upd;
    ELSE
      _upd := 0;
    END IF;

    _done := _done || jsonb_build_object(_t.table_name,
      jsonb_build_object('status','restored','inserted',_ins,'updated',_upd));
  END LOOP;

  SELECT count(*) INTO _remaining
  FROM public.tenant_snapshot_tables st
  WHERE st.snapshot_id=_r.snapshot_id
    AND NOT public.neo_restore_is_protected(st.table_name)
    AND NOT (_done ? st.table_name);

  UPDATE public.tenant_restore_runs
     SET result = jsonb_build_object('tables', _done, 'remaining', _remaining, 'updated_at', now()),
         status = CASE WHEN _remaining = 0 THEN 'completed' ELSE 'running' END,
         executed_at = CASE WHEN _remaining = 0 THEN now() ELSE executed_at END
   WHERE id=_run;

  RETURN jsonb_build_object('run',_run,'remaining',_remaining,
                            'status', CASE WHEN _remaining=0 THEN 'completed' ELSE 'running' END);
END $$;
REVOKE ALL ON FUNCTION public.neo_restore_execute(uuid,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_restore_execute(uuid,integer) TO authenticated, service_role;

-- Practice drill ----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_restore_drill(_snapshot uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _org uuid; _snap public.tenant_snapshots%ROWTYPE; _t record;
  _rows bigint; _sum text; _ok int := 0; _bad int := 0; _issues jsonb := '[]'::jsonb; _run uuid; _result text;
BEGIN
  _org := public.neo_recovery_require('manage');
  SELECT * INTO _snap FROM public.tenant_snapshots WHERE id=_snapshot AND organization_id=_org;
  IF _snap.id IS NULL THEN RAISE EXCEPTION 'Snapshot not found in this workspace' USING ERRCODE='42501'; END IF;
  IF _snap.status <> 'completed' THEN RAISE EXCEPTION 'This snapshot is not complete'; END IF;

  FOR _t IN SELECT * FROM public.tenant_snapshot_tables st WHERE st.snapshot_id=_snapshot ORDER BY st.table_name
  LOOP
    SELECT coalesce(sum(c.row_count),0), md5(coalesce(string_agg(c.payload::text,'' ORDER BY c.chunk_index),''))
      INTO _rows, _sum
    FROM public.tenant_snapshot_chunks c WHERE c.snapshot_id=_snapshot AND c.table_name=_t.table_name;

    IF _rows = _t.row_count AND _sum IS NOT DISTINCT FROM _t.checksum THEN
      _ok := _ok + 1;
    ELSE
      _bad := _bad + 1;
      _issues := _issues || jsonb_build_object('table', _t.table_name,
                   'expected_rows', _t.row_count, 'found_rows', _rows,
                   'checksum_match', (_sum IS NOT DISTINCT FROM _t.checksum));
    END IF;
  END LOOP;

  _result := CASE WHEN _bad = 0 THEN 'passed' ELSE 'failed' END;

  INSERT INTO public.tenant_restore_runs (organization_id, snapshot_id, branch_id, scope, mode, status,
                                          reason, plan, result, requested_by, executed_at)
  VALUES (_org, _snapshot, _snap.branch_id, _snap.scope, 'drill',
          CASE WHEN _bad=0 THEN 'completed' ELSE 'failed' END,
          'Restore verification drill', '{}'::jsonb,
          jsonb_build_object('tables_verified',_ok,'tables_failed',_bad,'issues',_issues),
          auth.uid(), now())
  RETURNING id INTO _run;

  UPDATE public.backup_records
     SET verified = (_bad = 0), restore_tested_at = now(),
         restore_result = _result || ' · ' || _ok || ' table(s) verified, ' || _bad || ' failed'
   WHERE id = _snap.backup_record_id;

  RETURN jsonb_build_object('run',_run,'result',_result,'verified',_ok,'failed',_bad,'issues',_issues);
END $$;
REVOKE ALL ON FUNCTION public.neo_restore_drill(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_restore_drill(uuid) TO authenticated, service_role;
