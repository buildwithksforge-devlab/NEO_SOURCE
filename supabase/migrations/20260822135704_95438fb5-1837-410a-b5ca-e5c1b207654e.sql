CREATE OR REPLACE FUNCTION public.neo_outbox_replay(_event uuid, _reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE org uuid := public.current_org_id(); e public.domain_events; res jsonb;
BEGIN
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT (public.is_org_admin() OR public.has_permission('finance','edit')
          OR public.has_permission('finance','approve')) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('outbox-replay:' || _event::text, 0));

  SELECT * INTO e FROM public.domain_events
   WHERE id = _event AND organization_id = org FOR UPDATE;
  IF e.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;

  IF e.status IN ('processed','completed') THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_processed',
      'detail', 'This handoff already succeeded - nothing was replayed.');
  END IF;

  UPDATE public.domain_events
     SET status = 'pending', next_attempt_at = now(), dead_lettered_at = NULL,
         locked_by = NULL, locked_until = NULL,
         max_attempts = greatest(coalesce(max_attempts,5), coalesce(attempts,0) + 1),
         updated_at = now()
   WHERE id = e.id;

  IF e.source_module IS NOT NULL AND e.source_record_id IS NOT NULL
     AND (e.event_type LIKE 'finance.%' OR e.source_module IN
          ('pos_order','folio_charge','folio_payment','event_earned','event_deposit',
           'event_invoice','event_cancellation','delivery_order','laundry_order',
           'supplier_invoice','supplier_payment')) THEN
    BEGIN
      res := public.neo_finance_post_txn(e.source_module, e.source_record_id, true);
    EXCEPTION WHEN OTHERS THEN
      res := jsonb_build_object('ok', false, 'reason', 'retry_failed', 'detail', SQLERRM);
    END;
  END IF;

  INSERT INTO public.audit_logs (organization_id, branch_id, action, module, user_id,
                                 record_id, reason, new_value)
  VALUES (org, e.branch_id, 'outbox.replay', 'finance', auth.uid(), e.id::text,
          coalesce(_reason, 'Manual replay of a failed handoff'),
          jsonb_build_object('event_type', e.event_type, 'attempts', e.attempts, 'result', res));

  RETURN jsonb_build_object('ok', true, 'reason', 'requeued', 'event_id', e.id,
                            'posting', res);
END $$;
REVOKE ALL ON FUNCTION public.neo_outbox_replay(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_outbox_replay(uuid,text) TO authenticated, service_role;