BEGIN;

CREATE INDEX IF NOT EXISTS print_jobs_pos_receipt_history_idx
  ON public.print_jobs (
    organization_id,
    order_id,
    document_type,
    status,
    created_at DESC
  )
  WHERE order_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.neo_print_enqueue(
  _printer uuid,
  _document_type text,
  _title text DEFAULT NULL,
  _payload jsonb DEFAULT '{}'::jsonb,
  _idempotency text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  p public.printer_profiles;
  j uuid;

  v_order_id uuid;
  v_order_text text;
  v_order_org uuid;
  v_order_branch uuid;

  v_is_duplicate boolean := false;
BEGIN
  SELECT *
  INTO p
  FROM public.printer_profiles
  WHERE id = _printer;

  IF p.id IS NULL THEN
    RAISE EXCEPTION 'Printer not found';
  END IF;

  IF p.organization_id <> public.current_org_id() THEN
    RAISE EXCEPTION 'Printer belongs to another workspace';
  END IF;

  /*
   * An explicit idempotency retry returns the original job.
   * This is the same print request, not a reprint.
   */
  IF _idempotency IS NOT NULL THEN
    SELECT id
    INTO j
    FROM public.print_jobs
    WHERE organization_id = p.organization_id
      AND idempotency_key = _idempotency;

    IF j IS NOT NULL THEN
      RETURN j;
    END IF;
  END IF;

  /*
   * POS RECEIPTS
   *
   * First successful physical print:
   *   pos.receipts.print
   *
   * Any new print after a successful physical print:
   *   pos.receipts.reprint
   *
   * Failed attempts and retries of the same job are not reprints.
   */
  IF _document_type = 'pos_receipt' THEN

    v_order_text :=
      NULLIF(
        BTRIM(
          COALESCE(
            _payload ->> 'document_id',
            _payload ->> 'order_id',
            ''
          )
        ),
        ''
      );

    IF v_order_text IS NULL THEN
      RAISE EXCEPTION 'POS receipt print requires an order id';
    END IF;

    BEGIN
      v_order_id := v_order_text::uuid;
    EXCEPTION
      WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'Invalid POS order id';
    END;

    SELECT
      o.organization_id,
      o.branch_id
    INTO
      v_order_org,
      v_order_branch
    FROM public.pos_orders o
    WHERE o.id = v_order_id;

    IF v_order_org IS NULL THEN
      RAISE EXCEPTION 'POS order not found';
    END IF;

    IF v_order_org <> p.organization_id THEN
      RAISE EXCEPTION 'POS order belongs to another workspace';
    END IF;

    IF NOT public.neo_branch_in_scope(v_order_branch) THEN
      RAISE EXCEPTION 'POS order belongs to a property outside your access scope';
    END IF;

    /*
     * Serialize print creation for this order so two fast clicks cannot both
     * create independent "first print" jobs.
     */
    PERFORM pg_advisory_xact_lock(
      hashtextextended(v_order_id::text, 0)
    );

    /*
     * If the first print is already queued, return that same job rather than
     * creating another physical copy.
     */
    SELECT pj.id
    INTO j
    FROM public.print_jobs pj
    WHERE pj.organization_id = p.organization_id
      AND pj.order_id = v_order_id
      AND pj.document_type = 'pos_receipt'
      AND pj.status = 'queued'
    ORDER BY pj.created_at DESC
    LIMIT 1;

    IF j IS NOT NULL THEN
      RETURN j;
    END IF;

    /*
     * A receipt becomes a reprint only after a previous physical print was
     * explicitly confirmed successful.
     */
    SELECT EXISTS (
      SELECT 1
      FROM public.print_jobs pj
      WHERE pj.organization_id = p.organization_id
        AND pj.order_id = v_order_id
        AND pj.document_type = 'pos_receipt'
        AND pj.status = 'completed'
        AND pj.completed_at IS NOT NULL
    )
    INTO v_is_duplicate;

    IF v_is_duplicate THEN
      IF NOT (
        public.has_permission('pos', 'receipts.reprint')
        OR public.has_permission('pos', 'settings.manage')
        OR public.is_org_admin_for(p.organization_id)
      ) THEN
        RAISE EXCEPTION 'receipt_reprint_permission_required';
      END IF;
    ELSE
      IF NOT (
        public.has_permission('pos', 'receipts.print')
        OR public.has_permission('pos', 'settings.manage')
        OR public.is_org_admin_for(p.organization_id)
      ) THEN
        RAISE EXCEPTION 'permission_denied';
      END IF;
    END IF;

  ELSE

    /*
     * Preserve the existing authorization behaviour for non-POS documents.
     * Their permission model is outside this POS receipt repair.
     */
    IF NOT (
      public.has_permission('pos', 'receipts.print')
      OR public.has_permission('pos', 'settings.manage')
      OR public.is_org_admin_for(p.organization_id)
    ) THEN
      RAISE EXCEPTION 'permission_denied';
    END IF;

  END IF;

  INSERT INTO public.print_jobs (
    organization_id,
    branch_id,
    printer_id,
    original_printer_id,
    order_id,
    document_type,
    is_duplicate,
    title,
    payload,
    status,
    max_attempts,
    idempotency_key,
    created_by
  )
  VALUES (
    p.organization_id,
    CASE
      WHEN _document_type = 'pos_receipt'
        THEN v_order_branch
      ELSE p.branch_id
    END,
    p.id,
    p.id,
    v_order_id,
    _document_type,
    v_is_duplicate,
    _title,
    COALESCE(_payload, '{}'::jsonb),
    'queued',
    GREATEST(1, COALESCE(p.retry_limit, 3)),
    _idempotency,
    auth.uid()
  )
  RETURNING id INTO j;

  RETURN j;
END;
$$;


CREATE OR REPLACE FUNCTION public.neo_print_record_result(
  _job uuid,
  _success boolean,
  _error text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  jb public.print_jobs;
  fb uuid;
  new_status text;
  fell_over boolean := false;
  backoff integer;
BEGIN
  SELECT *
  INTO jb
  FROM public.print_jobs
  WHERE id = _job;

  IF jb.id IS NULL THEN
    RAISE EXCEPTION 'Print job not found';
  END IF;

  IF jb.organization_id <> public.current_org_id() THEN
    RAISE EXCEPTION 'Print job belongs to another workspace';
  END IF;

  IF jb.document_type = 'pos_receipt' THEN

    IF jb.is_duplicate THEN
      IF NOT (
        public.has_permission('pos', 'receipts.reprint')
        OR public.has_permission('pos', 'settings.manage')
        OR public.is_org_admin_for(jb.organization_id)
      ) THEN
        RAISE EXCEPTION 'receipt_reprint_permission_required';
      END IF;
    ELSE
      IF NOT (
        public.has_permission('pos', 'receipts.print')
        OR public.has_permission('pos', 'settings.manage')
        OR public.is_org_admin_for(jb.organization_id)
      ) THEN
        RAISE EXCEPTION 'permission_denied';
      END IF;
    END IF;

  ELSE

    /*
     * Preserve previous authorization behaviour for other document types.
     */
    IF NOT (
      public.has_permission('pos', 'receipts.print')
      OR public.has_permission('pos', 'settings.manage')
      OR public.is_org_admin_for(jb.organization_id)
    ) THEN
      RAISE EXCEPTION 'permission_denied';
    END IF;

  END IF;

  IF _success THEN
    UPDATE public.print_jobs
    SET
      status = 'completed',
      attempts = attempts + 1,
      completed_at = now(),
      last_error = NULL,
      updated_at = now()
    WHERE id = _job;

    UPDATE public.printer_profiles
    SET
      health_status = 'online',
      last_success_at = now(),
      last_checked_at = now(),
      last_error = NULL
    WHERE id = jb.printer_id;

    RETURN jsonb_build_object(
      'status', 'completed',
      'failed_over', false,
      'is_duplicate', jb.is_duplicate
    );
  END IF;

  SELECT
    fallback_printer_id,
    COALESCE(retry_backoff_seconds, 30)
  INTO
    fb,
    backoff
  FROM public.printer_profiles
  WHERE id = jb.printer_id;

  UPDATE public.printer_profiles
  SET
    health_status = 'error',
    last_failure_at = now(),
    last_checked_at = now(),
    last_error = _error
  WHERE id = jb.printer_id;

  IF jb.attempts + 1 < jb.max_attempts THEN

    new_status := 'queued';

    UPDATE public.print_jobs
    SET
      status = 'queued',
      attempts = attempts + 1,
      last_error = _error,
      next_attempt_at = now() + make_interval(secs => backoff),
      updated_at = now()
    WHERE id = _job;

  ELSIF fb IS NOT NULL AND NOT jb.failed_over THEN

    new_status := 'queued';
    fell_over := true;

    UPDATE public.print_jobs
    SET
      status = 'queued',
      attempts = 0,
      printer_id = fb,
      failed_over = true,
      last_error = _error,
      next_attempt_at = now(),
      updated_at = now()
    WHERE id = _job;

  ELSE

    new_status := 'failed';

    UPDATE public.print_jobs
    SET
      status = 'failed',
      attempts = attempts + 1,
      last_error = _error,
      updated_at = now()
    WHERE id = _job;

  END IF;

  RETURN jsonb_build_object(
    'status', new_status,
    'failed_over', fell_over,
    'is_duplicate', jb.is_duplicate
  );
END;
$$;


CREATE OR REPLACE FUNCTION public.neo_print_retry(
  _job uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  jb public.print_jobs;
BEGIN
  SELECT *
  INTO jb
  FROM public.print_jobs
  WHERE id = _job;

  IF jb.id IS NULL THEN
    RAISE EXCEPTION 'Print job not found';
  END IF;

  IF jb.organization_id <> public.current_org_id() THEN
    RAISE EXCEPTION 'Print job belongs to another workspace';
  END IF;

  /*
   * Retrying the SAME job does not change first-print/reprint classification.
   */
  IF jb.document_type = 'pos_receipt' THEN

    IF jb.is_duplicate THEN
      IF NOT (
        public.has_permission('pos', 'receipts.reprint')
        OR public.has_permission('pos', 'settings.manage')
        OR public.is_org_admin_for(jb.organization_id)
      ) THEN
        RAISE EXCEPTION 'receipt_reprint_permission_required';
      END IF;
    ELSE
      IF NOT (
        public.has_permission('pos', 'receipts.print')
        OR public.has_permission('pos', 'settings.manage')
        OR public.is_org_admin_for(jb.organization_id)
      ) THEN
        RAISE EXCEPTION 'permission_denied';
      END IF;
    END IF;

  ELSE

    IF NOT (
      public.has_permission('pos', 'receipts.print')
      OR public.has_permission('pos', 'settings.manage')
      OR public.is_org_admin_for(jb.organization_id)
    ) THEN
      RAISE EXCEPTION 'permission_denied';
    END IF;

  END IF;

  UPDATE public.print_jobs
  SET
    status = 'queued',
    attempts = 0,
    next_attempt_at = now(),
    last_error = NULL,
    completed_at = NULL,
    updated_at = now()
  WHERE id = _job;

  RETURN _job;
END;
$$;


REVOKE ALL
ON FUNCTION public.neo_print_enqueue(uuid,text,text,jsonb,text)
FROM PUBLIC, anon;

REVOKE ALL
ON FUNCTION public.neo_print_record_result(uuid,boolean,text)
FROM PUBLIC, anon;

REVOKE ALL
ON FUNCTION public.neo_print_retry(uuid)
FROM PUBLIC, anon;


GRANT EXECUTE
ON FUNCTION public.neo_print_enqueue(uuid,text,text,jsonb,text)
TO authenticated, service_role;

GRANT EXECUTE
ON FUNCTION public.neo_print_record_result(uuid,boolean,text)
TO authenticated, service_role;

GRANT EXECUTE
ON FUNCTION public.neo_print_retry(uuid)
TO authenticated, service_role;

COMMIT;