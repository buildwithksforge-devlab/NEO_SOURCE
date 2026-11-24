-- READ ONLY: exact code, three repaired links, retained prerequisites, and mapping.
-- Does not retry/post the failed catering order or create/alter financial rows.
BEGIN READ ONLY;
WITH expected_new(signature,definition_md5) AS (VALUES
('public.neo_finance_post_txn(text,uuid,boolean)','b65eb27ced4ee472d51c9288aa86f534'),
('public.neo_gl_revenue_code_scoped(uuid,text,text)','a127ad1bfb734e62f7a3954e0e4305b3'),
('public.neo_pos_folio_journal_receipts()','60e18eec2839f26765a6a6457d7b701e'),
('public.neo_pos_room_charge_evidence(uuid,uuid,uuid,uuid,uuid)','c3bb117f433b4251187bbdc9231b6714'),
('public.neo_post_pos_order(uuid)','906974d623f661e7331b96ec0af8d07c'),
('public.neo_receipt_resolve_journal()','4d20f148f7d8d99c751d272e3869e140')
), expected_existing(signature,definition_md5) AS (VALUES
('public.fin_post_journal(uuid)','4162e3e7a44d05a75389087945abe2b2'),
('public.neo_finance_canonical_mark_posted(uuid,uuid,uuid,uuid)','0c201a4949d3228a990950efbe388e62'),
('public.neo_finance_exception_register(uuid,date,date)','94f136c7374520a1c33259f73f55c380'),
('public.neo_finance_post_family(text,uuid,boolean)','4271fba359558e4e58e0a66adfe36bce'),
('public.neo_finance_posting_queue(uuid,date,date)','06e9f84092e8c40e6dcc1e159b503d08'),
('public.neo_financial_state_from_receipt()','0af12c33c52a94ce889ba412f1e44369'),
('public.neo_financial_state_set(uuid,uuid,text,uuid,text,text,text,text,numeric,text,date,uuid,uuid,text,uuid,jsonb)','fb751a53d66f8490e90fd679b34f67ac'),
('public.neo_gl_post(uuid,uuid,text,text,uuid,text,date,text,text,jsonb,uuid,uuid)','7dfd4e4a4589661155fb5d7bcd02adfa'),
('public.neo_gl_revenue_code(text)','356b539623f311fa89019b39f862361e'),
('public.neo_journal_canonical_sync()','ae9012f7d7c272dbe4cc3ea6590f74c1'),
('public.neo_record_posting_receipt(uuid,uuid,text,uuid,text,text,numeric,text,uuid,text,text,date)','b6572ae73812155d3ae2eb08d71878b6')
), expected_links(receipt_id,order_id,line_id,journal_id,amount) AS (VALUES
('4c18ec8f-a776-4954-bc2c-21e514129f59'::uuid,'e035efe5-d68b-401d-a3e5-e1f4ef0377ef'::uuid,'51ec120d-c87f-43f4-919b-d114a196e3c5'::uuid,'17ca6aae-055a-4b32-93b0-5d04c1dfc827'::uuid,3399::numeric),
('f788bbe1-d6c2-4539-bfa0-430ae33f9341'::uuid,'0ef64b68-484d-4b3b-ae68-577daa632adc'::uuid,'64ede377-856e-42fd-8204-0d990a16875a'::uuid,'5a12f544-2980-4994-a5b9-8daa5ae89695'::uuid,1081.5::numeric),
('e0074db7-c506-408d-8849-5899ceb9bef5'::uuid,'113cb21c-82c0-41f4-b861-b80456b02ee8'::uuid,'9b67e3b3-a228-4bcc-adf0-1fc3dae68a40'::uuid,'293bd207-7597-4133-afc6-deed95275481'::uuid,2111.5::numeric)
), code AS (
 SELECT e.signature,coalesce(md5(pg_get_functiondef(to_regprocedure(e.signature)))=e.definition_md5,false) AS matches
 FROM expected_new e
), retained AS (
 SELECT e.signature,coalesce(md5(pg_get_functiondef(to_regprocedure(e.signature)))=e.definition_md5,false) AS unchanged
 FROM expected_existing e
), links AS (
 SELECT e.receipt_id,e.order_id,e.line_id,e.journal_id,
  coalesce(r.source_id=e.order_id AND r.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND r.branch_id='2addbd01-c643-406a-bd7d-fac1aa76b23c'::uuid
   AND r.source_module='pos' AND r.posting_type='room_charge' AND r.status='posted'
   AND r.amount=e.amount AND r.currency='KES' AND r.folio_line_id=e.line_id AND r.journal_id=e.journal_id
   AND o.organization_id=r.organization_id AND o.branch_id=r.branch_id AND o.folio_id=f.folio_id
   AND o.grand_total=e.amount AND o.status='charged-to-room'
   AND f.organization_id=r.organization_id AND f.branch_id=r.branch_id
   AND f.source_module='pos' AND f.source_record_uuid=e.order_id AND f.status='posted' AND f.line_type='charge'
   AND round(f.gross_amount-f.discount_amount+f.tax_amount+f.service_charge_amount,2)=e.amount
   AND j.organization_id=r.organization_id AND j.branch_id=r.branch_id
   AND j.source_document_type='folio_charge:revenue' AND j.source_document_id=f.id
   AND j.status='posted' AND j.reversed_by_journal_id IS NULL AND j.journal_type<>'reversal'
   AND j.currency=r.currency AND j.total_debit=e.amount AND j.total_credit=e.amount
   AND totals.debits=e.amount AND totals.credits=e.amount AND totals.scoped
   AND (SELECT count(*) FROM public.journal_entries other WHERE other.organization_id=r.organization_id
     AND other.branch_id=r.branch_id AND other.status='posted' AND other.reversed_by_journal_id IS NULL
     AND other.journal_type<>'reversal' AND other.source_document_id IN(e.line_id,e.order_id))=1
   AND cs.financial_state='posted' AND cs.journal_id=e.journal_id
   AND fs.financial_status='posted' AND fs.journal_id=e.journal_id,false) AS verified
 FROM expected_links e
 LEFT JOIN public.finance_posting_receipts r ON r.id=e.receipt_id
 LEFT JOIN public.pos_orders o ON o.id=e.order_id
 LEFT JOIN public.folio_lines f ON f.id=e.line_id
 LEFT JOIN public.journal_entries j ON j.id=e.journal_id
 LEFT JOIN public.canonical_transaction_states cs ON cs.organization_id=r.organization_id
  AND cs.branch_id=r.branch_id AND cs.source_module='pos' AND cs.source_id=e.order_id
 LEFT JOIN public.financial_states fs ON fs.organization_id=r.organization_id
  AND fs.branch_id=r.branch_id AND fs.source_module='pos' AND fs.source_id=e.order_id
 LEFT JOIN LATERAL(SELECT coalesce(sum(l.debit),0) AS debits,coalesce(sum(l.credit),0) AS credits,
   bool_and(l.organization_id=r.organization_id AND l.branch_id IS NOT DISTINCT FROM r.branch_id) AS scoped
   FROM public.journal_entry_lines l WHERE l.journal_id=e.journal_id)totals ON true
), checks AS (
 SELECT (SELECT bool_and(matches) FROM code) AS code_matches,
  (SELECT bool_and(unchanged) FROM retained) AS other_functions_unchanged,
  (SELECT count(*)=3 AND bool_and(verified) FROM links) AS three_links_verified,
  public.neo_gl_revenue_code_scoped('aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid,'event-catering',NULL)='4050' AS event_category_mapped,
  EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.journal_entries'::regclass
    AND t.tgname='neo_pos_folio_journal_receipts_trg' AND NOT t.tgisinternal AND t.tgenabled IN ('O','A')) AS late_journal_trigger_enabled,
  NOT has_function_privilege('authenticated','public.neo_pos_room_charge_evidence(uuid,uuid,uuid,uuid,uuid)','EXECUTE')
   AND NOT has_function_privilege('anon','public.neo_pos_room_charge_evidence(uuid,uuid,uuid,uuid,uuid)','EXECUTE')
   AND NOT has_function_privilege('authenticated','public.neo_pos_folio_journal_receipts()','EXECUTE')
   AND NOT has_function_privilege('anon','public.neo_pos_folio_journal_receipts()','EXECUTE') AS helpers_private
)
SELECT jsonb_build_object('diagnostic_version','pos-room-charge-repair-postcheck-v1',
 'read_only',current_setting('transaction_read_only'),
 'repair_verified',(SELECT code_matches AND other_functions_unchanged AND three_links_verified
   AND event_category_mapped AND late_journal_trigger_enabled AND helpers_private FROM checks),
 'checks',(SELECT to_jsonb(c) FROM checks c),
 'links',(SELECT jsonb_agg(to_jsonb(l) ORDER BY receipt_id) FROM links l),
 'code',(SELECT jsonb_agg(to_jsonb(c) ORDER BY signature) FROM code c),
 'retained',(SELECT jsonb_agg(to_jsonb(r) ORDER BY signature) FROM retained r),
 'catering_historical_status',(SELECT r.status FROM public.finance_posting_receipts r
   WHERE r.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND r.branch_id='2addbd01-c643-406a-bd7d-fac1aa76b23c'::uuid
   AND r.source_id='c1d9c37b-a862-44af-983b-443701434dc9'::uuid ORDER BY r.updated_at DESC LIMIT 1),
 'scope','Code and three existing metadata links only. Failed catering posting is not automatically retried; live sale/shift/stay and all original workflows remain separate gates.') AS diagnostic;
COMMIT;
