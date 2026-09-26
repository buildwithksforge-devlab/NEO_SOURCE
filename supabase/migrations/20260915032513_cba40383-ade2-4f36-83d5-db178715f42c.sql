CREATE OR REPLACE FUNCTION public.neo_canonical_source_sync()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE j jsonb:=to_jsonb(NEW); m text; ref text; op text; fin text; amt numeric:=0; cur text:='KES'; idem text; jid uuid; blocker text; nxt text; owner text; fs record;
BEGIN
 m:=CASE TG_TABLE_NAME WHEN 'goods_receipts' THEN 'inventory' WHEN 'event_bookings' THEN 'events' WHEN 'internal_requisitions' THEN 'requisition' WHEN 'maintenance_work_orders' THEN 'maintenance' WHEN 'pos_orders' THEN 'pos' WHEN 'supplier_invoices' THEN 'supplier_invoice' WHEN 'supplier_payments' THEN 'supplier_payment' WHEN 'folios' THEN 'folio' WHEN 'purchase_orders' THEN 'procurement' ELSE regexp_replace(TG_TABLE_NAME,'s$','') END;
 ref:=coalesce(j->>'grn_number',j->>'event_reference',j->>'request_number',j->>'work_order_number',j->>'receipt_number',j->>'order_number',j->>'po_number',j->>'folio_number',j->>'confirmation_number',j->>'room_number',j->>'invoice_number',j->>'payment_number',j->>'id');
 op:=coalesce(j->>'status',j->>'order_status',j->>'room_status','pending');
 amt:=coalesce(nullif(j->>'amount','')::numeric,nullif(j->>'grand_total','')::numeric,nullif(j->>'total_amount','')::numeric,nullif(j->>'total_value','')::numeric,nullif(j->>'total_charges','')::numeric,nullif(j->>'balance','')::numeric,0);
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
   WHEN m='folio' AND lower(op) IN('settled','closed') AND coalesce(nullif(j->>'balance','')::numeric,0)=0 THEN 'posted'
   WHEN m='folio' AND lower(op) IN('settled','closed') THEN 'blocked'
   WHEN m='folio' AND lower(op) IN('open','under-review') THEN 'pending'
   ELSE 'pending' END;
 END IF;
 IF m='folio' AND fin='blocked' AND blocker IS NULL THEN blocker:='Folio was closed with an outstanding balance'; END IF;
 nxt:=CASE fin WHEN 'eligible' THEN 'Post to the general ledger' WHEN 'blocked' THEN 'Resolve the blocking rule, then retry' WHEN 'failed' THEN 'Correct the failure and retry safely' WHEN 'pending' THEN 'Complete the current operational stage' ELSE NULL END;
 IF m='procurement' THEN nxt:=CASE WHEN lower(op) IN('closed','cancelled','fully-invoiced') THEN NULL ELSE 'Receive against this order, then invoice' END; END IF;
 -- A receipt whose accrual is posted has left Stores: Finance owns the invoice match.
 IF m='inventory' AND fin='posted' THEN nxt:='Match against the supplier invoice'; END IF;
 owner:=CASE WHEN fin IN('eligible','blocked','failed') THEN 'Finance' WHEN m='inventory' AND fin='posted' THEN 'Finance' WHEN m='inventory' THEN 'Stores' WHEN m='procurement' THEN 'Procurement' WHEN m='folio' THEN 'Front Office' WHEN m='maintenance' THEN 'Maintenance' WHEN m='requisition' THEN 'Requesting department' ELSE 'Operations' END;
 PERFORM public.neo_canonical_transaction_set((j->>'organization_id')::uuid,nullif(j->>'branch_id','')::uuid,m,(j->>'id')::uuid,ref,op,fin,amt,cur,idem,coalesce(nullif(j->>'updated_by','')::uuid,nullif(j->>'created_by','')::uuid,nullif(j->>'received_by','')::uuid,auth.uid()),owner,nxt,blocker,jid,fs.receipt_id,jsonb_strip_nulls(jsonb_build_object('journal_id',jid,'receipt_id',fs.receipt_id)),jsonb_build_object('source_table',TG_TABLE_NAME),coalesce(nullif(j->>'updated_at','')::timestamptz,nullif(j->>'created_at','')::timestamptz,now()));
 RETURN NEW;
END $function$;

UPDATE public.canonical_transaction_states
   SET current_owner = 'Finance',
       next_action = 'Match against the supplier invoice',
       updated_at = now()
 WHERE source_module = 'inventory'
   AND operational_state <> 'superseded'
   AND financial_state = 'posted'
   AND journal_id IS NOT NULL
   AND receipt_id IS NOT NULL
   AND (current_owner IS DISTINCT FROM 'Finance' OR next_action IS DISTINCT FROM 'Match against the supplier invoice');