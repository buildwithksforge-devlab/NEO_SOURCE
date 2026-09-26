
-- Trigger functions must not be callable through the API
REVOKE ALL ON FUNCTION public.tg_group_block_audit() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_waitlist_audit() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_guest_request_lifecycle() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_folio_line_immutable() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_payment_controls() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pms_room_type_availability(uuid,date,date,uuid) FROM anon;
REVOKE ALL ON FUNCTION public.pms_available_rooms(uuid,date,date,uuid,integer,integer,uuid) FROM anon;
REVOKE ALL ON FUNCTION public.pms_release_expired_blocks(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.pms_expire_waitlist(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.pms_escalate_overdue_requests(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.folio_post_charge(uuid,text,text,numeric,numeric,numeric,numeric,numeric,text,uuid,text,text,uuid) FROM anon;
REVOKE ALL ON FUNCTION public.folio_transfer_line(uuid,uuid,text) FROM anon;
REVOKE ALL ON FUNCTION public.folio_reverse_line(uuid,text) FROM anon;
REVOKE ALL ON FUNCTION public.folio_reopen(uuid,text) FROM anon;
REVOKE ALL ON FUNCTION public.corp_credit_check(uuid,uuid,uuid,numeric) FROM anon;
REVOKE ALL ON FUNCTION public.corp_assert_credit(uuid,uuid,uuid,numeric) FROM anon;
REVOKE ALL ON FUNCTION public.corp_account_aging(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.cash_open_shift(uuid,uuid,numeric) FROM anon;
REVOKE ALL ON FUNCTION public.cash_record_movement(uuid,text,numeric,text,text) FROM anon;
REVOKE ALL ON FUNCTION public.cash_shift_expected(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.cash_close_shift(uuid,numeric,text) FROM anon;
REVOKE ALL ON FUNCTION public.cash_review_shift(uuid,text,text) FROM anon;

-- ============ IDEMPOTENCY / UNIQUENESS =============
ALTER TABLE public.loyalty_transactions ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS idempotency_key text;

DELETE FROM public.loyalty_transactions a USING public.loyalty_transactions b
 WHERE a.ctid > b.ctid AND a.organization_id=b.organization_id
   AND a.idempotency_key IS NOT NULL AND a.idempotency_key=b.idempotency_key;
DELETE FROM public.housekeeping_jobs a USING public.housekeeping_jobs b
 WHERE a.ctid > b.ctid AND a.organization_id=b.organization_id
   AND a.idempotency_key IS NOT NULL AND a.idempotency_key=b.idempotency_key;
DELETE FROM public.stock_movements a USING public.stock_movements b
 WHERE a.ctid > b.ctid AND a.organization_id=b.organization_id
   AND a.idempotency_key IS NOT NULL AND a.idempotency_key=b.idempotency_key;
DELETE FROM public.journal_entries a USING public.journal_entries b
 WHERE a.ctid > b.ctid AND a.organization_id=b.organization_id
   AND a.idempotency_key IS NOT NULL AND a.idempotency_key=b.idempotency_key;
DELETE FROM public.notifications a USING public.notifications b
 WHERE a.ctid > b.ctid AND a.organization_id=b.organization_id
   AND a.idempotency_key IS NOT NULL AND a.idempotency_key=b.idempotency_key
   AND COALESCE(a.user_id::text,'') = COALESCE(b.user_id::text,'');

CREATE UNIQUE INDEX IF NOT EXISTS loyalty_transactions_idempotency_unique
  ON public.loyalty_transactions (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS housekeeping_jobs_idempotency_unique
  ON public.housekeeping_jobs (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS stock_movements_idempotency_unique
  ON public.stock_movements (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_idempotency_unique
  ON public.journal_entries (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS notifications_idempotency_unique
  ON public.notifications (organization_id, COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid), idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS reservations_confirmation_unique
  ON public.reservations (organization_id, confirmation_number) WHERE confirmation_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS reservations_idempotency_unique
  ON public.reservations (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ============ SELF-APPROVAL POLICY =============
ALTER TABLE public.approval_requests
  ADD COLUMN IF NOT EXISTS self_approved boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS emergency_override boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS override_reason text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS decided_at timestamptz;

CREATE OR REPLACE FUNCTION public.enforce_no_self_approval()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _rule_allows boolean; _can_override boolean;
BEGIN
  IF NEW.status IN ('approved','rejected') AND OLD.status = 'pending' THEN
    NEW.decided_at := now();
    IF NEW.requester_id = auth.uid() THEN
      NEW.self_approved := true;
      SELECT COALESCE(bool_or(allow_self_approval), false) INTO _rule_allows
      FROM public.approval_rules
      WHERE organization_id = NEW.organization_id AND approval_type = NEW.approval_type AND active;

      IF NOT _rule_allows THEN
        _can_override := public.has_permission('administration','approvals.emergency_override')
                         OR public.can_approve_restricted();
        IF NOT (NEW.emergency_override AND _can_override
                AND length(COALESCE(trim(NEW.override_reason),'')) >= 20) THEN
          RAISE EXCEPTION 'Self-approval is blocked. An emergency policy override with a written justification (20+ characters) and override authority is required.';
        END IF;
      END IF;

      INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id,
        previous_value, new_value, reason)
      VALUES (NEW.organization_id, auth.uid(), '', 'approval.self_approved', 'governance', NEW.id::text,
        to_jsonb(OLD), jsonb_build_object(
          'status', NEW.status, 'approval_type', NEW.approval_type, 'amount', NEW.amount,
          'requester_id', NEW.requester_id, 'decision_maker', auth.uid(),
          'emergency_override', NEW.emergency_override, 'rule_allows_self_approval', COALESCE(_rule_allows,false),
          'branch_id', NEW.branch_id, 'reference', NEW.reference, 'decided_at', now()),
        COALESCE(NULLIF(NEW.override_reason,''), NEW.reason, ''));
    END IF;
  END IF;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.enforce_no_self_approval() FROM PUBLIC, anon, authenticated;

-- ============ DURABLE OUTBOX =============
ALTER TABLE public.domain_events
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS locked_by text,
  ADD COLUMN IF NOT EXISTS locked_until timestamptz,
  ADD COLUMN IF NOT EXISTS dead_lettered_at timestamptz;

CREATE INDEX IF NOT EXISTS domain_events_outbox_idx
  ON public.domain_events (status, next_attempt_at) WHERE status IN ('pending','retrying');
CREATE UNIQUE INDEX IF NOT EXISTS domain_events_idempotency_unique
  ON public.domain_events (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL AND idempotency_key <> '';

CREATE OR REPLACE FUNCTION public.outbox_claim(_worker text, _limit integer DEFAULT 25, _lease_seconds integer DEFAULT 60)
RETURNS SETOF public.domain_events
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    SELECT id FROM public.domain_events
    WHERE status IN ('pending','retrying')
      AND next_attempt_at <= now()
      AND (locked_until IS NULL OR locked_until < now())
    ORDER BY occurred_at
    LIMIT GREATEST(COALESCE(_limit,25), 1)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.domain_events d
     SET locked_by = _worker,
         locked_until = now() + make_interval(secs => GREATEST(COALESCE(_lease_seconds,60), 5)),
         status = 'processing',
         attempts = d.attempts + 1,
         updated_at = now()
    FROM claimed c WHERE d.id = c.id
  RETURNING d.*;
END; $$;

CREATE OR REPLACE FUNCTION public.outbox_ack(_event uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$
  UPDATE public.domain_events
     SET status='processed', processed_at=now(), locked_by=NULL, locked_until=NULL,
         last_error=NULL, updated_at=now()
   WHERE id=_event;
$$;

CREATE OR REPLACE FUNCTION public.outbox_fail(_event uuid, _error text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _e public.domain_events;
BEGIN
  SELECT * INTO _e FROM public.domain_events WHERE id=_event FOR UPDATE;
  IF _e.id IS NULL THEN RETURN; END IF;
  IF _e.attempts >= _e.max_attempts THEN
    UPDATE public.domain_events SET status='dead-letter', dead_lettered_at=now(), last_error=_error,
      locked_by=NULL, locked_until=NULL, updated_at=now() WHERE id=_event;
  ELSE
    UPDATE public.domain_events SET status='retrying', last_error=_error,
      retry_count = retry_count + 1,
      next_attempt_at = now() + make_interval(secs => LEAST(power(2, _e.attempts)::int * 15, 3600)),
      locked_by=NULL, locked_until=NULL, updated_at=now() WHERE id=_event;
  END IF;
END; $$;

CREATE OR REPLACE FUNCTION public.outbox_reap_expired_leases()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _n int;
BEGIN
  UPDATE public.domain_events SET status='retrying', locked_by=NULL, locked_until=NULL, updated_at=now()
   WHERE status='processing' AND locked_until IS NOT NULL AND locked_until < now();
  GET DIAGNOSTICS _n = ROW_COUNT; RETURN _n;
END; $$;

-- Default in-database dispatcher: turns workflow events into durable notifications
CREATE OR REPLACE FUNCTION public.outbox_process(_limit integer DEFAULT 50, _worker text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _w text := COALESCE(_worker, 'pg:' || md5(clock_timestamp()::text));
        _rec public.domain_events; _ok int := 0; _failed int := 0;
BEGIN
  PERFORM public.outbox_reap_expired_leases();
  FOR _rec IN SELECT * FROM public.outbox_claim(_w, _limit, 60) LOOP
    BEGIN
      PERFORM public.neo_notify_event(_rec.organization_id, NULL, _rec.branch_id, _rec.event_type,
        _rec.source_record_id, _rec.payload, 'outbox:' || _rec.id::text);
      PERFORM public.outbox_ack(_rec.id);
      _ok := _ok + 1;
    EXCEPTION WHEN OTHERS THEN
      PERFORM public.outbox_fail(_rec.id, SQLERRM);
      _failed := _failed + 1;
    END;
  END LOOP;
  RETURN jsonb_build_object('worker', _w, 'processed', _ok, 'failed', _failed, 'ran_at', now());
END; $$;

REVOKE ALL ON FUNCTION public.outbox_claim(text,integer,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.outbox_ack(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.outbox_fail(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.outbox_reap_expired_leases() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.outbox_process(integer,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.outbox_claim(text,integer,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.outbox_ack(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.outbox_fail(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.outbox_reap_expired_leases() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.outbox_process(integer,text) TO authenticated, service_role;

-- ============ SCHEDULES =============
CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.unschedule(jobname) FROM cron.job
 WHERE jobname IN ('neo-outbox-process','neo-release-blocks','neo-expire-waitlist','neo-escalate-requests');
SELECT cron.schedule('neo-outbox-process', '* * * * *', $$SELECT public.outbox_process(100, 'cron');$$);
SELECT cron.schedule('neo-release-blocks', '15 2 * * *', $$SELECT public.pms_release_expired_blocks(NULL);$$);
SELECT cron.schedule('neo-expire-waitlist', '30 2 * * *', $$SELECT public.pms_expire_waitlist(NULL);$$);
SELECT cron.schedule('neo-escalate-requests', '*/10 * * * *', $$SELECT public.pms_escalate_overdue_requests(NULL);$$);
