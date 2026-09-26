CREATE OR REPLACE FUNCTION public.neo_canonical_transaction_set(_org uuid, _branch uuid, _module text, _source uuid, _reference text, _operational text, _financial text, _amount numeric, _currency text, _idempotency text, _actor uuid, _owner text, _next_action text, _blocker text, _journal uuid, _receipt uuid, _downstream jsonb DEFAULT '{}'::jsonb, _metadata jsonb DEFAULT '{}'::jsonb, _occurred timestamp with time zone DEFAULT now())
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_module text:=public.neo_canonical_posting_module(_module); v_id uuid; v_version int; v_changed boolean;
BEGIN
 IF auth.uid() IS NOT NULL AND _org IS NOT NULL AND public.current_org_id() IS NOT NULL
    AND _org IS DISTINCT FROM public.current_org_id() THEN
   RAISE EXCEPTION 'Cross-workspace canonical state write rejected' USING ERRCODE = '42501';
 END IF;
 IF _org IS NULL OR _source IS NULL OR v_module='' THEN RAISE EXCEPTION 'Canonical transaction identity is required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(_org::text||':'||v_module||':'||_source::text,0));
 SELECT id,version,(operational_state,financial_state,amount,currency,blocking_reason,next_action,journal_id,receipt_id,downstream_references,metadata)
   IS DISTINCT FROM (coalesce(_operational,'pending'),coalesce(_financial,'pending'),coalesce(_amount,0),coalesce(_currency,'KES'),_blocker,_next_action,_journal,_receipt,coalesce(_downstream,'{}'::jsonb),coalesce(_metadata,'{}'::jsonb))
 INTO v_id,v_version,v_changed FROM public.canonical_transaction_states
 WHERE organization_id=_org AND source_module=v_module AND source_id=_source FOR UPDATE;
 IF v_id IS NULL THEN
   INSERT INTO public.canonical_transaction_states(organization_id,branch_id,source_module,source_id,source_reference,operational_state,financial_state,amount,currency,idempotency_key,actor_id,current_owner,next_action,blocking_reason,journal_id,receipt_id,downstream_references,metadata,occurred_at)
   VALUES(_org,_branch,v_module,_source,_reference,coalesce(_operational,'pending'),coalesce(_financial,'pending'),coalesce(_amount,0),coalesce(_currency,'KES'),coalesce(nullif(_idempotency,''),v_module||':'||_source::text),_actor,_owner,_next_action,_blocker,_journal,_receipt,coalesce(_downstream,'{}'::jsonb),coalesce(_metadata,'{}'::jsonb),coalesce(_occurred,now()))
   RETURNING id,version INTO v_id,v_version;
   v_changed:=true;
 ELSIF v_changed THEN
   UPDATE public.canonical_transaction_states SET branch_id=coalesce(_branch,branch_id),source_reference=coalesce(_reference,source_reference),operational_state=coalesce(_operational,operational_state),financial_state=coalesce(_financial,financial_state),amount=coalesce(_amount,amount),currency=coalesce(_currency,currency),actor_id=coalesce(_actor,actor_id),current_owner=_owner,next_action=_next_action,blocking_reason=_blocker,journal_id=coalesce(_journal,journal_id),receipt_id=coalesce(_receipt,receipt_id),downstream_references=coalesce(_downstream,downstream_references),metadata=coalesce(_metadata,metadata),version=version+1,occurred_at=coalesce(_occurred,occurred_at),updated_at=now() WHERE id=v_id RETURNING version INTO v_version;
 END IF;
 IF v_changed THEN
   INSERT INTO public.canonical_transaction_state_history(state_id,organization_id,branch_id,source_module,source_id,version,operational_state,financial_state,actor_id,blocking_reason,next_action,journal_id,receipt_id,snapshot)
   SELECT id,organization_id,branch_id,source_module,source_id,version,operational_state,financial_state,actor_id,blocking_reason,next_action,journal_id,receipt_id,to_jsonb(s) FROM public.canonical_transaction_states s WHERE id=v_id
   ON CONFLICT(state_id,version) DO NOTHING;
 END IF;
 RETURN v_id;
END; $function$;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('neo_financial_state_set','neo_evaluate_low_stock','neo_finance_reverse_posting',
                        'neo_grn_post_accrual','neo_event_post_payment','neo_gl_period')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated, anon, PUBLIC', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
  END LOOP;
END $$;