CREATE OR REPLACE FUNCTION public.neo_is_guest_of_org(_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.customers c
     WHERE c.organization_id = _org
       AND c.auth_user_id = auth.uid()
  );
$$;

GRANT EXECUTE ON FUNCTION public.neo_is_guest_of_org(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_canonical_transaction_set(_org uuid, _branch uuid, _module text, _source uuid, _reference text, _operational text, _financial text, _amount numeric, _currency text, _idempotency text, _actor uuid, _owner text, _next_action text, _blocker text, _journal uuid, _receipt uuid, _downstream jsonb DEFAULT '{}'::jsonb, _metadata jsonb DEFAULT '{}'::jsonb, _occurred timestamp with time zone DEFAULT now())
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_module text:=public.neo_canonical_posting_module(_module); v_id uuid; v_version int; v_changed boolean;
BEGIN
 IF auth.uid() IS NOT NULL AND _org IS NOT NULL AND public.current_org_id() IS NOT NULL
    AND _org IS DISTINCT FROM public.current_org_id()
    AND NOT public.neo_is_guest_of_org(_org) THEN
   RAISE EXCEPTION 'Cross-workspace canonical state write rejected' USING ERRCODE = '42501';
 END IF;

  INSERT INTO public.canonical_transaction_states AS s
    (organization_id, branch_id, module, source_record_id, reference, operational_state, financial_state,
     amount, currency, idempotency_key, actor_id, owner_role, next_action, blocker, journal_id, receipt_id,
     downstream, metadata, occurred_at)
  VALUES (_org,_branch,v_module,_source,_reference,_operational,_financial,_amount,COALESCE(_currency,'KES'),
          _idempotency,_actor,_owner,_next_action,_blocker,_journal,_receipt,COALESCE(_downstream,'{}'::jsonb),
          COALESCE(_metadata,'{}'::jsonb),COALESCE(_occurred,now()))
  ON CONFLICT (organization_id, module, source_record_id) DO UPDATE
     SET branch_id=EXCLUDED.branch_id, reference=EXCLUDED.reference,
         operational_state=EXCLUDED.operational_state, financial_state=EXCLUDED.financial_state,
         amount=EXCLUDED.amount, currency=EXCLUDED.currency, idempotency_key=COALESCE(EXCLUDED.idempotency_key,s.idempotency_key),
         actor_id=COALESCE(EXCLUDED.actor_id,s.actor_id), owner_role=EXCLUDED.owner_role,
         next_action=EXCLUDED.next_action, blocker=EXCLUDED.blocker,
         journal_id=COALESCE(EXCLUDED.journal_id,s.journal_id), receipt_id=COALESCE(EXCLUDED.receipt_id,s.receipt_id),
         downstream=s.downstream || EXCLUDED.downstream, metadata=s.metadata || EXCLUDED.metadata,
         occurred_at=COALESCE(EXCLUDED.occurred_at,s.occurred_at), updated_at=now(),
         version=s.version+1
  RETURNING id, version,
            (s.operational_state IS DISTINCT FROM EXCLUDED.operational_state
             OR s.financial_state IS DISTINCT FROM EXCLUDED.financial_state)
    INTO v_id, v_version, v_changed;

  INSERT INTO public.canonical_transaction_state_history
    (organization_id, state_id, module, source_record_id, reference, operational_state, financial_state,
     amount, currency, actor_id, journal_id, receipt_id, metadata, version, occurred_at)
  VALUES (_org, v_id, v_module, _source, _reference, _operational, _financial, _amount, COALESCE(_currency,'KES'),
          _actor, _journal, _receipt, COALESCE(_metadata,'{}'::jsonb), COALESCE(v_version,1), COALESCE(_occurred,now()));

  RETURN v_id;
END;
$function$;