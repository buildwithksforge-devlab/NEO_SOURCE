
ALTER TABLE public.tenant_snapshots
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS verification jsonb;

-- ---------------------------------------------------------------- verify
CREATE OR REPLACE FUNCTION public.neo_snapshot_verify(_snapshot uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid; _snap public.tenant_snapshots%ROWTYPE; _t record;
  _rows bigint; _sum text; _live bigint; _has_branch boolean; _exists boolean;
  _ok int := 0; _bad int := 0; _missing int := 0; _drift int := 0;
  _issues jsonb := '[]'::jsonb; _diffs jsonb := '[]'::jsonb; _res jsonb; _verified boolean;
BEGIN
  _org := public.neo_recovery_require('manage');
  SELECT * INTO _snap FROM public.tenant_snapshots WHERE id=_snapshot AND organization_id=_org;
  IF _snap.id IS NULL THEN RAISE EXCEPTION 'Snapshot not found in this workspace' USING ERRCODE='42501'; END IF;
  IF _snap.status <> 'completed' THEN RAISE EXCEPTION 'This snapshot is not complete'; END IF;

  FOR _t IN SELECT * FROM public.tenant_snapshot_tables st WHERE st.snapshot_id=_snapshot ORDER BY st.table_name
  LOOP
    -- stored contents must still reconstruct exactly what was captured
    SELECT coalesce(sum(c.row_count),0), md5(coalesce(string_agg(c.payload::text,'' ORDER BY c.chunk_index),''))
      INTO _rows, _sum
    FROM public.tenant_snapshot_chunks c
    WHERE c.snapshot_id=_snapshot AND c.table_name=_t.table_name;

    IF _rows = _t.row_count AND _sum IS NOT DISTINCT FROM _t.checksum THEN
      _ok := _ok + 1;
    ELSE
      _bad := _bad + 1;
      _issues := _issues || jsonb_build_object('table', _t.table_name,
                   'expected_rows', _t.row_count, 'found_rows', _rows,
                   'checksum_match', (_sum IS NOT DISTINCT FROM _t.checksum));
      CONTINUE;
    END IF;

    -- the captured area must still exist in the live system
    SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                   WHERE n.nspname='public' AND c.relkind='r' AND c.relname=_t.table_name)
      INTO _exists;
    IF NOT _exists THEN
      _missing := _missing + 1;
      _issues := _issues || jsonb_build_object('table', _t.table_name, 'live_table_missing', true);
      CONTINUE;
    END IF;

    -- compare against the records that are actually in the backend right now
    SELECT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema='public' AND table_name=_t.table_name AND column_name='branch_id')
      INTO _has_branch;

    IF _snap.scope='property' AND _snap.branch_id IS NOT NULL AND _has_branch THEN
      EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id=$1 AND branch_id=$2', _t.table_name)
        INTO _live USING _org, _snap.branch_id;
    ELSE
      EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id=$1', _t.table_name)
        INTO _live USING _org;
    END IF;

    IF _live <> _t.row_count THEN
      _drift := _drift + 1;
      _diffs := _diffs || jsonb_build_object('table', _t.table_name,
                  'snapshot_rows', _t.row_count, 'live_rows', _live, 'difference', _live - _t.row_count);
    END IF;
  END LOOP;

  -- a snapshot counts as a backup only when its stored contents are intact and
  -- every captured area still exists. Live differences are expected (the
  -- workspace keeps working) and are reported, not treated as a failure.
  _verified := (_bad = 0 AND _missing = 0 AND _ok > 0);

  _res := jsonb_build_object(
    'tables_checked', _ok + _bad + _missing,
    'tables_intact', _ok,
    'tables_failed', _bad,
    'tables_missing_live', _missing,
    'tables_differing_from_live', _drift,
    'issues', _issues,
    'live_differences', _diffs,
    'verified', _verified,
    'checked_at', now()
  );

  UPDATE public.tenant_snapshots
     SET verification=_res, verified_at=now()
   WHERE id=_snapshot;

  UPDATE public.backup_records
     SET verified = _verified,
         restore_tested_at = now(),
         restore_result = CASE WHEN _verified THEN 'verified against live records' ELSE 'verification failed' END
                          || ' · ' || _ok || ' intact, ' || _bad || ' failed, ' || _missing || ' missing, '
                          || _drift || ' differing from current records'
   WHERE id = _snap.backup_record_id;

  RETURN _res;
END $function$;

REVOKE ALL ON FUNCTION public.neo_snapshot_verify(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_snapshot_verify(uuid) TO authenticated;

-- ------------------------------------------------------------- lifecycle
ALTER TABLE public.tenant_lifecycle_states DROP CONSTRAINT IF EXISTS tenant_lifecycle_states_state_check;
ALTER TABLE public.tenant_lifecycle_states
  ADD CONSTRAINT tenant_lifecycle_states_state_check
  CHECK (state IN ('provisioning','active','suspended','offboarding','pending_deletion','deleted'));

ALTER TABLE public.tenant_lifecycle_states
  ADD COLUMN IF NOT EXISTS offboarding_started_by uuid,
  ADD COLUMN IF NOT EXISTS offboarding_started_at timestamptz;

CREATE OR REPLACE FUNCTION public.neo_tenant_begin_offboarding(_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _org uuid; _row public.tenant_lifecycle_states%ROWTYPE;
BEGIN
  _org := public.neo_recovery_require('manage');
  IF coalesce(btrim(_reason),'')='' THEN RAISE EXCEPTION 'A reason is required to start offboarding'; END IF;
  _row := public.neo_tenant_lifecycle();
  IF _row.state NOT IN ('suspended','offboarding') THEN
    RAISE EXCEPTION 'A workspace must be suspended before offboarding can start';
  END IF;
  IF _row.export_snapshot_id IS NULL OR _row.export_verified_at IS NULL THEN
    RAISE EXCEPTION 'A verified export is required before offboarding can start';
  END IF;
  UPDATE public.tenant_lifecycle_states
     SET state='offboarding', reason=_reason,
         offboarding_started_by=coalesce(offboarding_started_by, auth.uid()),
         offboarding_started_at=coalesce(offboarding_started_at, now())
   WHERE organization_id=_org;
  RETURN jsonb_build_object('state','offboarding');
END $function$;

REVOKE ALL ON FUNCTION public.neo_tenant_begin_offboarding(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_tenant_begin_offboarding(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_tenant_request_deletion(_reason text, _grace_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _org uuid; _row public.tenant_lifecycle_states%ROWTYPE;
BEGIN
  _org := public.neo_recovery_require('manage');
  IF coalesce(btrim(_reason),'')='' THEN RAISE EXCEPTION 'A reason is required to request deletion'; END IF;
  IF _grace_days < 7 THEN RAISE EXCEPTION 'The grace period must be at least 7 days'; END IF;
  _row := public.neo_tenant_lifecycle();
  IF _row.state <> 'offboarding' THEN
    RAISE EXCEPTION 'A workspace must be in offboarding before deletion can be requested';
  END IF;
  IF _row.export_snapshot_id IS NULL OR _row.export_verified_at IS NULL THEN
    RAISE EXCEPTION 'A verified export is required before deletion can be requested';
  END IF;

  UPDATE public.tenant_lifecycle_states
     SET state='pending_deletion', reason=_reason,
         deletion_requested_by=auth.uid(), deletion_requested_at=now(),
         deletion_approved_by=NULL, deletion_approved_at=NULL,
         grace_until=now() + make_interval(days => _grace_days)
   WHERE organization_id=_org;
  RETURN jsonb_build_object('state','pending_deletion','grace_days',_grace_days);
END $function$;

CREATE OR REPLACE FUNCTION public.neo_tenant_resume(_reason text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _org uuid;
BEGIN
  _org := public.neo_recovery_require('manage');
  UPDATE public.tenant_lifecycle_states
     SET state='active', reason=_reason, suspended_at=NULL, suspended_by=NULL,
         offboarding_started_by=NULL, offboarding_started_at=NULL,
         deletion_requested_by=NULL, deletion_requested_at=NULL,
         deletion_approved_by=NULL, deletion_approved_at=NULL, grace_until=NULL
   WHERE organization_id=_org AND state IN ('suspended','offboarding','pending_deletion');
  IF NOT FOUND THEN RAISE EXCEPTION 'This workspace is not suspended'; END IF;
  RETURN jsonb_build_object('state','active');
END $function$;
