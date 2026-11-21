-- NEØ scoped delivery M-PESA claim installation, reviewed against supplied live catalogues.
-- Run the complete file once in the existing SQL Editor. No historical migration replay.
-- Creates NEW claim objects only; never rewrites the existing accounting/PIN routines or past money.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $guard$
DECLARE expected record; actual text;
BEGIN
 IF to_regclass('public.delivery_mpesa_till_claims') IS NOT NULL
 OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('neo_delivery_mpesa_till_claim_submit',
  'neo_delivery_mpesa_till_claim_queue','neo_delivery_mpesa_till_claim_approve','neo_delivery_mpesa_claim_evidence')) THEN
  RAISE EXCEPTION 'Claim objects already exist. Stop and inspect; do not replay this installation.';
 END IF;
 FOR expected IN SELECT * FROM (VALUES
('public.fin_post_journal(uuid)','4162e3e7a44d05a75389087945abe2b2'),
('public.my_customer_id()','e21f0f70b524a8b3e73b59106482a99f'),
('public.neo_assert_financial_account(uuid,uuid,uuid)','477d1f2c64b1aa31fd590f555b5017e8'),
('public.neo_delivery_can_record_payment(uuid)','127eb1f024c7f840fe6e9a61816d325d'),
('public.neo_delivery_record_payment(uuid,numeric,text,text,text,text,uuid)','cda68d658709e2269ad12fc1d52dae79'),
('public.neo_gl_account_code(uuid,text,uuid)','dd75cc1b6856b7f84ea16b946a83ff51'),
('public.neo_gl_cash_code(uuid,text,uuid)','c64b806f2c06ab2c865c35ef350f3f79'),
('public.next_document_number(text,text,uuid,uuid)','97d4255981971bd2965649afdbf913ba'),
('public.current_org_id()','71272f28f7dea5f8225eddd184456944'),
('public.customer_owns_delivery(uuid)','10c0570ad50be94f488acf8a0a3f3d12'),
('public.has_permission(text,text,text)','58c4dcfb9abe02bc7e46e0b02c027c31'),
('public.has_permission(text,text)','cf18d773f535cc8660bf4ad1a7f6f010'),
('public.is_org_admin_for(uuid)','4fa0bc2f4eb4ab5add02c84c5e51b419'),
('public.neo_branch_in_scope(uuid)','073af6634a1614993b8a1c0061643270')
 ) AS v(signature,definition_md5) LOOP
  SELECT md5(pg_get_functiondef(to_regprocedure(expected.signature))) INTO actual;
  IF actual IS DISTINCT FROM expected.definition_md5 THEN
   RAISE EXCEPTION 'Reviewed prerequisite changed or is missing: %. Run fresh read-only preflight; do not remove guard.',expected.signature;
  END IF;
 END LOOP;
 FOR expected IN SELECT * FROM (VALUES
('chart_of_accounts','id','uuid'),
('chart_of_accounts','organization_id','uuid'),
('chart_of_accounts','code','text'),
('chart_of_accounts','name','text'),
('chart_of_accounts','category','text'),
('chart_of_accounts','account_group','text'),
('chart_of_accounts','parent_id','uuid'),
('chart_of_accounts','is_header','boolean'),
('chart_of_accounts','postable','boolean'),
('chart_of_accounts','active','boolean'),
('chart_of_accounts','currency','text'),
('chart_of_accounts','default_tax_code_id','uuid'),
('chart_of_accounts','department_id','uuid'),
('chart_of_accounts','source_modules','ARRAY'),
('chart_of_accounts','description','text'),
('chart_of_accounts','created_by','uuid'),
('chart_of_accounts','created_at','timestamp with time zone'),
('chart_of_accounts','updated_at','timestamp with time zone'),
('invoices','id','uuid'),
('invoices','organization_id','uuid'),
('invoices','branch_id','uuid'),
('invoices','invoice_number','text'),
('invoices','document_type','text'),
('invoices','customer_id','uuid'),
('invoices','corporate_account_id','uuid'),
('invoices','folio_id','uuid'),
('invoices','event_booking_id','uuid'),
('invoices','reservation_id','uuid'),
('invoices','issue_date','date'),
('invoices','due_date','date'),
('invoices','currency','text'),
('invoices','bill_to_snapshot','jsonb'),
('invoices','issuer_snapshot','jsonb'),
('invoices','subtotal','numeric'),
('invoices','discount_total','numeric'),
('invoices','service_charge_total','numeric'),
('invoices','tax_total','numeric'),
('invoices','total','numeric'),
('invoices','amount_paid','numeric'),
('invoices','balance','numeric'),
('invoices','status','text'),
('invoices','etims_status','text'),
('invoices','journal_id','uuid'),
('invoices','notes','text'),
('invoices','created_by','uuid'),
('invoices','issued_at','timestamp with time zone'),
('invoices','created_at','timestamp with time zone'),
('invoices','updated_at','timestamp with time zone'),
('journal_entries','id','uuid'),
('journal_entries','organization_id','uuid'),
('journal_entries','branch_id','uuid'),
('journal_entries','journal_number','text'),
('journal_entries','journal_type','text'),
('journal_entries','accounting_date','date'),
('journal_entries','period_id','uuid'),
('journal_entries','source_module','text'),
('journal_entries','source_document_type','text'),
('journal_entries','source_document_id','uuid'),
('journal_entries','document_number','text'),
('journal_entries','idempotency_key','text'),
('journal_entries','description','text'),
('journal_entries','currency','text'),
('journal_entries','exchange_rate','numeric'),
('journal_entries','total_debit','numeric'),
('journal_entries','total_credit','numeric'),
('journal_entries','status','text'),
('journal_entries','approval_request_id','uuid'),
('journal_entries','reverses_journal_id','uuid'),
('journal_entries','reversed_by_journal_id','uuid'),
('journal_entries','created_by','uuid'),
('journal_entries','posted_by','uuid'),
('journal_entries','posted_at','timestamp with time zone'),
('journal_entries','created_at','timestamp with time zone'),
('journal_entries','updated_at','timestamp with time zone'),
('journal_entry_lines','id','uuid'),
('journal_entry_lines','organization_id','uuid'),
('journal_entry_lines','journal_id','uuid'),
('journal_entry_lines','line_number','integer'),
('journal_entry_lines','account_id','uuid'),
('journal_entry_lines','description','text'),
('journal_entry_lines','debit','numeric'),
('journal_entry_lines','credit','numeric'),
('journal_entry_lines','branch_id','uuid'),
('journal_entry_lines','department_id','uuid'),
('journal_entry_lines','cost_centre','text'),
('journal_entry_lines','revenue_centre','text'),
('journal_entry_lines','customer_id','uuid'),
('journal_entry_lines','corporate_account_id','uuid'),
('journal_entry_lines','supplier_id','uuid'),
('journal_entry_lines','folio_id','uuid'),
('journal_entry_lines','event_booking_id','uuid'),
('journal_entry_lines','payment_method','text'),
('journal_entry_lines','tax_code_id','uuid'),
('journal_entry_lines','created_at','timestamp with time zone'),
('payments','id','uuid'),
('payments','organization_id','uuid'),
('payments','branch_id','uuid'),
('payments','receipt_number','text'),
('payments','folio_id','uuid'),
('payments','reservation_id','uuid'),
('payments','customer_id','uuid'),
('payments','amount','numeric'),
('payments','currency','text'),
('payments','method','text'),
('payments','external_reference','text'),
('payments','paid_at','timestamp with time zone'),
('payments','status','text'),
('payments','received_by','uuid'),
('payments','notes','text'),
('payments','created_at','timestamp with time zone'),
('payments','updated_at','timestamp with time zone'),
('payments','shift_id','uuid'),
('payments','station_id','uuid'),
('payments','source_module','text'),
('payments','source_record_id','uuid'),
('payments','idempotency_key','text'),
('payments','correlation_id','uuid'),
('payments','posted_journal_id','uuid'),
('payments','destination_account_id','uuid'),
('pos_payments','id','uuid'),
('pos_payments','organization_id','uuid'),
('pos_payments','branch_id','uuid'),
('pos_payments','order_id','uuid'),
('pos_payments','receipt_number','text'),
('pos_payments','customer_id','uuid'),
('pos_payments','amount','numeric'),
('pos_payments','tendered','numeric'),
('pos_payments','change_due','numeric'),
('pos_payments','currency','text'),
('pos_payments','method','text'),
('pos_payments','external_reference','text'),
('pos_payments','provider_status','text'),
('pos_payments','provider_payload','jsonb'),
('pos_payments','status','text'),
('pos_payments','paid_at','timestamp with time zone'),
('pos_payments','cashier_id','uuid'),
('pos_payments','shift_id','uuid'),
('pos_payments','verified_by','uuid'),
('pos_payments','verification_note','text'),
('pos_payments','created_at','timestamp with time zone'),
('pos_payments','updated_at','timestamp with time zone'),
('pos_payments','created_by','uuid'),
('pos_payments','idempotency_key','text'),
('pos_payments','correlation_id','uuid'),
('pos_payments','destination_account_id','uuid'),
('delivery_orders','id','uuid'),
('delivery_orders','organization_id','uuid'),
('delivery_orders','branch_id','uuid'),
('delivery_orders','pos_order_id','uuid'),
('delivery_orders','customer_id','uuid'),
('delivery_orders','auth_user_id','uuid'),
('delivery_orders','order_number','text'),
('delivery_orders','order_channel','text'),
('delivery_orders','fulfilment_type','text'),
('delivery_orders','contact_name','text'),
('delivery_orders','contact_phone','text'),
('delivery_orders','address_snapshot','jsonb'),
('delivery_orders','zone_id','uuid'),
('delivery_orders','latitude','numeric'),
('delivery_orders','longitude','numeric'),
('delivery_orders','subtotal','numeric'),
('delivery_orders','tax_total','numeric'),
('delivery_orders','discount_total','numeric'),
('delivery_orders','delivery_fee','numeric'),
('delivery_orders','tip_amount','numeric'),
('delivery_orders','grand_total','numeric'),
('delivery_orders','currency','text'),
('delivery_orders','payment_method','text'),
('delivery_orders','payment_status','text'),
('delivery_orders','promo_code','text'),
('delivery_orders','promotion_id','uuid'),
('delivery_orders','scheduled_for','timestamp with time zone'),
('delivery_orders','requested_at','timestamp with time zone'),
('delivery_orders','estimated_prep_minutes','integer'),
('delivery_orders','estimated_delivery_at','timestamp with time zone'),
('delivery_orders','order_status','text'),
('delivery_orders','kitchen_status','text'),
('delivery_orders','dispatch_status','text'),
('delivery_orders','rider_id','uuid'),
('delivery_orders','accepted_at','timestamp with time zone'),
('delivery_orders','ready_at','timestamp with time zone'),
('delivery_orders','collected_at','timestamp with time zone'),
('delivery_orders','delivered_at','timestamp with time zone'),
('delivery_orders','cancelled_at','timestamp with time zone'),
('delivery_orders','cancellation_reason','text'),
('delivery_orders','rejection_reason','text'),
('delivery_orders','packaging_checklist','jsonb'),
('delivery_orders','packaging_completed_at','timestamp with time zone'),
('delivery_orders','notes','text'),
('delivery_orders','allergy_note','text'),
('delivery_orders','created_by','uuid'),
('delivery_orders','created_at','timestamp with time zone'),
('delivery_orders','updated_at','timestamp with time zone'),
('delivery_orders','service_charge_total','numeric'),
('delivery_orders','intake_idempotency_key','text'),
('delivery_orders','intake_request_hash','text')
 ) AS v(table_name,column_name,data_type) LOOP
  IF NOT EXISTS(SELECT 1 FROM information_schema.columns c WHERE c.table_schema='public'
   AND c.table_name=expected.table_name AND c.column_name=expected.column_name AND c.data_type=expected.data_type) THEN
   RAISE EXCEPTION 'Required column differs: %.%',expected.table_name,expected.column_name;
  END IF;
 END LOOP;
END $guard$;
CREATE TABLE public.delivery_mpesa_till_claims (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL,
 branch_id uuid NOT NULL,
 delivery_order_id uuid NOT NULL REFERENCES public.delivery_orders(id),
 receipt_code text NOT NULL CHECK (receipt_code ~ '^[A-Z0-9]{10,12}$'),
 status text NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','merchant_verified','rejected')),
 submitted_by uuid NOT NULL,
 submitted_at timestamptz NOT NULL DEFAULT now(),
 reviewed_by uuid, reviewed_at timestamptz, review_note text,
 merchant_till text, verified_amount numeric,
 receiving_account_id uuid, payment_id uuid REFERENCES public.payments(id),
 invoice_id uuid REFERENCES public.invoices(id), journal_id uuid REFERENCES public.journal_entries(id),
 CONSTRAINT delivery_mpesa_till_receipt_uq UNIQUE(organization_id,receipt_code),
 CONSTRAINT delivery_mpesa_till_verified_evidence CHECK(status <> 'merchant_verified' OR
  (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND length(btrim(review_note))>=10
   AND length(btrim(merchant_till))>0 AND verified_amount>0 AND receiving_account_id IS NOT NULL
   AND payment_id IS NOT NULL AND invoice_id IS NOT NULL AND journal_id IS NOT NULL))
);
CREATE INDEX delivery_mpesa_till_claims_queue_idx ON public.delivery_mpesa_till_claims(organization_id,branch_id,status,submitted_at);
CREATE UNIQUE INDEX delivery_mpesa_till_claim_payment_uq ON public.delivery_mpesa_till_claims(payment_id) WHERE payment_id IS NOT NULL;
ALTER TABLE public.delivery_mpesa_till_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.delivery_mpesa_till_claims FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.neo_delivery_mpesa_till_claim_submit(_order uuid,_receipt text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $fn$
DECLARE d public.delivery_orders; c public.delivery_mpesa_till_claims; code text;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
 code:=upper(regexp_replace(btrim(coalesce(_receipt,'')), '[[:space:]]', '', 'g'));
 IF code !~ '^[A-Z0-9]{10,12}$' THEN
  RETURN jsonb_build_object('ok',false,'reason','invalid_receipt','detail','Enter a valid M-PESA transaction code.');
 END IF;
 SELECT * INTO d FROM public.delivery_orders WHERE id=_order FOR UPDATE;
 -- Guest ownership is verified through the existing customer identity, not staff workspace context.
 IF d.id IS NULL OR public.customer_owns_delivery(_order) IS NOT TRUE
    OR d.customer_id IS DISTINCT FROM public.my_customer_id() THEN
  RETURN jsonb_build_object('ok',false,'reason','order_not_found');
 END IF;
 IF d.organization_id IS NULL OR d.branch_id IS NULL OR coalesce(d.currency,'')<>'KES'
    OR lower(coalesce(d.payment_method,''))<>'mpesa' THEN
  RETURN jsonb_build_object('ok',false,'reason','wrong_payment_method','detail','A property-scoped KES M-PESA order is required.');
 END IF;
 SELECT * INTO c FROM public.delivery_mpesa_till_claims
 WHERE organization_id=d.organization_id AND receipt_code=code;
 IF c.id IS NOT NULL THEN
  IF c.delivery_order_id=d.id THEN
   RETURN jsonb_build_object('ok',true,'already_submitted',true,'claim_id',c.id,'status',c.status,
     'payment_verified',c.status='merchant_verified');
  END IF;
  RETURN jsonb_build_object('ok',false,'reason','receipt_already_submitted');
 END IF;
 IF lower(coalesce(d.payment_status,'')) IN ('paid','settled','completed','refunded','voided')
    OR lower(coalesce(d.order_status,'')) IN ('cancelled','rejected','failed') THEN
  RETURN jsonb_build_object('ok',false,'reason','order_closed');
 END IF;
 INSERT INTO public.delivery_mpesa_till_claims(organization_id,branch_id,delivery_order_id,receipt_code,submitted_by)
 VALUES(d.organization_id,d.branch_id,d.id,code,auth.uid()) RETURNING * INTO c;
 RETURN jsonb_build_object('ok',true,'claim_id',c.id,'status',c.status,'payment_verified',false,
  'detail','Reference submitted for independent merchant verification. This is not proof of payment.');
EXCEPTION WHEN unique_violation THEN
 RETURN jsonb_build_object('ok',false,'reason','receipt_already_submitted');
END $fn$;

CREATE FUNCTION public.neo_delivery_mpesa_till_claim_queue()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $fn$
DECLARE org uuid:=public.current_org_id(); result jsonb;
BEGIN
 IF auth.uid() IS NULL OR org IS NULL OR NOT coalesce((public.is_org_admin_for(org)
    OR public.has_permission('finance','approve') OR public.has_permission('pos','payments','manual-confirm')),false) THEN
  RAISE EXCEPTION 'Finance payment review permission required' USING ERRCODE='42501';
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('claim_id',c.id,'delivery_order_id',d.id,
  'order_number',d.order_number,'receipt_code',c.receipt_code,'order_total',d.grand_total,
  'payment_status',d.payment_status,'claim_status',c.status,'submitted_at',c.submitted_at,
  'branch_id',c.branch_id) ORDER BY c.submitted_at DESC),'[]'::jsonb) INTO result
 FROM public.delivery_mpesa_till_claims c JOIN public.delivery_orders d ON d.id=c.delivery_order_id
 AND d.organization_id=c.organization_id AND d.branch_id=c.branch_id
 WHERE c.organization_id=org AND c.status='submitted' AND public.neo_branch_in_scope(c.branch_id) IS TRUE;
 RETURN result;
END $fn$;

-- Private evidence checker, not an API. Never trusts an ok flag alone.
CREATE FUNCTION public.neo_delivery_mpesa_claim_evidence(_claim uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $fn$
DECLARE c public.delivery_mpesa_till_claims; p public.payments; j public.journal_entries;
 i public.invoices; d public.delivery_orders; debit numeric; credit numeric; journal_count integer;
BEGIN
 SELECT * INTO c FROM public.delivery_mpesa_till_claims WHERE id=_claim;
 IF c.id IS NULL OR c.organization_id IS DISTINCT FROM public.current_org_id()
    OR public.neo_branch_in_scope(c.branch_id) IS NOT TRUE THEN
  RAISE EXCEPTION 'Claim evidence outside current scope' USING ERRCODE='42501';
 END IF;
 SELECT * INTO p FROM public.payments WHERE id=c.payment_id;
 SELECT * INTO j FROM public.journal_entries WHERE id=c.journal_id;
 SELECT * INTO i FROM public.invoices WHERE id=c.invoice_id;
 SELECT * INTO d FROM public.delivery_orders WHERE id=c.delivery_order_id;
 IF p.id IS NULL OR j.id IS NULL OR i.id IS NULL OR d.id IS NULL
    OR p.organization_id IS DISTINCT FROM c.organization_id OR p.branch_id IS DISTINCT FROM c.branch_id
    OR p.customer_id IS DISTINCT FROM d.customer_id OR p.source_module IS DISTINCT FROM 'delivery' OR p.source_record_id IS DISTINCT FROM d.id
    OR p.amount IS DISTINCT FROM c.verified_amount OR p.method IS DISTINCT FROM 'mpesa'
    OR p.status IS DISTINCT FROM 'confirmed' OR p.external_reference IS DISTINCT FROM c.receipt_code
    OR p.destination_account_id IS DISTINCT FROM c.receiving_account_id OR p.posted_journal_id IS DISTINCT FROM j.id
    OR coalesce(p.receipt_number,'')='' OR p.currency IS DISTINCT FROM 'KES'
    OR j.organization_id IS DISTINCT FROM c.organization_id OR j.branch_id IS DISTINCT FROM c.branch_id
    OR j.source_module IS DISTINCT FROM 'delivery' OR j.source_document_type IS DISTINCT FROM 'delivery_payment'
    OR j.source_document_id IS DISTINCT FROM p.id OR j.document_number IS DISTINCT FROM p.receipt_number
    OR j.status IS DISTINCT FROM 'posted' OR j.reversed_by_journal_id IS NOT NULL OR j.currency IS DISTINCT FROM 'KES'
    OR i.organization_id IS DISTINCT FROM c.organization_id OR i.branch_id IS DISTINCT FROM c.branch_id
    OR coalesce(i.notes,'') NOT LIKE '%delivery-order:'||d.id::text||'%' OR i.currency IS DISTINCT FROM 'KES'
    OR i.balance IS DISTINCT FROM 0::numeric OR i.amount_paid IS DISTINCT FROM i.total OR i.status IS DISTINCT FROM 'paid'
    OR d.organization_id IS DISTINCT FROM c.organization_id OR d.branch_id IS DISTINCT FROM c.branch_id
    OR d.payment_status IS DISTINCT FROM 'paid' OR d.currency IS DISTINCT FROM 'KES' THEN
  RAISE EXCEPTION 'Payment, invoice, order or posted journal evidence did not reconcile' USING ERRCODE='23514';
 END IF;
 SELECT coalesce(sum(l.debit),0),coalesce(sum(l.credit),0) INTO debit,credit
 FROM public.journal_entry_lines l WHERE l.journal_id=j.id;
 IF debit IS DISTINCT FROM c.verified_amount OR credit IS DISTINCT FROM c.verified_amount
    OR EXISTS(SELECT 1 FROM public.journal_entry_lines l WHERE l.journal_id=j.id
      AND (l.organization_id IS DISTINCT FROM c.organization_id OR l.branch_id IS DISTINCT FROM c.branch_id)) THEN
  RAISE EXCEPTION 'Payment journal lines do not reconcile' USING ERRCODE='23514';
 END IF;
 SELECT count(*) INTO journal_count FROM public.journal_entries x
 WHERE x.organization_id=c.organization_id AND x.source_document_id=p.id
 AND x.status='posted' AND x.reversed_by_journal_id IS NULL;
 IF journal_count<>1 THEN RAISE EXCEPTION 'Payment requires exactly one unreversed posted journal' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('ok',true,'payment_id',p.id,'receipt_number',p.receipt_number,
  'journal_id',j.id,'journal_number',j.journal_number,'amount',p.amount,'balance',i.balance,
  'invoice_number',i.invoice_number,'destination_account_id',p.destination_account_id);
END $fn$;

CREATE FUNCTION public.neo_delivery_mpesa_till_claim_approve(_claim uuid,_verified_amount numeric,
 _merchant_till text,_verification_note text,_receiving_account uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $fn$
DECLARE org uuid:=public.current_org_id(); c public.delivery_mpesa_till_claims;
 d public.delivery_orders; inv public.invoices; p public.payments; order_id uuid;
 result jsonb; evidence jsonb; count_invoices integer; initial_paid numeric; initial_balance numeric;
BEGIN
 IF auth.uid() IS NULL OR org IS NULL OR NOT coalesce((public.is_org_admin_for(org)
   OR public.has_permission('finance','approve')),false) THEN
  RAISE EXCEPTION 'Independent finance verification permission required' USING ERRCODE='42501';
 END IF;
 IF _verified_amount IS NULL OR _verified_amount::text IN ('NaN','Infinity','-Infinity')
    OR _verified_amount<=0 OR round(_verified_amount,2)<>_verified_amount
    OR length(btrim(coalesce(_merchant_till,'')))=0
    OR length(btrim(coalesce(_verification_note,'')))<10 OR _receiving_account IS NULL THEN
  RAISE EXCEPTION 'Verified amount, receiving account, merchant Till and evidence are required' USING ERRCODE='23514';
 END IF;
 SELECT delivery_order_id INTO order_id FROM public.delivery_mpesa_till_claims WHERE id=_claim AND organization_id=org;
 -- Match the established order-before-invoice lock order. Lock the claim after its order.
 SELECT * INTO d FROM public.delivery_orders WHERE id=order_id AND organization_id=org FOR UPDATE;
 SELECT * INTO c FROM public.delivery_mpesa_till_claims WHERE id=_claim AND organization_id=org FOR UPDATE;
 IF c.id IS NULL OR d.id IS NULL OR d.id IS DISTINCT FROM c.delivery_order_id
    OR d.branch_id IS DISTINCT FROM c.branch_id OR public.neo_branch_in_scope(c.branch_id) IS NOT TRUE THEN
  RAISE EXCEPTION 'Claim not found in this property scope' USING ERRCODE='42501';
 END IF;
 IF c.submitted_by=auth.uid() THEN RAISE EXCEPTION 'A claim must be verified independently of its submitter' USING ERRCODE='42501'; END IF;
 IF c.status='merchant_verified' THEN
  IF c.verified_amount IS DISTINCT FROM _verified_amount OR c.receiving_account_id IS DISTINCT FROM _receiving_account
     OR c.merchant_till IS DISTINCT FROM btrim(_merchant_till) THEN
   RAISE EXCEPTION 'Retry details differ from the verified claim' USING ERRCODE='23514';
  END IF;
  evidence:=public.neo_delivery_mpesa_claim_evidence(c.id);
  RETURN jsonb_build_object('ok',true,'already_verified',true,'claim_id',c.id,'status',c.status,'payment_result',evidence);
 END IF;
 IF c.status<>'submitted' OR coalesce(d.currency,'')<>'KES'
    OR lower(coalesce(d.payment_method,''))<>'mpesa'
    OR lower(coalesce(d.payment_status,'')) IN ('paid','settled','completed','refunded','voided')
    OR lower(coalesce(d.order_status,'')) IN ('cancelled','rejected','failed') THEN
  RAISE EXCEPTION 'This claim/order cannot accept payment' USING ERRCODE='23514';
 END IF;
 PERFORM public.neo_assert_financial_account(org,c.branch_id,_receiving_account);
 SELECT count(*) INTO count_invoices FROM public.invoices i
 WHERE i.organization_id=org AND i.notes LIKE '%delivery-order:'||d.id::text||'%';
 IF count_invoices<>1 THEN RAISE EXCEPTION 'Exactly one linked delivery invoice is required' USING ERRCODE='23514'; END IF;
 SELECT * INTO inv FROM public.invoices i WHERE i.organization_id=org
 AND i.notes LIKE '%delivery-order:'||d.id::text||'%' FOR UPDATE;
 IF inv.branch_id IS DISTINCT FROM c.branch_id OR inv.currency IS DISTINCT FROM 'KES'
    OR inv.status IN ('draft','cancelled','void','voided','refunded')
    OR inv.balance IS NULL OR inv.balance<=0 OR inv.balance<>_verified_amount THEN
  RAISE EXCEPTION 'Verified amount must equal the outstanding issued invoice balance at this property' USING ERRCODE='23514';
 END IF;
 IF inv.total IS NULL OR inv.amount_paid IS NULL OR inv.total::text IN ('NaN','Infinity','-Infinity')
    OR inv.total<=0 OR inv.amount_paid<0 OR inv.balance IS DISTINCT FROM round(inv.total-inv.amount_paid,2) THEN
  RAISE EXCEPTION 'Invoice balance does not reconcile with its total and prior payments' USING ERRCODE='23514';
 END IF;
 initial_paid:=coalesce(inv.amount_paid,0); initial_balance:=inv.balance;
 PERFORM pg_advisory_xact_lock(hashtextextended('neo:mpesa:'||org::text||':'||c.receipt_code,0));
 IF EXISTS(SELECT 1 FROM public.payments ep WHERE ep.organization_id=org
  AND upper(btrim(coalesce(ep.external_reference,'')))=c.receipt_code)
 OR EXISTS(SELECT 1 FROM public.pos_payments ep WHERE ep.organization_id=org
  AND upper(btrim(coalesce(ep.external_reference,'')))=c.receipt_code) THEN
  RAISE EXCEPTION 'M-PESA reference already exists in payment records' USING ERRCODE='23514';
 END IF;
 result:=public.neo_delivery_record_payment(d.id,_verified_amount,'mpesa','payment',c.receipt_code,
  'Manual merchant verification. Till: '||btrim(_merchant_till)||'. Evidence: '||btrim(_verification_note),_receiving_account);
 IF result IS NULL OR result->>'ok' IS DISTINCT FROM 'true' OR result->>'payment_id' IS NULL THEN
  RAISE EXCEPTION 'Existing delivery accounting did not confirm a saved payment' USING ERRCODE='23514';
 END IF;
 SELECT * INTO p FROM public.payments WHERE id=(result->>'payment_id')::uuid FOR UPDATE;
 UPDATE public.delivery_mpesa_till_claims SET verified_amount=_verified_amount,merchant_till=btrim(_merchant_till),
  receiving_account_id=_receiving_account,payment_id=p.id,invoice_id=inv.id,journal_id=p.posted_journal_id,
  reviewed_by=auth.uid(),reviewed_at=now(),review_note=btrim(_verification_note) WHERE id=c.id;
 -- Exceptions here roll back the canonical payment and all of its transactional effects as well.
 evidence:=public.neo_delivery_mpesa_claim_evidence(c.id);
 IF NOT EXISTS(SELECT 1 FROM public.invoices i WHERE i.id=inv.id
   AND i.amount_paid=initial_paid+_verified_amount AND i.balance=initial_balance-_verified_amount) THEN
  RAISE EXCEPTION 'Invoice changed by an unexpected amount' USING ERRCODE='23514';
 END IF;
 UPDATE public.delivery_mpesa_till_claims SET status='merchant_verified' WHERE id=c.id;
 RETURN jsonb_build_object('ok',true,'claim_id',c.id,'delivery_order_id',d.id,
  'receipt_code',c.receipt_code,'verified_amount',_verified_amount,'status','merchant_verified','payment_result',evidence);
END $fn$;

REVOKE ALL ON FUNCTION public.neo_delivery_mpesa_till_claim_submit(uuid,text) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.neo_delivery_mpesa_till_claim_queue() FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.neo_delivery_mpesa_till_claim_approve(uuid,numeric,text,text,uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.neo_delivery_mpesa_claim_evidence(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.neo_delivery_mpesa_till_claim_submit(uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_delivery_mpesa_till_claim_queue() TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_delivery_mpesa_till_claim_approve(uuid,numeric,text,text,uuid) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
