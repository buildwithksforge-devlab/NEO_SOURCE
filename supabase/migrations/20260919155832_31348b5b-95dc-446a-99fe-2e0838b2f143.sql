
CREATE OR REPLACE FUNCTION public.neo_tenant_cancel_deletion(_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid;
BEGIN
  _org := public.neo_recovery_require('manage');
  UPDATE public.tenant_lifecycle_states
     SET state='suspended', reason=coalesce(nullif(btrim(coalesce(_reason,'')),''), reason),
         deletion_requested_by=NULL, deletion_requested_at=NULL,
         deletion_approved_by=NULL, deletion_approved_at=NULL, grace_until=NULL
   WHERE organization_id=_org AND state='pending_deletion';
  IF NOT FOUND THEN RAISE EXCEPTION 'No deletion is pending for this workspace'; END IF;
  RETURN jsonb_build_object('state','suspended');
END $$;
REVOKE ALL ON FUNCTION public.neo_tenant_cancel_deletion(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_tenant_cancel_deletion(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_tenant_execute_deletion(_confirm_name text, _budget_seconds integer DEFAULT 15)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _org uuid; _row public.tenant_lifecycle_states%ROWTYPE; _name text; _t record;
  _deleted bigint; _summary jsonb := '{}'::jsonb; _remaining int; _cert uuid;
  _deadline timestamptz := clock_timestamp() + make_interval(secs => greatest(1,_budget_seconds));
BEGIN
  _org := public.neo_recovery_require('manage');
  SELECT * INTO _row FROM public.tenant_lifecycle_states WHERE organization_id=_org;
  IF _row.state <> 'pending_deletion' THEN RAISE EXCEPTION 'No deletion is pending for this workspace'; END IF;
  IF _row.deletion_approved_by IS NULL THEN RAISE EXCEPTION 'This deletion has not been approved by a second person'; END IF;
  IF _row.grace_until IS NULL OR now() < _row.grace_until THEN
    RAISE EXCEPTION 'The grace period has not finished yet';
  END IF;
  IF _row.export_snapshot_id IS NULL OR _row.export_verified_at IS NULL THEN
    RAISE EXCEPTION 'A verified export is required before deletion';
  END IF;

  SELECT o.name INTO _name FROM public.organizations o WHERE o.id=_org;
  IF btrim(coalesce(_confirm_name,'')) <> btrim(coalesce(_name,'')) THEN
    RAISE EXCEPTION 'Type the workspace name exactly to confirm deletion';
  END IF;

  _summary := coalesce((SELECT c.removed_summary FROM public.tenant_deletion_certificates c
                        WHERE c.organization_id=_org ORDER BY c.executed_at DESC LIMIT 1), '{}'::jsonb);

  FOR _t IN SELECT s.table_name FROM public.neo_tenant_scope_tables() s
            WHERE s.recovery_class <> 'excluded_recovery_metadata'
              AND NOT (_summary ? s.table_name)
            ORDER BY s.table_name
  LOOP
    EXIT WHEN clock_timestamp() > _deadline;
    EXECUTE format('WITH d AS (DELETE FROM public.%I t WHERE t.organization_id = %L RETURNING 1) SELECT count(*) FROM d',
                   _t.table_name, _org)
      INTO _deleted;
    _summary := _summary || jsonb_build_object(_t.table_name, _deleted);
  END LOOP;

  SELECT count(*) INTO _remaining
  FROM public.neo_tenant_scope_tables() s
  WHERE s.recovery_class <> 'excluded_recovery_metadata' AND NOT (_summary ? s.table_name);

  INSERT INTO public.tenant_deletion_certificates
    (organization_id, organization_name, export_snapshot_id, export_reference, removed_summary,
     requested_by, approved_by, executed_by, notes)
  VALUES (_org, coalesce(_name,'(unnamed workspace)'), _row.export_snapshot_id,
          'tenant_snapshots/'||_row.export_snapshot_id::text, _summary,
          _row.deletion_requested_by, _row.deletion_approved_by, auth.uid(),
          CASE WHEN _remaining = 0 THEN 'Deletion completed' ELSE 'Deletion in progress' END)
  RETURNING id INTO _cert;

  IF _remaining = 0 THEN
    UPDATE public.tenant_lifecycle_states SET state='deleted' WHERE organization_id=_org;
  END IF;

  RETURN jsonb_build_object('certificate', _cert, 'remaining', _remaining,
                            'state', CASE WHEN _remaining=0 THEN 'deleted' ELSE 'pending_deletion' END);
END $$;
REVOKE ALL ON FUNCTION public.neo_tenant_execute_deletion(text,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_tenant_execute_deletion(text,integer) TO authenticated, service_role;
