
ALTER TABLE public.printer_profiles
  ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES public.departments(id),
  ADD COLUMN IF NOT EXISTS fallback_printer_id uuid REFERENCES public.printer_profiles(id),
  ADD COLUMN IF NOT EXISTS retry_limit integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS retry_backoff_seconds integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS health_status text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS last_success_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_failure_at timestamptz;

ALTER TABLE public.print_jobs
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id),
  ADD COLUMN IF NOT EXISTS original_printer_id uuid REFERENCES public.printer_profiles(id),
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS failed_over boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS print_jobs_idem_uidx
  ON public.print_jobs(organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS print_jobs_queue_idx ON public.print_jobs(organization_id, status, next_attempt_at);
CREATE INDEX IF NOT EXISTS print_jobs_printer_idx ON public.print_jobs(printer_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON public.print_jobs TO authenticated;
GRANT ALL ON public.print_jobs TO service_role;

CREATE OR REPLACE FUNCTION public.neo_print_enqueue(
  _printer uuid, _document_type text, _title text DEFAULT NULL,
  _payload jsonb DEFAULT '{}'::jsonb, _idempotency text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p public.printer_profiles; j uuid;
BEGIN
  SELECT * INTO p FROM public.printer_profiles WHERE id = _printer;
  IF p.id IS NULL THEN RAISE EXCEPTION 'Printer not found'; END IF;
  IF p.organization_id <> current_org_id() THEN RAISE EXCEPTION 'Printer belongs to another workspace'; END IF;
  IF NOT (has_permission('pos','receipts.print') OR has_permission('pos','settings.manage') OR is_org_admin_for(p.organization_id)) THEN
    RAISE EXCEPTION 'permission_denied';
  END IF;
  IF _idempotency IS NOT NULL THEN
    SELECT id INTO j FROM public.print_jobs WHERE organization_id = p.organization_id AND idempotency_key = _idempotency;
    IF j IS NOT NULL THEN RETURN j; END IF;
  END IF;
  INSERT INTO public.print_jobs(organization_id, branch_id, printer_id, original_printer_id, document_type, title, payload, status, max_attempts, idempotency_key, created_by)
  VALUES (p.organization_id, p.branch_id, p.id, p.id, _document_type, _title, coalesce(_payload,'{}'::jsonb), 'queued', greatest(1, coalesce(p.retry_limit,3)), _idempotency, auth.uid())
  RETURNING id INTO j;
  RETURN j;
END $$;

CREATE OR REPLACE FUNCTION public.neo_print_record_result(_job uuid, _success boolean, _error text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE jb public.print_jobs; fb uuid; new_status text; fell_over boolean := false; backoff integer;
BEGIN
  SELECT * INTO jb FROM public.print_jobs WHERE id = _job;
  IF jb.id IS NULL THEN RAISE EXCEPTION 'Print job not found'; END IF;
  IF jb.organization_id <> current_org_id() THEN RAISE EXCEPTION 'Print job belongs to another workspace'; END IF;
  IF NOT (has_permission('pos','receipts.print') OR has_permission('pos','settings.manage') OR is_org_admin_for(jb.organization_id)) THEN
    RAISE EXCEPTION 'permission_denied';
  END IF;

  IF _success THEN
    UPDATE public.print_jobs SET status='completed', attempts=attempts+1, completed_at=now(), last_error=NULL WHERE id=_job;
    UPDATE public.printer_profiles SET health_status='online', last_success_at=now(), last_checked_at=now(), last_error=NULL WHERE id=jb.printer_id;
    RETURN jsonb_build_object('status','completed','failed_over',false);
  END IF;

  SELECT fallback_printer_id, coalesce(retry_backoff_seconds,30) INTO fb, backoff
  FROM public.printer_profiles WHERE id = jb.printer_id;

  UPDATE public.printer_profiles
     SET health_status='error', last_failure_at=now(), last_checked_at=now(), last_error=_error
   WHERE id = jb.printer_id;

  IF jb.attempts + 1 < jb.max_attempts THEN
    new_status := 'queued';
    UPDATE public.print_jobs
       SET status='queued', attempts=attempts+1, last_error=_error,
           next_attempt_at = now() + make_interval(secs => backoff)
     WHERE id=_job;
  ELSIF fb IS NOT NULL AND NOT jb.failed_over THEN
    new_status := 'queued'; fell_over := true;
    UPDATE public.print_jobs
       SET status='queued', attempts=0, printer_id=fb, failed_over=true, last_error=_error, next_attempt_at=now()
     WHERE id=_job;
  ELSE
    new_status := 'failed';
    UPDATE public.print_jobs SET status='failed', attempts=attempts+1, last_error=_error WHERE id=_job;
  END IF;

  RETURN jsonb_build_object('status', new_status, 'failed_over', fell_over);
END $$;

CREATE OR REPLACE FUNCTION public.neo_print_retry(_job uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE jb public.print_jobs;
BEGIN
  SELECT * INTO jb FROM public.print_jobs WHERE id=_job;
  IF jb.id IS NULL THEN RAISE EXCEPTION 'Print job not found'; END IF;
  IF jb.organization_id <> current_org_id() THEN RAISE EXCEPTION 'Print job belongs to another workspace'; END IF;
  IF NOT (has_permission('pos','receipts.print') OR has_permission('pos','settings.manage') OR is_org_admin_for(jb.organization_id)) THEN
    RAISE EXCEPTION 'permission_denied';
  END IF;
  UPDATE public.print_jobs SET status='queued', attempts=0, next_attempt_at=now(), last_error=NULL WHERE id=_job;
  RETURN _job;
END $$;

REVOKE ALL ON FUNCTION public.neo_print_enqueue(uuid,text,text,jsonb,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.neo_print_record_result(uuid,boolean,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.neo_print_retry(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_print_enqueue(uuid,text,text,jsonb,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_print_record_result(uuid,boolean,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_print_retry(uuid) TO authenticated;
