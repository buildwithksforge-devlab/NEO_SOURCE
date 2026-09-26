CREATE TABLE public.canonical_transaction_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid,
  source_module text NOT NULL,
  source_id uuid NOT NULL,
  source_reference text,
  operational_state text NOT NULL DEFAULT 'pending',
  financial_state text NOT NULL DEFAULT 'pending' CHECK (financial_state IN ('not-applicable','pending','eligible','blocked','failed','posted','reversed')),
  amount numeric NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'KES',
  idempotency_key text NOT NULL,
  actor_id uuid,
  current_owner text,
  next_action text,
  blocking_reason text,
  journal_id uuid,
  receipt_id uuid,
  downstream_references jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, source_module, source_id),
  UNIQUE (organization_id, idempotency_key)
);
GRANT SELECT ON public.canonical_transaction_states TO authenticated;
GRANT ALL ON public.canonical_transaction_states TO service_role;
ALTER TABLE public.canonical_transaction_states ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members read canonical states in their organisation" ON public.canonical_transaction_states FOR SELECT TO authenticated USING (organization_id = public.current_org_id());

CREATE TABLE public.canonical_transaction_state_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_id uuid NOT NULL REFERENCES public.canonical_transaction_states(id),
  organization_id uuid NOT NULL,
  branch_id uuid,
  source_module text NOT NULL,
  source_id uuid NOT NULL,
  version integer NOT NULL,
  operational_state text NOT NULL,
  financial_state text NOT NULL,
  actor_id uuid,
  blocking_reason text,
  next_action text,
  journal_id uuid,
  receipt_id uuid,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (state_id, version)
);
GRANT SELECT ON public.canonical_transaction_state_history TO authenticated;
GRANT ALL ON public.canonical_transaction_state_history TO service_role;
ALTER TABLE public.canonical_transaction_state_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members read canonical state history in their organisation" ON public.canonical_transaction_state_history FOR SELECT TO authenticated USING (organization_id = public.current_org_id());

CREATE TABLE public.finance_posting_receipt_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid NOT NULL REFERENCES public.finance_posting_receipts(id),
  organization_id uuid NOT NULL,
  branch_id uuid,
  source_module text NOT NULL,
  source_id uuid NOT NULL,
  attempt_number integer NOT NULL,
  status text NOT NULL,
  amount numeric NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'KES',
  journal_id uuid,
  detail text,
  error text,
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (receipt_id, attempt_number)
);
GRANT SELECT ON public.finance_posting_receipt_history TO authenticated;
GRANT ALL ON public.finance_posting_receipt_history TO service_role;
ALTER TABLE public.finance_posting_receipt_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Finance members read posting receipt history" ON public.finance_posting_receipt_history FOR SELECT TO authenticated USING (organization_id = public.current_org_id() AND (public.is_org_admin_for(organization_id) OR public.has_permission('finance','view') OR public.can_read_general_ledger()));

ALTER TABLE public.night_audit_runs
  ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'completed',
  ADD COLUMN IF NOT EXISTS source_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS exception_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS rerun_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS result_digest text,
  ADD COLUMN IF NOT EXISTS signed_at timestamptz;

CREATE TABLE public.night_audit_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.night_audit_runs(id),
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  business_date date NOT NULL,
  attempt_number integer NOT NULL,
  stage text NOT NULL,
  status text NOT NULL,
  source_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  exception_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  result_digest text,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  actor_id uuid,
  UNIQUE (run_id, attempt_number)
);
GRANT SELECT ON public.night_audit_attempts TO authenticated;
GRANT ALL ON public.night_audit_attempts TO service_role;
ALTER TABLE public.night_audit_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Finance members read night audit attempts" ON public.night_audit_attempts FOR SELECT TO authenticated USING (organization_id = public.current_org_id() AND (public.is_org_admin_for(organization_id) OR public.has_permission('finance','eod','view')));

CREATE INDEX canonical_transaction_states_scope_idx ON public.canonical_transaction_states (organization_id, branch_id, source_module, occurred_at DESC);
CREATE INDEX canonical_transaction_states_financial_idx ON public.canonical_transaction_states (organization_id, branch_id, financial_state, occurred_at DESC);
CREATE INDEX canonical_transaction_history_source_idx ON public.canonical_transaction_state_history (organization_id, source_module, source_id, version DESC);
CREATE INDEX finance_posting_receipt_history_scope_idx ON public.finance_posting_receipt_history (organization_id, branch_id, created_at DESC);
CREATE INDEX night_audit_attempts_scope_idx ON public.night_audit_attempts (organization_id, branch_id, business_date DESC);

CREATE OR REPLACE FUNCTION public.neo_canonical_posting_module(_module text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT CASE replace(lower(coalesce(_module,'')),'-','_')
   WHEN 'pos_order' THEN 'pos'
   WHEN 'laundry_order' THEN 'laundry'
   WHEN 'delivery_order' THEN 'delivery'
   WHEN 'event_booking' THEN 'events'
   WHEN 'inventory_receipt' THEN 'inventory'
   WHEN 'goods_receipt' THEN 'inventory'
   WHEN 'supplier_invoice' THEN 'supplier_invoice'
   WHEN 'supplier_payment' THEN 'supplier_payment'
   ELSE replace(lower(coalesce(_module,'')),'-','_') END
$$;

CREATE OR REPLACE FUNCTION public.neo_canonical_transaction_set(
 _org uuid,_branch uuid,_module text,_source uuid,_reference text,_operational text,_financial text,
 _amount numeric,_currency text,_idempotency text,_actor uuid,_owner text,_next_action text,_blocker text,
 _journal uuid,_receipt uuid,_downstream jsonb DEFAULT '{}'::jsonb,_metadata jsonb DEFAULT '{}'::jsonb,
 _occurred timestamptz DEFAULT now()) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_module text:=public.neo_canonical_posting_module(_module); v_id uuid; v_version int; v_changed boolean;
BEGIN
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
END $$;
REVOKE ALL ON FUNCTION public.neo_canonical_transaction_set(uuid,uuid,text,uuid,text,text,text,numeric,text,text,uuid,text,text,text,uuid,uuid,jsonb,jsonb,timestamptz) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.neo_canonical_transaction_set(uuid,uuid,text,uuid,text,text,text,numeric,text,text,uuid,text,text,text,uuid,uuid,jsonb,jsonb,timestamptz) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.neo_canonical_source_sync() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE j jsonb:=to_jsonb(NEW); m text; ref text; op text; fin text; amt numeric:=0; cur text:='KES'; idem text; jid uuid; blocker text; nxt text; owner text; fs record;
BEGIN
 m:=CASE TG_TABLE_NAME WHEN 'goods_receipts' THEN 'inventory' WHEN 'event_bookings' THEN 'events' WHEN 'internal_requisitions' THEN 'requisition' WHEN 'maintenance_work_orders' THEN 'maintenance' WHEN 'pos_orders' THEN 'pos' WHEN 'supplier_invoices' THEN 'supplier_invoice' WHEN 'supplier_payments' THEN 'supplier_payment' ELSE regexp_replace(TG_TABLE_NAME,'s$','') END;
 ref:=coalesce(j->>'grn_number',j->>'event_reference',j->>'request_number',j->>'work_order_number',j->>'receipt_number',j->>'order_number',j->>'confirmation_number',j->>'room_number',j->>'invoice_number',j->>'payment_number',j->>'id');
 op:=coalesce(j->>'status',j->>'order_status',j->>'room_status','pending');
 amt:=coalesce(nullif(j->>'amount','')::numeric,nullif(j->>'grand_total','')::numeric,nullif(j->>'total_amount','')::numeric,nullif(j->>'total_value','')::numeric,0);
 cur:=coalesce(nullif(j->>'currency',''),'KES');
 idem:=coalesce(nullif(j->>'idempotency_key',''),public.neo_canonical_posting_module(m)||':'||(j->>'id'));
 jid:=coalesce(nullif(j->>'posted_journal_id','')::uuid,nullif(j->>'accrual_journal_id','')::uuid,nullif(j->>'journal_id','')::uuid);
 SELECT financial_status,reason,journal_id,receipt_id INTO fs FROM public.financial_states WHERE source_id=(j->>'id')::uuid AND public.neo_canonical_posting_module(source_module)=public.neo_canonical_posting_module(m) ORDER BY updated_at DESC LIMIT 1;
 fin:=fs.financial_status; blocker:=fs.reason; jid:=coalesce(jid,fs.journal_id);
 IF fin IS NULL THEN
  fin:=CASE
   WHEN m='inventory' AND nullif(j->>'accrual_error','') IS NOT NULL THEN 'failed'
   WHEN m='inventory' AND jid IS NOT NULL THEN 'posted'
   WHEN m='inventory' AND lower(op) IN('posted','received','accepted','completed','closed') THEN 'eligible'
   WHEN m='supplier_invoice' AND jid IS NOT NULL THEN 'posted'
   WHEN m='supplier_invoice' AND lower(coalesce(j->>'match_status','')) IN('held','exception','variance','hold') THEN 'blocked'
   WHEN m='supplier_invoice' AND lower(coalesce(j->>'match_status','')) IN('matched','accepted','approved') THEN 'eligible'
   WHEN m IN('payment','supplier_payment') AND jid IS NOT NULL THEN 'posted'
   WHEN m='payment' AND lower(op) NOT IN('void','voided','cancelled','failed','reversed') AND amt>0 THEN 'eligible'
   WHEN m='supplier_payment' AND lower(op) IN('paid','completed','settled') THEN 'eligible'
   WHEN m='pos' AND coalesce(j->>'folio_post_status','')='posted' THEN 'posted'
   WHEN m='pos' AND lower(op) IN('closed','paid','settled','completed') THEN 'eligible'
   ELSE 'pending' END;
 END IF;
 nxt:=CASE fin WHEN 'eligible' THEN 'Post to the general ledger' WHEN 'blocked' THEN 'Resolve the blocking rule, then retry' WHEN 'failed' THEN 'Correct the failure and retry safely' WHEN 'pending' THEN 'Complete the current operational stage' ELSE NULL END;
 owner:=CASE WHEN fin IN('eligible','blocked','failed') THEN 'Finance' WHEN m='inventory' THEN 'Stores' WHEN m='maintenance' THEN 'Maintenance' WHEN m='requisition' THEN 'Requesting department' ELSE 'Operations' END;
 PERFORM public.neo_canonical_transaction_set((j->>'organization_id')::uuid,nullif(j->>'branch_id','')::uuid,m,(j->>'id')::uuid,ref,op,fin,amt,cur,idem,coalesce(nullif(j->>'updated_by','')::uuid,nullif(j->>'created_by','')::uuid,nullif(j->>'received_by','')::uuid,auth.uid()),owner,nxt,blocker,jid,fs.receipt_id,jsonb_strip_nulls(jsonb_build_object('journal_id',jid,'receipt_id',fs.receipt_id)),jsonb_build_object('source_table',TG_TABLE_NAME),coalesce(nullif(j->>'updated_at','')::timestamptz,nullif(j->>'created_at','')::timestamptz,now()));
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.neo_canonical_source_sync() FROM PUBLIC,anon,authenticated;

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['goods_receipts','event_bookings','internal_requisitions','maintenance_work_orders','payments','pos_orders','reservations','rooms','supplier_invoices','supplier_payments'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS canonical_state_sync ON public.%I',t);
  EXECUTE format('CREATE TRIGGER canonical_state_sync AFTER INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.neo_canonical_source_sync()',t);
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.neo_financial_state_from_receipt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE s text; m text:=public.neo_canonical_posting_module(NEW.source_module); balanced boolean:=false;
BEGIN
 IF NEW.journal_id IS NOT NULL THEN SELECT abs(coalesce(total_debit,0)-coalesce(total_credit,0))<0.01 AND status='posted' INTO balanced FROM public.journal_entries WHERE id=NEW.journal_id AND organization_id=NEW.organization_id; END IF;
 s:=CASE WHEN lower(coalesce(NEW.status,'pending'))='posted' AND NOT coalesce(balanced,false) THEN 'blocked' WHEN lower(coalesce(NEW.status,'pending')) IN('posted','failed','blocked','reversed','eligible') THEN lower(NEW.status) ELSE 'pending' END;
 PERFORM public.neo_financial_state_set(NEW.organization_id,NEW.branch_id,m,NEW.source_id,NEW.source_reference,NULL,s,CASE WHEN s='blocked' AND NEW.status='posted' THEN 'Posting receipt has no balanced posted journal' WHEN s IN('failed','blocked') THEN coalesce(NEW.last_error,NEW.detail) ELSE NEW.detail END,NEW.amount,NEW.currency,NEW.occurred_on,NEW.journal_id,NEW.id,NEW.last_error,NEW.requested_by,jsonb_build_object('idempotency_key',NEW.idempotency_key));
 PERFORM public.neo_canonical_transaction_set(NEW.organization_id,NEW.branch_id,m,NEW.source_id,NEW.source_reference,coalesce((SELECT operational_status FROM public.financial_states WHERE source_module=m AND source_id=NEW.source_id),'pending'),s,NEW.amount,NEW.currency,NEW.idempotency_key,NEW.requested_by,'Finance',CASE s WHEN 'eligible' THEN 'Post to the general ledger' WHEN 'blocked' THEN 'Resolve the posting exception and retry' WHEN 'failed' THEN 'Correct the failure and retry safely' ELSE NULL END,CASE WHEN s='blocked' AND NEW.status='posted' THEN 'Posting receipt has no balanced posted journal' ELSE NEW.last_error END,NEW.journal_id,NEW.id,jsonb_strip_nulls(jsonb_build_object('journal_id',NEW.journal_id,'receipt_id',NEW.id)),'{}'::jsonb,coalesce(NEW.updated_at,NEW.created_at));
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.neo_posting_receipt_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 INSERT INTO public.finance_posting_receipt_history(receipt_id,organization_id,branch_id,source_module,source_id,attempt_number,status,amount,currency,journal_id,detail,error,actor_id)
 VALUES(NEW.id,NEW.organization_id,NEW.branch_id,public.neo_canonical_posting_module(NEW.source_module),NEW.source_id,greatest(coalesce(NEW.attempts,1),1),NEW.status,NEW.amount,NEW.currency,NEW.journal_id,NEW.detail,NEW.last_error,NEW.requested_by)
 ON CONFLICT(receipt_id,attempt_number) DO UPDATE SET status=excluded.status,journal_id=excluded.journal_id,detail=excluded.detail,error=excluded.error;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.neo_posting_receipt_history() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS posting_receipt_history ON public.finance_posting_receipts;
CREATE TRIGGER posting_receipt_history AFTER INSERT OR UPDATE ON public.finance_posting_receipts FOR EACH ROW EXECUTE FUNCTION public.neo_posting_receipt_history();

CREATE OR REPLACE FUNCTION public.neo_finance_posting_queue(_branch uuid DEFAULT NULL,_from date DEFAULT NULL,_to date DEFAULT NULL)
RETURNS TABLE(source_module text,source_id uuid,reference text,source_status text,amount numeric,currency text,occurred_on date,eligible boolean,posting_status text,rule text,required_action text,drill_to text,last_error text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE org uuid:=public.current_org_id(); BEGIN
 IF org IS NULL OR NOT(public.is_org_admin() OR public.has_permission('finance','view')) THEN RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT s.source_module,s.source_id,s.source_reference,s.operational_state,s.amount,s.currency,s.occurred_at::date,s.financial_state='eligible',s.financial_state,
  'Canonical state '||s.operational_state||' → '||s.financial_state,
  coalesce(s.next_action,CASE s.financial_state WHEN 'eligible' THEN 'Post to the general ledger.' WHEN 'blocked' THEN 'Resolve the source exception.' WHEN 'failed' THEN 'Correct the failure and retry safely.' ELSE 'Complete the current operational stage.' END),
  CASE s.source_module WHEN 'inventory' THEN '/inventory/receiving' WHEN 'supplier_invoice' THEN '/finance/payables' WHEN 'supplier_payment' THEN '/finance/payables' WHEN 'deposit' THEN '/finance/deposits' WHEN 'payment' THEN '/finance/queue' WHEN 'pos' THEN '/pos/orders' WHEN 'events' THEN '/events/bookings' WHEN 'delivery' THEN '/delivery' WHEN 'laundry' THEN '/laundry' ELSE '/finance/posting' END,
  coalesce(s.blocking_reason,(SELECT r.last_error FROM public.finance_posting_receipts r WHERE r.organization_id=s.organization_id AND public.neo_canonical_posting_module(r.source_module)=s.source_module AND r.source_id=s.source_id ORDER BY r.updated_at DESC LIMIT 1))
 FROM public.canonical_transaction_states s WHERE s.organization_id=org AND (_branch IS NULL OR s.branch_id=_branch) AND (_from IS NULL OR s.occurred_at::date>=_from) AND (_to IS NULL OR s.occurred_at::date<=_to) AND s.source_module IN('pos','folio','laundry','events','delivery','inventory','supplier_invoice','supplier_payment','deposit','payment') AND s.financial_state NOT IN('posted','reversed','not-applicable') ORDER BY (s.financial_state='eligible') DESC,s.occurred_at DESC LIMIT 500;
END $$;
REVOKE ALL ON FUNCTION public.neo_finance_posting_queue(uuid,date,date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.neo_finance_posting_queue(uuid,date,date) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_finance_exception_register(_branch uuid DEFAULT NULL,_from date DEFAULT NULL,_to date DEFAULT NULL)
RETURNS TABLE(kind text,module text,reference text,source_id uuid,amount numeric,currency text,occurred_on date,age_days integer,status text,reason text,detail text,responsible text,action text,drill_to text,last_attempt timestamptz,attempts integer,last_error text,branch_id uuid,property text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE org uuid:=public.current_org_id(); today date:=current_date; BEGIN
 IF org IS NULL OR NOT(public.is_org_admin() OR public.has_permission('finance','view') OR public.can_read_general_ledger()) THEN RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT s.financial_state,s.source_module,coalesce(s.source_reference,s.source_id::text),s.source_id,s.amount,s.currency,s.occurred_at::date,greatest(0,today-s.occurred_at::date),s.financial_state,coalesce(s.blocking_reason,s.next_action),coalesce(s.blocking_reason,s.next_action),'Finance',coalesce(s.next_action,'Resolve at source and retry.'),q.drill_to,s.updated_at,coalesce(r.attempts,0),r.last_error,s.branch_id,b.name
 FROM public.canonical_transaction_states s LEFT JOIN public.branches b ON b.id=s.branch_id LEFT JOIN LATERAL(SELECT x.attempts,x.last_error FROM public.finance_posting_receipts x WHERE x.organization_id=s.organization_id AND public.neo_canonical_posting_module(x.source_module)=s.source_module AND x.source_id=s.source_id ORDER BY x.updated_at DESC LIMIT 1)r ON true LEFT JOIN LATERAL(SELECT x.drill_to FROM public.neo_finance_posting_queue(s.branch_id,s.occurred_at::date,s.occurred_at::date)x WHERE x.source_id=s.source_id LIMIT 1)q ON true
 WHERE s.organization_id=org AND s.financial_state IN('blocked','failed') AND (_branch IS NULL OR s.branch_id=_branch) AND (_from IS NULL OR s.occurred_at::date>=_from) AND (_to IS NULL OR s.occurred_at::date<=_to)
 UNION ALL
 SELECT 'blocked',public.neo_canonical_posting_module(r.source_module),coalesce(r.source_reference,r.source_id::text),r.source_id,r.amount,r.currency,coalesce(r.occurred_on,r.created_at::date),greatest(0,today-coalesce(r.occurred_on,r.created_at::date)),'blocked','Posting receipt is not backed by a balanced posted journal','Posting receipt is not backed by a balanced posted journal','Finance','Repair the journal link or reverse and repost.','/finance/posting',r.updated_at,r.attempts,r.last_error,r.branch_id,b.name
 FROM public.finance_posting_receipts r LEFT JOIN public.branches b ON b.id=r.branch_id LEFT JOIN public.journal_entries j ON j.id=r.journal_id
 WHERE r.organization_id=org AND r.status='posted' AND (j.id IS NULL OR j.status<>'posted' OR abs(coalesce(j.total_debit,0)-coalesce(j.total_credit,0))>=0.01) AND (_branch IS NULL OR r.branch_id=_branch) AND (_from IS NULL OR coalesce(r.occurred_on,r.created_at::date)>=_from) AND (_to IS NULL OR coalesce(r.occurred_on,r.created_at::date)<=_to)
 ORDER BY 1,7 DESC;
END $$;
REVOKE ALL ON FUNCTION public.neo_finance_exception_register(uuid,date,date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.neo_finance_exception_register(uuid,date,date) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_canonical_state_register(_branch uuid DEFAULT NULL,_from date DEFAULT NULL,_to date DEFAULT NULL,_module text DEFAULT NULL,_financial text DEFAULT NULL)
RETURNS SETOF public.canonical_transaction_states LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$ SELECT s.* FROM public.canonical_transaction_states s WHERE s.organization_id=public.current_org_id() AND (_branch IS NULL OR s.branch_id=_branch) AND (_from IS NULL OR s.occurred_at::date>=_from) AND (_to IS NULL OR s.occurred_at::date<=_to) AND (_module IS NULL OR s.source_module=public.neo_canonical_posting_module(_module)) AND (_financial IS NULL OR s.financial_state=_financial) ORDER BY s.updated_at DESC LIMIT 1000 $$;
REVOKE ALL ON FUNCTION public.neo_canonical_state_register(uuid,date,date,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.neo_canonical_state_register(uuid,date,date,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_night_audit_run(_branch uuid,_date date DEFAULT NULL,_mode text DEFAULT 'manual') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE org uuid:=public.current_org_id(); d date:=coalesce(_date,current_date); rid uuid; ref text; attempt int; started timestamptz:=now(); blockers int:=0; warnings int:=0; counts jsonb:='{}'; snapshot jsonb:='[]'; summary jsonb; digest text; operator text; err text;
BEGIN
 IF org IS NULL THEN RAISE EXCEPTION 'No workspace context'; END IF;
 IF NOT(public.has_permission('finance','eod','view') OR public.is_org_admin()) THEN RAISE EXCEPTION 'Forbidden'; END IF;
 IF _branch IS NULL OR NOT EXISTS(SELECT 1 FROM public.branches b WHERE b.id=_branch AND b.organization_id=org) THEN RAISE EXCEPTION 'Unknown property'; END IF;
 SELECT coalesce(p.full_name,p.email) INTO operator FROM public.profiles p WHERE p.id=auth.uid();
 INSERT INTO public.night_audit_runs(organization_id,branch_id,business_date,run_mode,created_by,started_at,operator_name,run_reference,status,stage,rerun_count)
 VALUES(org,_branch,d,coalesce(_mode,'manual'),auth.uid(),started,operator,public.neo_night_audit_reference(org,_branch,d),'running','collecting',0)
 ON CONFLICT(organization_id,branch_id,business_date) DO UPDATE SET run_mode=excluded.run_mode,created_by=auth.uid(),started_at=started,completed_at=NULL,operator_name=excluded.operator_name,status='running',stage='collecting',rerun_count=public.night_audit_runs.rerun_count+1
 RETURNING id,run_reference,rerun_count+1 INTO rid,ref,attempt;
 INSERT INTO public.night_audit_attempts(run_id,organization_id,branch_id,business_date,attempt_number,stage,status,started_at,actor_id) VALUES(rid,org,_branch,d,attempt,'collecting','running',started,auth.uid());
 BEGIN
  DELETE FROM public.night_audit_exceptions WHERE run_id=rid;
  INSERT INTO public.night_audit_exceptions(run_id,organization_id,branch_id,business_date,category,severity,reference,detail,amount)
  SELECT rid,org,_branch,d,'finance-posting','blocking',e.reference,coalesce(e.detail,e.reason),e.amount FROM public.neo_finance_exception_register(_branch,d,d)e;
  INSERT INTO public.night_audit_exceptions(run_id,organization_id,branch_id,business_date,category,severity,reference,detail,amount)
  SELECT rid,org,_branch,d,'finance-posting','blocking',q.reference,q.required_action,q.amount FROM public.neo_finance_posting_queue(_branch,d,d)q WHERE q.eligible;
  INSERT INTO public.night_audit_exceptions(run_id,organization_id,branch_id,business_date,category,severity,reference,detail,amount)
  SELECT rid,org,_branch,d,'approval','warning',coalesce(nullif(a.reference,''),a.id::text),'Controlled transaction is still awaiting approval.',a.amount FROM public.approval_requests a WHERE a.organization_id=org AND a.branch_id=_branch AND a.created_at::date<=d AND public.neo_approval_normalize_status(a.status)='pending';
  SELECT count(*) FILTER(WHERE severity='blocking'),count(*) FILTER(WHERE severity='warning'),coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.created_at),'[]'::jsonb) INTO blockers,warnings,snapshot FROM public.night_audit_exceptions e WHERE e.run_id=rid;
  SELECT coalesce(jsonb_object_agg(source_module,c),'{}'::jsonb) INTO counts FROM(SELECT source_module,count(*) c FROM public.canonical_transaction_states WHERE organization_id=org AND branch_id=_branch AND occurred_at::date=d GROUP BY source_module)x;
  summary:=jsonb_build_object('reference',ref,'operator',operator,'started_at',started,'finished_at',now(),'source_counts',counts,'blocking',blockers,'warnings',warnings,'outcome',CASE WHEN blockers>0 THEN 'exception' ELSE 'completed' END);
  digest:=encode(digest(convert_to(summary::text,'UTF8'),'sha256'),'hex');
  UPDATE public.night_audit_runs SET blocking_count=blockers,warning_count=warnings,status=CASE WHEN blockers>0 THEN 'exception' ELSE 'completed' END,stage='signed',completed_at=now(),source_counts=counts,exception_snapshot=snapshot,summary=summary,result_digest=digest,signed_at=now() WHERE id=rid;
  UPDATE public.night_audit_attempts SET stage='signed',status=CASE WHEN blockers>0 THEN 'exception' ELSE 'completed' END,source_counts=counts,exception_snapshot=snapshot,result_digest=digest,completed_at=now() WHERE run_id=rid AND attempt_number=attempt;
 EXCEPTION WHEN OTHERS THEN
  err:=SQLERRM; blockers:=1;
  UPDATE public.night_audit_runs SET blocking_count=1,status='failed',stage='failed',completed_at=now(),summary=jsonb_build_object('reference',ref,'failed_stage','collecting','error',err),result_digest=NULL,signed_at=NULL WHERE id=rid;
  UPDATE public.night_audit_attempts SET stage='failed',status='failed',error=err,completed_at=now() WHERE run_id=rid AND attempt_number=attempt;
 END;
 RETURN jsonb_build_object('run_id',rid,'reference',ref,'business_date',d,'blocking',blockers,'warnings',warnings,'status',CASE WHEN err IS NOT NULL THEN 'failed' WHEN blockers>0 THEN 'exception' ELSE 'completed' END,'stage',CASE WHEN err IS NOT NULL THEN 'failed' ELSE 'signed' END,'digest',digest,'error',err);
END $$;
REVOKE ALL ON FUNCTION public.neo_night_audit_run(uuid,date,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.neo_night_audit_run(uuid,date,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_close_business_day(_branch uuid,_date date DEFAULT NULL,_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE org uuid:=public.current_org_id(); d date:=coalesce(_date,current_date); a public.night_audit_runs; unresolved int; dayid uuid;
BEGIN
 IF org IS NULL THEN RAISE EXCEPTION 'No workspace context'; END IF;
 IF NOT public.has_permission('finance','eod','close_business_day') THEN RAISE EXCEPTION 'Closing the business day requires the finance.eod.close_business_day permission'; END IF;
 IF EXISTS(SELECT 1 FROM public.business_days WHERE organization_id=org AND branch_id=_branch AND business_date=d AND status='closed') THEN RETURN jsonb_build_object('status','already_closed','business_date',d); END IF;
 SELECT * INTO a FROM public.night_audit_runs WHERE organization_id=org AND branch_id=_branch AND business_date=d FOR UPDATE;
 IF a.id IS NULL OR a.status<>'completed' OR a.stage<>'signed' OR a.result_digest IS NULL THEN RETURN jsonb_build_object('status','exception','business_date',d,'blocking',coalesce(a.blocking_count,1),'message','Run and complete a signed End-of-Day audit before closing.'); END IF;
 SELECT count(*) INTO unresolved FROM public.neo_finance_exception_register(_branch,d,d);
 unresolved:=unresolved+(SELECT count(*) FROM public.neo_finance_posting_queue(_branch,d,d) WHERE eligible);
 IF a.blocking_count>0 OR unresolved>0 THEN RETURN jsonb_build_object('status','exception','business_date',d,'blocking',greatest(a.blocking_count,unresolved),'message','Reconciliation is unresolved. Resolve the canonical Finance exceptions before closing.'); END IF;
 INSERT INTO public.business_days(organization_id,branch_id,business_date,status,closed_at,closed_by,close_mode,notes) VALUES(org,_branch,d,'closed',now(),auth.uid(),'manual',_note) ON CONFLICT(organization_id,branch_id,business_date) DO UPDATE SET status='closed',closed_at=now(),closed_by=auth.uid(),close_mode='manual',notes=coalesce(excluded.notes,public.business_days.notes) RETURNING id INTO dayid;
 INSERT INTO public.business_days(organization_id,branch_id,business_date,status,opened_at,opened_by) VALUES(org,_branch,d+1,'open',now(),auth.uid()) ON CONFLICT(organization_id,branch_id,business_date) DO NOTHING;
 INSERT INTO public.audit_logs(organization_id,branch_id,user_id,action,module,record_id,new_value) VALUES(org,_branch,auth.uid(),'finance.business_day_closed','finance',dayid::text,jsonb_build_object('branch_id',_branch,'business_date',d,'audit_id',a.id,'audit_reference',a.run_reference,'result_digest',a.result_digest));
 RETURN jsonb_build_object('status','closed','business_date',d,'audit_id',a.id,'audit_reference',a.run_reference,'result_digest',a.result_digest,'next_business_date',d+1);
END $$;
REVOKE ALL ON FUNCTION public.neo_close_business_day(uuid,date,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.neo_close_business_day(uuid,date,text) TO authenticated;