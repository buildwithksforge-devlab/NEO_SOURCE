
-- Provider backup terms ------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_record_backup_terms(
  _environment_key text, _provider text, _frequency text, _retention_days integer,
  _pitr boolean, _pitr_window_hours integer, _region text, _source text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.neo_recovery_require('manage');
  UPDATE public.environment_registry
     SET backup_provider=_provider, backup_frequency=_frequency, backup_retention_days=_retention_days,
         pitr_enabled=_pitr, pitr_window_hours=_pitr_window_hours, backup_region=_region,
         backup_terms_source=_source, backup_terms_recorded_at=now(), backup_terms_recorded_by=auth.uid()
   WHERE key=_environment_key;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown environment %', _environment_key; END IF;
  RETURN jsonb_build_object('environment', _environment_key, 'recorded_at', now());
END $$;
REVOKE ALL ON FUNCTION public.neo_record_backup_terms(text,text,text,integer,boolean,integer,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_record_backup_terms(text,text,text,integer,boolean,integer,text,text) TO authenticated, service_role;

-- Lifecycle state ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_tenant_lifecycle(_reason text DEFAULT NULL)
RETURNS public.tenant_lifecycle_states LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid; _row public.tenant_lifecycle_states%ROWTYPE;
BEGIN
  _org := public.neo_recovery_require('view');
  INSERT INTO public.tenant_lifecycle_states (organization_id) VALUES (_org)
  ON CONFLICT (organization_id) DO NOTHING;
  SELECT * INTO _row FROM public.tenant_lifecycle_states WHERE organization_id=_org;
  RETURN _row;
END $$;
REVOKE ALL ON FUNCTION public.neo_tenant_lifecycle(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_tenant_lifecycle(text) TO authenticated, service_role;

-- Mark a snapshot as the offboarding export --------------------------------
CREATE OR REPLACE FUNCTION public.neo_tenant_set_export(_snapshot uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid; _snap public.tenant_snapshots%ROWTYPE; _verified boolean;
BEGIN
  _org := public.neo_recovery_require('manage');
  SELECT * INTO _snap FROM public.tenant_snapshots WHERE id=_snapshot AND organization_id=_org;
  IF _snap.id IS NULL THEN RAISE EXCEPTION 'Snapshot not found in this workspace' USING ERRCODE='42501'; END IF;
  IF _snap.status <> 'completed' OR _snap.scope <> 'tenant' THEN
    RAISE EXCEPTION 'The export must be a completed whole-workspace snapshot';
  END IF;
  SELECT coalesce(br.verified,false) INTO _verified FROM public.backup_records br WHERE br.id=_snap.backup_record_id;
  IF NOT coalesce(_verified,false) THEN
    RAISE EXCEPTION 'This snapshot has not passed a restore drill yet';
  END IF;

  PERFORM public.neo_tenant_lifecycle();
  UPDATE public.tenant_lifecycle_states
     SET export_snapshot_id=_snapshot, export_verified_at=now()
   WHERE organization_id=_org;
  RETURN jsonb_build_object('export_snapshot', _snapshot);
END $$;
REVOKE ALL ON FUNCTION public.neo_tenant_set_export(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_tenant_set_export(uuid) TO authenticated, service_role;

-- Suspend / resume -----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_tenant_suspend(_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid;
BEGIN
  _org := public.neo_recovery_require('manage');
  IF coalesce(btrim(_reason),'')='' THEN RAISE EXCEPTION 'A reason is required to suspend a workspace'; END IF;
  PERFORM public.neo_tenant_lifecycle();
  UPDATE public.tenant_lifecycle_states
     SET state='suspended', reason=_reason, suspended_at=now(), suspended_by=auth.uid()
   WHERE organization_id=_org AND state IN ('active','suspended');
  IF NOT FOUND THEN RAISE EXCEPTION 'This workspace cannot be suspended from its current state'; END IF;
  RETURN jsonb_build_object('state','suspended');
END $$;
REVOKE ALL ON FUNCTION public.neo_tenant_suspend(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_tenant_suspend(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_tenant_resume(_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid;
BEGIN
  _org := public.neo_recovery_require('manage');
  UPDATE public.tenant_lifecycle_states
     SET state='active', reason=_reason, suspended_at=NULL, suspended_by=NULL,
         deletion_requested_by=NULL, deletion_requested_at=NULL,
         deletion_approved_by=NULL, deletion_approved_at=NULL, grace_until=NULL
   WHERE organization_id=_org AND state IN ('suspended','pending_deletion');
  IF NOT FOUND THEN RAISE EXCEPTION 'This workspace is not suspended'; END IF;
  RETURN jsonb_build_object('state','active');
END $$;
REVOKE ALL ON FUNCTION public.neo_tenant_resume(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_tenant_resume(text) TO authenticated, service_role;

-- Deletion request / approval / cancellation ----------------------------------
CREATE OR REPLACE FUNCTION public.neo_tenant_request_deletion(_reason text, _grace_days integer DEFAULT 30)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid; _row public.tenant_lifecycle_states%ROWTYPE;
BEGIN
  _org := public.neo_recovery_require('manage');
  IF coalesce(btrim(_reason),'')='' THEN RAISE EXCEPTION 'A reason is required to request deletion'; END IF;
  IF _grace_days < 7 THEN RAISE EXCEPTION 'The grace period must be at least 7 days'; END IF;
  _row := public.neo_tenant_lifecycle();
  IF _row.state <> 'suspended' THEN RAISE EXCEPTION 'A workspace must be suspended before deletion can be requested'; END IF;
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
END $$;
REVOKE ALL ON FUNCTION public.neo_tenant_request_deletion(text,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_tenant_request_deletion(text,integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_tenant_approve_deletion(_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid; _row public.tenant_lifecycle_states%ROWTYPE;
BEGIN
  _org := public.neo_recovery_require('approve');
  SELECT * INTO _row FROM public.tenant_lifecycle_states WHERE organization_id=_org;
  IF _row.state <> 'pending_deletion' THEN RAISE EXCEPTION 'No deletion is pending for this workspace'; END IF;
  IF _row.deletion_requested_by = auth.uid() THEN
    RAISE EXCEPTION 'Deletion cannot be approved by the person who requested it';
  END IF;
  UPDATE public.tenant_lifecycle_states
     SET deletion_approved_by=auth.uid(), deletion_approved_at=now(),
         reason=coalesce(nullif(btrim(coalesce(_reason,'')),''), reason)
   WHERE organization_id=_org;
  RETURN jsonb_build_object('state','pending_deletion','approved',true);
END $$;
REVOKE ALL ON FUNCTION public.neo_tenant_approve_deletion(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_tenant_approve_deletion(text) TO authenticated, service_role;
