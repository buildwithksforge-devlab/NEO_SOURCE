CREATE TABLE IF NOT EXISTS public.etims_settings (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  environment text NOT NULL DEFAULT 'sandbox',
  mode text NOT NULL DEFAULT 'oscu',
  base_url text,
  kra_pin text,
  branch_code text NOT NULL DEFAULT '00',
  device_serial text,
  cmc_key text,
  api_key text,
  enabled boolean NOT NULL DEFAULT false,
  auto_submit boolean NOT NULL DEFAULT true,
  last_check_at timestamptz,
  last_check_status text,
  last_check_detail text,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.etims_settings TO service_role;
ALTER TABLE public.etims_settings ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.neo_etims_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT COALESCE(public.is_org_admin(), false)
      OR COALESCE(public.has_permission('administration', 'workspace', 'edit'), false);
$fn$;

CREATE OR REPLACE FUNCTION public.neo_etims_settings_get()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE _org uuid := public.current_org_id(); _row public.etims_settings%ROWTYPE;
BEGIN
  IF _org IS NULL THEN
    RETURN jsonb_build_object('authorised', false, 'reason', 'No organisation is linked to this account.');
  END IF;
  IF NOT public.neo_etims_admin() THEN
    RETURN jsonb_build_object('authorised', false, 'reason', 'You do not have permission to configure eTIMS.');
  END IF;

  SELECT * INTO _row FROM public.etims_settings WHERE organization_id = _org;

  RETURN jsonb_build_object(
    'authorised', true,
    'configured', _row.organization_id IS NOT NULL,
    'environment', COALESCE(_row.environment, 'sandbox'),
    'mode', COALESCE(_row.mode, 'oscu'),
    'base_url', _row.base_url,
    'kra_pin', _row.kra_pin,
    'branch_code', COALESCE(_row.branch_code, '00'),
    'device_serial', _row.device_serial,
    'has_cmc_key', NULLIF(btrim(COALESCE(_row.cmc_key, '')), '') IS NOT NULL,
    'has_api_key', NULLIF(btrim(COALESCE(_row.api_key, '')), '') IS NOT NULL,
    'enabled', COALESCE(_row.enabled, false),
    'auto_submit', COALESCE(_row.auto_submit, true),
    'last_check_at', _row.last_check_at,
    'last_check_status', _row.last_check_status,
    'last_check_detail', _row.last_check_detail
  );
END; $fn$;

CREATE OR REPLACE FUNCTION public.neo_etims_settings_save(
  _environment text, _mode text, _base_url text, _kra_pin text, _branch_code text,
  _device_serial text, _cmc_key text, _api_key text, _enabled boolean, _auto_submit boolean,
  _clear_secrets boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE _org uuid := public.current_org_id();
BEGIN
  IF _org IS NULL THEN
    RETURN jsonb_build_object('authorised', false, 'reason', 'No organisation is linked to this account.');
  END IF;
  IF NOT public.neo_etims_admin() THEN
    RETURN jsonb_build_object('authorised', false, 'reason', 'You do not have permission to configure eTIMS.');
  END IF;
  IF COALESCE(_environment, '') NOT IN ('sandbox', 'production') THEN
    RETURN jsonb_build_object('authorised', true, 'saved', false, 'reason', 'Environment must be sandbox or production.');
  END IF;
  IF COALESCE(_mode, '') NOT IN ('oscu', 'vscu') THEN
    RETURN jsonb_build_object('authorised', true, 'saved', false, 'reason', 'Mode must be OSCU or VSCU.');
  END IF;

  INSERT INTO public.etims_settings AS s (organization_id, environment, mode, base_url, kra_pin, branch_code,
                                          device_serial, cmc_key, api_key, enabled, auto_submit, updated_by, updated_at)
  VALUES (_org, _environment, _mode, NULLIF(btrim(COALESCE(_base_url, '')), ''), NULLIF(btrim(COALESCE(_kra_pin, '')), ''),
          COALESCE(NULLIF(btrim(COALESCE(_branch_code, '')), ''), '00'), NULLIF(btrim(COALESCE(_device_serial, '')), ''),
          NULLIF(btrim(COALESCE(_cmc_key, '')), ''), NULLIF(btrim(COALESCE(_api_key, '')), ''),
          COALESCE(_enabled, false), COALESCE(_auto_submit, true), auth.uid(), now())
  ON CONFLICT (organization_id) DO UPDATE
    SET environment = EXCLUDED.environment,
        mode = EXCLUDED.mode,
        base_url = EXCLUDED.base_url,
        kra_pin = EXCLUDED.kra_pin,
        branch_code = EXCLUDED.branch_code,
        device_serial = EXCLUDED.device_serial,
        cmc_key = CASE WHEN COALESCE(_clear_secrets, false) THEN NULL
                       WHEN EXCLUDED.cmc_key IS NOT NULL THEN EXCLUDED.cmc_key ELSE s.cmc_key END,
        api_key = CASE WHEN COALESCE(_clear_secrets, false) THEN NULL
                       WHEN EXCLUDED.api_key IS NOT NULL THEN EXCLUDED.api_key ELSE s.api_key END,
        enabled = EXCLUDED.enabled,
        auto_submit = EXCLUDED.auto_submit,
        updated_by = auth.uid(),
        updated_at = now();

  INSERT INTO public.audit_logs (organization_id, user_id, action, module, record_id, new_value)
  VALUES (_org, auth.uid(), 'integration.etims.settings_saved', 'finance', _org::text,
          jsonb_build_object('environment', _environment, 'mode', _mode, 'enabled', _enabled));

  RETURN jsonb_build_object('authorised', true, 'saved', true);
END; $fn$;

CREATE OR REPLACE FUNCTION public.neo_etims_record_check(_status text, _detail text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE _org uuid := public.current_org_id();
BEGIN
  IF _org IS NULL OR NOT public.neo_etims_admin() THEN
    RETURN jsonb_build_object('recorded', false);
  END IF;
  UPDATE public.etims_settings
     SET last_check_at = now(), last_check_status = _status, last_check_detail = _detail
   WHERE organization_id = _org;
  RETURN jsonb_build_object('recorded', true);
END; $fn$;

CREATE OR REPLACE FUNCTION public.neo_etims_queue_document(_invoice uuid, _credit_note uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  _org uuid := public.current_org_id();
  _inv public.invoices%ROWTYPE;
  _cn public.credit_notes%ROWTYPE;
  _branch uuid; _kind text; _number text; _key text; _id uuid; _enabled boolean;
BEGIN
  IF _org IS NULL THEN
    RETURN jsonb_build_object('queued', false, 'reason', 'No organisation is linked to this account.');
  END IF;
  IF NOT (public.has_permission('finance', 'edit') OR public.is_org_admin()) THEN
    RETURN jsonb_build_object('queued', false, 'reason', 'You do not have permission to file tax documents.');
  END IF;

  SELECT COALESCE(enabled, false) INTO _enabled FROM public.etims_settings WHERE organization_id = _org;
  IF NOT COALESCE(_enabled, false) THEN
    RETURN jsonb_build_object('queued', false, 'reason', 'eTIMS is not configured and enabled for this organisation.');
  END IF;

  IF _credit_note IS NOT NULL THEN
    SELECT * INTO _cn FROM public.credit_notes WHERE id = _credit_note AND organization_id = _org;
    IF _cn.id IS NULL THEN RETURN jsonb_build_object('queued', false, 'reason', 'Credit note not found.'); END IF;
    _branch := _cn.branch_id; _kind := 'credit_note'; _number := _cn.note_number;
  ELSE
    SELECT * INTO _inv FROM public.invoices WHERE id = _invoice AND organization_id = _org;
    IF _inv.id IS NULL THEN RETURN jsonb_build_object('queued', false, 'reason', 'Invoice not found.'); END IF;
    IF _inv.status = 'draft' THEN
      RETURN jsonb_build_object('queued', false, 'reason', 'Only issued invoices can be filed.');
    END IF;
    _branch := _inv.branch_id; _kind := 'invoice'; _number := _inv.invoice_number;
  END IF;

  _key := _kind || ':' || _number;

  INSERT INTO public.etims_submissions (organization_id, branch_id, document_kind, invoice_id, credit_note_id,
                                        document_number, idempotency_key, status, created_by)
  VALUES (_org, _branch, _kind, _invoice, _credit_note, _number, _key, 'queued', auth.uid())
  ON CONFLICT (organization_id, idempotency_key) DO UPDATE
    SET status = CASE WHEN public.etims_submissions.status IN ('accepted', 'submitted')
                      THEN public.etims_submissions.status ELSE 'queued' END,
        updated_at = now()
  RETURNING id INTO _id;

  IF _invoice IS NOT NULL THEN
    UPDATE public.invoices SET etims_status = 'queued'
     WHERE id = _invoice AND etims_status <> 'accepted';
  END IF;

  RETURN jsonb_build_object('queued', true, 'submission', _id, 'document_number', _number, 'kind', _kind);
END; $fn$;

CREATE OR REPLACE FUNCTION public.neo_etims_apply_result(
  _submission uuid, _status text, _kra_reference text DEFAULT NULL, _control_unit_reference text DEFAULT NULL,
  _qr_payload text DEFAULT NULL, _error text DEFAULT NULL,
  _request jsonb DEFAULT '{}'::jsonb, _response jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE _s public.etims_submissions%ROWTYPE; _attempt integer;
BEGIN
  IF _status NOT IN ('submitted', 'accepted', 'rejected', 'failed', 'retry_required') THEN
    RAISE EXCEPTION 'Unsupported eTIMS status %', _status;
  END IF;

  SELECT * INTO _s FROM public.etims_submissions WHERE id = _submission FOR UPDATE;
  IF _s.id IS NULL THEN RETURN jsonb_build_object('applied', false, 'reason', 'Submission not found.'); END IF;

  _attempt := COALESCE(_s.attempts, 0) + 1;

  UPDATE public.etims_submissions
     SET status = _status,
         kra_reference = COALESCE(NULLIF(btrim(COALESCE(_kra_reference, '')), ''), kra_reference),
         control_unit_reference = COALESCE(NULLIF(btrim(COALESCE(_control_unit_reference, '')), ''), control_unit_reference),
         qr_payload = COALESCE(NULLIF(btrim(COALESCE(_qr_payload, '')), ''), qr_payload),
         error_details = CASE WHEN _status IN ('accepted', 'submitted') THEN NULL ELSE _error END,
         attempts = _attempt,
         last_attempt_at = now(),
         updated_at = now()
   WHERE id = _submission;

  INSERT INTO public.etims_submission_attempts (organization_id, submission_id, attempt_number,
                                                request_summary, response_summary, outcome)
  VALUES (_s.organization_id, _s.id, _attempt, COALESCE(_request, '{}'::jsonb), COALESCE(_response, '{}'::jsonb),
          CASE WHEN _status IN ('accepted', 'submitted') THEN 'succeeded' ELSE 'failed' END);

  IF _s.invoice_id IS NOT NULL THEN
    UPDATE public.invoices SET etims_status = _status WHERE id = _s.invoice_id;
  END IF;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, action, module, record_id, new_value)
  VALUES (_s.organization_id, _s.branch_id, _s.created_by, 'integration.etims.' || _status, 'finance', _s.id::text,
          jsonb_build_object('document', _s.document_number, 'kra_reference', _kra_reference, 'error', _error));

  RETURN jsonb_build_object('applied', true, 'status', _status, 'attempt', _attempt);
END; $fn$;

REVOKE ALL ON FUNCTION public.neo_etims_admin() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_etims_settings_get() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_etims_settings_save(text,text,text,text,text,text,text,text,boolean,boolean,boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_etims_record_check(text,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_etims_queue_document(uuid,uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_etims_apply_result(uuid,text,text,text,text,text,jsonb,jsonb) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.neo_etims_admin() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_etims_settings_get() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_etims_settings_save(text,text,text,text,text,text,text,text,boolean,boolean,boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_etims_record_check(text,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_etims_queue_document(uuid,uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_etims_apply_result(uuid,text,text,text,text,text,jsonb,jsonb) TO service_role;