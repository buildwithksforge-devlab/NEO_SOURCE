BEGIN;

-- ============================================================
-- NEØ physical printing
-- Trusted property agents, atomic claims, strict routing,
-- retries/failover, receipt payloads and production tickets.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.neo_print_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid
    REFERENCES public.branches(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT neo_print_agents_name_chk
    CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  CONSTRAINT neo_print_agents_token_hash_chk
    CHECK (token_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS neo_print_agents_scope_idx
  ON public.neo_print_agents (
    organization_id,
    branch_id,
    active
  );

ALTER TABLE public.neo_print_agents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS neo_print_agents_select
  ON public.neo_print_agents;

CREATE POLICY neo_print_agents_select
  ON public.neo_print_agents
  FOR SELECT
  TO authenticated
  USING (
    organization_id = public.current_org_id()
    AND (
      public.is_org_admin_for(organization_id)
      OR public.has_permission('integrations', 'edit')
      OR public.has_permission('pos', 'settings.manage')
    )
    AND (
      branch_id IS NULL
      OR public.neo_branch_in_scope(branch_id)
    )
  );

DROP POLICY IF EXISTS neo_print_agents_write
  ON public.neo_print_agents;

CREATE POLICY neo_print_agents_write
  ON public.neo_print_agents
  FOR ALL
  TO authenticated
  USING (
    organization_id = public.current_org_id()
    AND (
      public.is_org_admin_for(organization_id)
      OR public.has_permission('integrations', 'edit')
      OR public.has_permission('pos', 'settings.manage')
    )
    AND (
      branch_id IS NULL
      OR public.neo_branch_in_scope(branch_id)
    )
  )
  WITH CHECK (
    organization_id = public.current_org_id()
    AND (
      public.is_org_admin_for(organization_id)
      OR public.has_permission('integrations', 'edit')
      OR public.has_permission('pos', 'settings.manage')
    )
    AND (
      branch_id IS NULL
      OR public.neo_branch_in_scope(branch_id)
    )
  );

GRANT SELECT, INSERT, UPDATE
  ON public.neo_print_agents
  TO authenticated;

GRANT ALL
  ON public.neo_print_agents
  TO service_role;


ALTER TABLE public.print_jobs
  ADD COLUMN IF NOT EXISTS claim_id uuid,
  ADD COLUMN IF NOT EXISTS claimed_by_agent_id uuid
    REFERENCES public.neo_print_agents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS print_jobs_agent_queue_idx
  ON public.print_jobs (
    printer_id,
    status,
    next_attempt_at,
    created_at
  );

CREATE INDEX IF NOT EXISTS print_jobs_active_claim_idx
  ON public.print_jobs (
    claimed_by_agent_id,
    claim_expires_at
  )
  WHERE status = 'printing';


CREATE OR REPLACE FUNCTION public.neo_print_agent_register(
  _branch uuid,
  _name text,
  _token_hash text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.current_org_id();
  v_agent uuid;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'no_organisation'
      USING ERRCODE = '42501';
  END IF;

  IF NOT (
    public.is_org_admin_for(v_org)
    OR public.has_permission('integrations', 'edit')
    OR public.has_permission('pos', 'settings.manage')
  ) THEN
    RAISE EXCEPTION 'permission_denied'
      USING ERRCODE = '42501';
  END IF;

  IF _branch IS NULL THEN
    RAISE EXCEPTION 'property_required'
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.branches b
    WHERE b.id = _branch
      AND b.organization_id = v_org
      AND public.neo_branch_in_scope(b.id)
  ) THEN
    RAISE EXCEPTION 'property_out_of_scope'
      USING ERRCODE = '42501';
  END IF;

  IF length(btrim(coalesce(_name, ''))) < 2 THEN
    RAISE EXCEPTION 'agent_name_required'
      USING ERRCODE = '22023';
  END IF;

  IF lower(coalesce(_token_hash, ''))
       !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_token_hash'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.neo_print_agents (
    organization_id,
    branch_id,
    name,
    token_hash,
    active,
    created_by
  )
  VALUES (
    v_org,
    _branch,
    btrim(_name),
    lower(_token_hash),
    true,
    auth.uid()
  )
  RETURNING id INTO v_agent;

  RETURN v_agent;
END;
$$;


CREATE OR REPLACE FUNCTION public.neo_print_agent_revoke(
  _agent uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.current_org_id();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'no_organisation'
      USING ERRCODE = '42501';
  END IF;

  IF NOT (
    public.is_org_admin_for(v_org)
    OR public.has_permission('integrations', 'edit')
    OR public.has_permission('pos', 'settings.manage')
  ) THEN
    RAISE EXCEPTION 'permission_denied'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.neo_print_agents
  SET
    active = false,
    updated_at = now()
  WHERE id = _agent
    AND organization_id = v_org;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'print_agent_not_found'
      USING ERRCODE = 'P0002';
  END IF;

  RETURN _agent;
END;
$$;


CREATE OR REPLACE FUNCTION public.neo_print_validate_job()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_printer public.printer_profiles;
  v_original public.printer_profiles;
  v_order public.pos_orders;
  v_station uuid;
BEGIN
  IF NEW.printer_id IS NULL THEN
    RAISE EXCEPTION 'print_job_requires_printer';
  END IF;

  SELECT *
  INTO v_printer
  FROM public.printer_profiles
  WHERE id = NEW.printer_id;

  IF v_printer.id IS NULL OR NOT v_printer.active THEN
    RAISE EXCEPTION 'printer_not_available';
  END IF;

  IF v_printer.organization_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'printer_workspace_mismatch';
  END IF;

  IF NEW.branch_id IS NULL
     OR v_printer.branch_id IS DISTINCT FROM NEW.branch_id THEN
    RAISE EXCEPTION 'printer_property_mismatch';
  END IF;

  IF NEW.original_printer_id IS NULL THEN
    NEW.original_printer_id := NEW.printer_id;
  END IF;

  SELECT *
  INTO v_original
  FROM public.printer_profiles
  WHERE id = NEW.original_printer_id;

  IF v_original.id IS NULL
     OR v_original.organization_id <> NEW.organization_id
     OR v_original.branch_id IS DISTINCT FROM NEW.branch_id THEN
    RAISE EXCEPTION 'original_printer_scope_mismatch';
  END IF;

  IF NEW.printer_id <> NEW.original_printer_id THEN
    IF v_printer.department_id
         IS DISTINCT FROM v_original.department_id
       OR v_printer.station_id
         IS DISTINCT FROM v_original.station_id
       OR v_printer.printer_role
         IS DISTINCT FROM v_original.printer_role THEN
      RAISE EXCEPTION 'fallback_printer_scope_mismatch';
    END IF;
  END IF;

  IF NEW.document_type = 'pos_receipt' THEN
    IF NEW.order_id IS NULL THEN
      RAISE EXCEPTION 'pos_receipt_requires_order';
    END IF;

    SELECT *
    INTO v_order
    FROM public.pos_orders
    WHERE id = NEW.order_id;

    IF v_order.id IS NULL
       OR v_order.organization_id <> NEW.organization_id
       OR v_order.branch_id IS DISTINCT FROM NEW.branch_id THEN
      RAISE EXCEPTION 'pos_receipt_order_scope_mismatch';
    END IF;

    IF lower(coalesce(v_printer.printer_role, ''))
         NOT IN ('receipt', 'restaurant', 'pos') THEN
      RAISE EXCEPTION 'pos_receipt_printer_role_mismatch';
    END IF;

    IF NOT coalesce(NEW.payload, '{}'::jsonb) ? 'document' THEN
      NEW.payload :=
        coalesce(NEW.payload, '{}'::jsonb)
        || jsonb_build_object(
          'document',
          public.neo_document_payload(
            'pos_receipt',
            NEW.order_id
          )
        );
    END IF;
  END IF;

  IF NEW.document_type = 'production_ticket' THEN
    BEGIN
      v_station :=
        nullif(NEW.payload ->> 'station_id', '')::uuid;
    EXCEPTION
      WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'invalid_production_station';
    END;

    IF v_station IS NULL
       OR v_printer.station_id IS DISTINCT FROM v_station THEN
      RAISE EXCEPTION 'production_printer_station_mismatch';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS neo_print_validate_job_trg
  ON public.print_jobs;

CREATE TRIGGER neo_print_validate_job_trg
BEFORE INSERT OR UPDATE OF printer_id
ON public.print_jobs
FOR EACH ROW
EXECUTE FUNCTION public.neo_print_validate_job();


CREATE OR REPLACE FUNCTION public.neo_print_queue_station_tickets(
  _order uuid,
  _org uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ticket record;
  v_printer public.printer_profiles;
  v_job uuid;
  v_queued integer := 0;
  v_already integer := 0;
  v_unconfigured integer := 0;
  v_lines jsonb;
  v_idempotency text;
BEGIN
  FOR v_ticket IN
    SELECT
      t.id AS ticket_id,
      t.ticket_number,
      t.organization_id,
      t.branch_id,
      t.station_id,
      s.name AS station_name,
      s.code AS station_code,
      o.order_number,
      o.order_type,
      o.guest_count,
      o.guest_name,
      o.dietary_notes,
      o.allergy_alert,
      rt.code AS table_code
    FROM public.station_tickets t
    JOIN public.operational_stations s
      ON s.id = t.station_id
    JOIN public.pos_orders o
      ON o.id = t.order_id
    LEFT JOIN public.restaurant_tables rt
      ON rt.id = o.table_id
    WHERE t.order_id = _order
      AND t.organization_id = _org
      AND t.status <> 'cancelled'
    ORDER BY t.created_at, t.id
  LOOP
    v_idempotency :=
      'production-ticket:' || v_ticket.ticket_id::text;

    IF EXISTS (
      SELECT 1
      FROM public.print_jobs j
      WHERE j.organization_id = _org
        AND j.idempotency_key = v_idempotency
    ) THEN
      v_already := v_already + 1;
      CONTINUE;
    END IF;

    SELECT p.*
    INTO v_printer
    FROM public.printer_profiles p
    WHERE p.organization_id = _org
      AND p.branch_id = v_ticket.branch_id
      AND p.station_id = v_ticket.station_id
      AND p.active
      AND nullif(btrim(coalesce(p.address, '')), '')
          IS NOT NULL
      AND lower(coalesce(p.printer_role, ''))
          IN (
            'production',
            'kitchen',
            'coffee',
            'bar',
            'pastry'
          )
    ORDER BY
      CASE
        WHEN p.health_status = 'online' THEN 0
        ELSE 1
      END,
      p.created_at,
      p.id
    LIMIT 1;

    IF v_printer.id IS NULL THEN
      v_unconfigured := v_unconfigured + 1;
      CONTINUE;
    END IF;

    SELECT
      jsonb_build_array(
        'NEØ PRODUCTION TICKET',
        'Station: ' || coalesce(
          v_ticket.station_name,
          v_ticket.station_code,
          'Production'
        ),
        'Ticket: ' || coalesce(
          v_ticket.ticket_number,
          v_ticket.ticket_id::text
        ),
        'Order: ' || coalesce(
          v_ticket.order_number,
          _order::text
        ),
        CASE
          WHEN v_ticket.table_code IS NOT NULL
            THEN 'Table: ' || v_ticket.table_code
          ELSE 'Order type: ' ||
            initcap(
              replace(
                coalesce(v_ticket.order_type, 'order'),
                '_',
                ' '
              )
            )
        END,
        CASE
          WHEN coalesce(v_ticket.guest_count, 0) > 0
            THEN 'Guests: ' || v_ticket.guest_count::text
          ELSE NULL
        END,
        '--------------------------------'
      )
      ||
      coalesce(
        (
          SELECT jsonb_agg(
            to_jsonb(
              trim(
                to_char(oi.quantity, 'FM999999990.###')
              )
              || ' x '
              || oi.item_name
            )
            ORDER BY oi.created_at, oi.id
          )
          FROM public.station_ticket_items ti
          JOIN public.pos_order_items oi
            ON oi.id = ti.order_item_id
          WHERE ti.ticket_id = v_ticket.ticket_id
            AND ti.organization_id = _org
            AND oi.status <> 'voided'
        ),
        '[]'::jsonb
      )
      ||
      jsonb_build_array(
        '--------------------------------',
        CASE
          WHEN nullif(
            btrim(coalesce(v_ticket.allergy_alert, '')),
            ''
          ) IS NOT NULL
            THEN 'ALLERGY: ' || v_ticket.allergy_alert
          ELSE NULL
        END,
        CASE
          WHEN nullif(
            btrim(coalesce(v_ticket.dietary_notes, '')),
            ''
          ) IS NOT NULL
            THEN 'DIETARY: ' || v_ticket.dietary_notes
          ELSE NULL
        END,
        to_char(
          now() AT TIME ZONE 'Africa/Nairobi',
          'DD Mon YYYY HH24:MI'
        )
      )
    INTO v_lines;

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
      attempts,
      max_attempts,
      next_attempt_at,
      idempotency_key,
      created_by
    )
    VALUES (
      _org,
      v_ticket.branch_id,
      v_printer.id,
      v_printer.id,
      _order,
      'production_ticket',
      false,
      'Production ticket — '
        || coalesce(
          v_ticket.ticket_number,
          v_ticket.order_number,
          v_ticket.ticket_id::text
        ),
      jsonb_build_object(
        'ticket_id', v_ticket.ticket_id,
        'station_id', v_ticket.station_id,
        'station_name', coalesce(
          v_ticket.station_name,
          v_ticket.station_code
        ),
        'order_id', _order,
        'order_number', v_ticket.order_number,
        'lines', v_lines
      ),
      'queued',
      0,
      greatest(1, coalesce(v_printer.retry_limit, 3)),
      now(),
      v_idempotency,
      auth.uid()
    )
    ON CONFLICT (
      organization_id,
      idempotency_key
    )
    WHERE idempotency_key IS NOT NULL
    DO NOTHING
    RETURNING id INTO v_job;

    IF v_job IS NULL THEN
      v_already := v_already + 1;
    ELSE
      v_queued := v_queued + 1;
    END IF;

    v_printer := NULL;
    v_job := NULL;
  END LOOP;

  RETURN jsonb_build_object(
    'print_jobs_queued', v_queued,
    'print_jobs_existing', v_already,
    'print_stations_unconfigured', v_unconfigured
  );
END;
$$;


CREATE OR REPLACE FUNCTION public.neo_print_after_station_ticket_item()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order uuid;
  v_org uuid;
BEGIN
  SELECT
    ticket.order_id,
    ticket.organization_id
  INTO
    v_order,
    v_org
  FROM public.station_tickets ticket
  WHERE ticket.id = NEW.ticket_id;

  IF v_order IS NOT NULL AND v_org IS NOT NULL THEN
    PERFORM public.neo_print_queue_station_tickets(
      v_order,
      v_org
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS neo_print_after_station_ticket_item_trg
  ON public.station_ticket_items;

CREATE CONSTRAINT TRIGGER neo_print_after_station_ticket_item_trg
AFTER INSERT
ON public.station_ticket_items
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.neo_print_after_station_ticket_item();

REVOKE ALL
  ON FUNCTION public.neo_print_after_station_ticket_item()
  FROM PUBLIC, anon, authenticated;

-- Replace the earlier TABLE-returning printer-agent RPC atomically.
DROP FUNCTION IF EXISTS public.neo_print_agent_printers(text);

CREATE OR REPLACE FUNCTION public.neo_print_agent_printers(
  _token_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agent public.neo_print_agents;
  v_result jsonb;
BEGIN
  SELECT *
  INTO v_agent
  FROM public.neo_print_agents
  WHERE token_hash = lower(coalesce(_token_hash, ''))
    AND active;

  IF v_agent.id IS NULL THEN
    RAISE EXCEPTION 'invalid_print_agent_token'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.neo_print_agents
  SET
    last_seen_at = now(),
    updated_at = now()
  WHERE id = v_agent.id;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', p.id,
        'name', p.name,
        'branch_id', p.branch_id,
        'department_id', p.department_id,
        'station_id', p.station_id,
        'printer_role', p.printer_role,
        'connection_type', p.connection_type,
        'address', p.address,
        'health_status', p.health_status,
        'active', p.active
      )
      ORDER BY p.name, p.id
    ),
    '[]'::jsonb
  )
  INTO v_result
  FROM public.printer_profiles p
  WHERE p.organization_id = v_agent.organization_id
    AND p.active
    AND (
      v_agent.branch_id IS NULL
      OR p.branch_id = v_agent.branch_id
    );

  RETURN v_result;
END;
$$;


-- Replace the earlier TABLE-returning claim RPC atomically.
DROP FUNCTION IF EXISTS public.neo_print_agent_claim(text, uuid);

CREATE OR REPLACE FUNCTION public.neo_print_agent_claim(
  _token_hash text,
  _printer uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agent public.neo_print_agents;
  v_printer public.printer_profiles;
  v_job public.print_jobs;
  v_claim uuid;
BEGIN
  SELECT *
  INTO v_agent
  FROM public.neo_print_agents
  WHERE token_hash = lower(coalesce(_token_hash, ''))
    AND active;

  IF v_agent.id IS NULL THEN
    RAISE EXCEPTION 'invalid_print_agent_token'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
  INTO v_printer
  FROM public.printer_profiles
  WHERE id = _printer
    AND organization_id = v_agent.organization_id
    AND active
    AND (
      v_agent.branch_id IS NULL
      OR branch_id = v_agent.branch_id
    );

  IF v_printer.id IS NULL THEN
    RAISE EXCEPTION 'printer_not_available_to_agent'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.neo_print_agents
  SET
    last_seen_at = now(),
    updated_at = now()
  WHERE id = v_agent.id;

  UPDATE public.print_jobs
  SET
    status = 'failed',
    last_error =
      'Print-agent claim expired; physical outcome is unknown. Review before retrying.',
    claim_id = NULL,
    claimed_by_agent_id = NULL,
    claimed_at = NULL,
    claim_expires_at = NULL,
    updated_at = now()
  WHERE printer_id = _printer
    AND organization_id = v_agent.organization_id
    AND status = 'printing'
    AND claim_expires_at < now();

  SELECT j.*
  INTO v_job
  FROM public.print_jobs j
  WHERE j.printer_id = _printer
    AND j.organization_id = v_agent.organization_id
    AND j.branch_id = v_printer.branch_id
    AND j.status = 'queued'
    AND j.next_attempt_at <= now()
  ORDER BY
    j.next_attempt_at,
    j.created_at,
    j.id
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF v_job.id IS NULL THEN
    RETURN NULL;
  END IF;

  v_claim := gen_random_uuid();

  UPDATE public.print_jobs
  SET
    status = 'printing',
    claim_id = v_claim,
    claimed_by_agent_id = v_agent.id,
    claimed_at = now(),
    claim_expires_at = now() + interval '2 minutes',
    updated_at = now()
  WHERE id = v_job.id;

  RETURN jsonb_build_object(
    'job_id', v_job.id,
    'claim_id', v_claim,
    'document_type', v_job.document_type,
    'title', v_job.title,
    'payload', v_job.payload,
    'attempt', coalesce(v_job.attempts, 0) + 1,
    'max_attempts', v_job.max_attempts,
    'printer',
      jsonb_build_object(
        'id', v_printer.id,
        'name', v_printer.name,
        'connection_type', v_printer.connection_type,
        'address', v_printer.address
      )
  );
END;
$$;


-- Replace the earlier text-returning completion RPC atomically.
DROP FUNCTION IF EXISTS public.neo_print_agent_finish(text, uuid, uuid, text, text);

CREATE OR REPLACE FUNCTION public.neo_print_agent_finish(
  _token_hash text,
  _job uuid,
  _claim uuid,
  _outcome text,
  _error text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agent public.neo_print_agents;
  v_job public.print_jobs;
  v_printer public.printer_profiles;
  v_fallback public.printer_profiles;
  v_status text;
  v_failed_over boolean := false;
  v_backoff integer;
BEGIN
  SELECT *
  INTO v_agent
  FROM public.neo_print_agents
  WHERE token_hash = lower(coalesce(_token_hash, ''))
    AND active;

  IF v_agent.id IS NULL THEN
    RAISE EXCEPTION 'invalid_print_agent_token'
      USING ERRCODE = '42501';
  END IF;

  IF _outcome NOT IN (
    'completed',
    'not_printed',
    'outcome_unknown'
  ) THEN
    RAISE EXCEPTION 'invalid_print_outcome'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
  INTO v_job
  FROM public.print_jobs
  WHERE id = _job
  FOR UPDATE;

  IF v_job.id IS NULL THEN
    RAISE EXCEPTION 'print_job_not_found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_job.organization_id <> v_agent.organization_id
     OR v_job.claimed_by_agent_id <> v_agent.id
     OR v_job.claim_id <> _claim
     OR v_job.status <> 'printing' THEN
    RAISE EXCEPTION 'invalid_or_stale_print_claim'
      USING ERRCODE = '40001';
  END IF;

  SELECT *
  INTO v_printer
  FROM public.printer_profiles
  WHERE id = v_job.printer_id;

  IF _outcome = 'completed' THEN
    UPDATE public.print_jobs
    SET
      status = 'completed',
      attempts = attempts + 1,
      completed_at = now(),
      last_error = NULL,
      claim_id = NULL,
      claimed_by_agent_id = NULL,
      claimed_at = NULL,
      claim_expires_at = NULL,
      updated_at = now()
    WHERE id = v_job.id;

    UPDATE public.printer_profiles
    SET
      status = 'connected',
      health_status = 'online',
      last_success_at = now(),
      last_checked_at = now(),
      last_error = NULL,
      updated_at = now()
    WHERE id = v_job.printer_id;

    RETURN jsonb_build_object(
      'status', 'completed',
      'failed_over', false
    );
  END IF;

  UPDATE public.printer_profiles
  SET
    health_status = 'error',
    last_failure_at = now(),
    last_checked_at = now(),
    last_error = left(
      coalesce(
        nullif(btrim(_error), ''),
        replace(_outcome, '_', ' ')
      ),
      1000
    ),
    updated_at = now()
  WHERE id = v_job.printer_id;

  IF _outcome = 'outcome_unknown' THEN
    UPDATE public.print_jobs
    SET
      status = 'failed',
      attempts = attempts + 1,
      last_error =
        'Physical outcome unknown. Review before manually retrying. '
        || left(coalesce(_error, ''), 800),
      claim_id = NULL,
      claimed_by_agent_id = NULL,
      claimed_at = NULL,
      claim_expires_at = NULL,
      updated_at = now()
    WHERE id = v_job.id;

    RETURN jsonb_build_object(
      'status', 'failed',
      'failed_over', false,
      'outcome_unknown', true
    );
  END IF;

  v_backoff :=
    greatest(
      1,
      coalesce(v_printer.retry_backoff_seconds, 30)
    );

  IF v_job.attempts + 1 < v_job.max_attempts THEN
    v_status := 'queued';

    UPDATE public.print_jobs
    SET
      status = 'queued',
      attempts = attempts + 1,
      last_error = left(
        coalesce(_error, 'Printer reported not printed'),
        1000
      ),
      next_attempt_at =
        now() + make_interval(secs => v_backoff),
      claim_id = NULL,
      claimed_by_agent_id = NULL,
      claimed_at = NULL,
      claim_expires_at = NULL,
      updated_at = now()
    WHERE id = v_job.id;

  ELSE
    SELECT fp.*
    INTO v_fallback
    FROM public.printer_profiles fp
    WHERE fp.id = v_printer.fallback_printer_id
      AND fp.active
      AND fp.organization_id =
          v_printer.organization_id
      AND fp.branch_id
          IS NOT DISTINCT FROM v_printer.branch_id
      AND fp.department_id
          IS NOT DISTINCT FROM v_printer.department_id
      AND fp.station_id
          IS NOT DISTINCT FROM v_printer.station_id
      AND fp.printer_role
          IS NOT DISTINCT FROM v_printer.printer_role;

    IF v_fallback.id IS NOT NULL
       AND NOT v_job.failed_over THEN
      v_status := 'queued';
      v_failed_over := true;

      UPDATE public.print_jobs
      SET
        status = 'queued',
        printer_id = v_fallback.id,
        attempts = 0,
        failed_over = true,
        last_error = left(
          coalesce(
            _error,
            'Primary printer reported not printed'
          ),
          1000
        ),
        next_attempt_at = now(),
        claim_id = NULL,
        claimed_by_agent_id = NULL,
        claimed_at = NULL,
        claim_expires_at = NULL,
        updated_at = now()
      WHERE id = v_job.id;
    ELSE
      v_status := 'failed';

      UPDATE public.print_jobs
      SET
        status = 'failed',
        attempts = attempts + 1,
        last_error = left(
          coalesce(
            _error,
            'Printer reported not printed'
          ),
          1000
        ),
        claim_id = NULL,
        claimed_by_agent_id = NULL,
        claimed_at = NULL,
        claim_expires_at = NULL,
        updated_at = now()
      WHERE id = v_job.id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'status', v_status,
    'failed_over', v_failed_over
  );
END;
$$;


REVOKE ALL
  ON FUNCTION public.neo_print_agent_register(uuid, text, text)
  FROM PUBLIC, anon;

REVOKE ALL
  ON FUNCTION public.neo_print_agent_revoke(uuid)
  FROM PUBLIC, anon;

GRANT EXECUTE
  ON FUNCTION public.neo_print_agent_register(uuid, text, text)
  TO authenticated;

GRANT EXECUTE
  ON FUNCTION public.neo_print_agent_revoke(uuid)
  TO authenticated;


REVOKE ALL
  ON FUNCTION public.neo_print_agent_printers(text)
  FROM PUBLIC, anon, authenticated;

REVOKE ALL
  ON FUNCTION public.neo_print_agent_claim(text, uuid)
  FROM PUBLIC, anon, authenticated;

REVOKE ALL
  ON FUNCTION public.neo_print_agent_finish(
    text,
    uuid,
    uuid,
    text,
    text
  )
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE
  ON FUNCTION public.neo_print_agent_printers(text)
  TO service_role;

GRANT EXECUTE
  ON FUNCTION public.neo_print_agent_claim(text, uuid)
  TO service_role;

GRANT EXECUTE
  ON FUNCTION public.neo_print_agent_finish(
    text,
    uuid,
    uuid,
    text,
    text
  )
  TO service_role;


REVOKE ALL
  ON FUNCTION public.neo_print_queue_station_tickets(uuid, uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE
  ON FUNCTION public.neo_print_queue_station_tickets(uuid, uuid)
  TO service_role;


COMMENT ON TABLE public.neo_print_agents IS
  'Trusted property computers that poll and physically execute scoped print jobs. Raw bearer tokens are never stored.';

COMMENT ON FUNCTION public.neo_print_agent_claim(text, uuid) IS
  'Atomically claims one due print job for a trusted property agent using SKIP LOCKED.';

COMMENT ON FUNCTION public.neo_print_agent_finish(
  text,
  uuid,
  uuid,
  text,
  text
) IS
  'Records an observed physical result and applies scoped retry or failover rules.';

COMMIT;