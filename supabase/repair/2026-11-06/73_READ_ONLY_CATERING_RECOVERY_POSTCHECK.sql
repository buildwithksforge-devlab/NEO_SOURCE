-- Run after Retry on POS-20261102-XP3WR only. No financial writes.
BEGIN READ ONLY;
WITH target AS (
 SELECT * FROM public.pos_orders
 WHERE id='c1d9c37b-a862-44af-983b-443701434dc9'::uuid
 AND organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid
 AND branch_id='2addbd01-c643-406a-bd7d-fac1aa76b23c'::uuid
), journals AS (
 SELECT j.* FROM public.journal_entries j JOIN target o ON j.organization_id=o.organization_id
 WHERE j.source_document_id=o.id
), lines AS (
 SELECT l.*,a.code FROM public.journal_entry_lines l JOIN journals j ON j.id=l.journal_id
 LEFT JOIN public.chart_of_accounts a ON a.id=l.account_id AND a.organization_id=l.organization_id
), receipts AS (
 SELECT r.* FROM public.finance_posting_receipts r JOIN target o
 ON r.source_id=o.id AND r.organization_id=o.organization_id
), checks AS (
 SELECT
 (SELECT count(*)=1 AND bool_and(status='posted' AND reversed_by_journal_id IS NULL
 AND reverses_journal_id IS NULL AND source_document_type='pos_order:revenue'
 AND branch_id='2addbd01-c643-406a-bd7d-fac1aa76b23c'::uuid AND currency='KES'
 AND total_debit=4635 AND total_credit=4635) FROM journals) AS one_posted_journal,
 (SELECT count(*)=4 AND sum(debit)=4635 AND sum(credit)=4635
 AND bool_and(organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid
 AND branch_id='2addbd01-c643-406a-bd7d-fac1aa76b23c'::uuid)
 AND count(*) FILTER(WHERE code='1000' AND debit=4635 AND credit=0)=1
 AND count(*) FILTER(WHERE code='4050' AND credit=3879.31 AND debit=0)=1
 AND count(*) FILTER(WHERE code='2040' AND credit=620.69 AND debit=0)=1
 AND count(*) FILTER(WHERE code='2050' AND credit=135 AND debit=0)=1 FROM lines) AS expected_entries,
 (SELECT count(*)=1 AND bool_and(p.id='db940af1-a397-495a-8959-381833e6e0d5'::uuid
 AND p.status='confirmed' AND p.method='cash' AND p.amount=4635
 AND p.organization_id=o.organization_id AND p.branch_id=o.branch_id
 AND to_jsonb(p)->>'currency'='KES' AND p.destination_account_id IS NULL)
 FROM public.pos_payments p JOIN target o ON p.order_id=o.id) AS original_payment_only,
 (SELECT count(*)=1 AND bool_and(r.status='posted' AND r.last_error IS NULL AND r.amount=4635
 AND r.journal_id IN (SELECT id FROM journals) AND r.branch_id='2addbd01-c643-406a-bd7d-fac1aa76b23c'::uuid)
 FROM receipts r) AS receipt_posted,
 (SELECT count(*)=1 AND bool_and(s.financial_state='posted' AND s.journal_id IN (SELECT id FROM journals))
 FROM public.canonical_transaction_states s JOIN target o
 ON s.organization_id=o.organization_id AND s.source_id=o.id AND s.source_module='pos') AS canonical_posted,
 (SELECT count(*)=1 AND bool_and(status='paid' AND payment_status='paid'
 AND grand_total=4635 AND paid_total=4635 AND folio_id IS NULL AND closed_at IS NULL) FROM target) AS order_preserved
)
SELECT jsonb_build_object('diagnostic_version','catering-recovery-postcheck-v1',
 'read_only',current_setting('transaction_read_only'),
 'recovery_verified',(SELECT coalesce(one_posted_journal AND expected_entries AND original_payment_only
 AND receipt_posted AND canonical_posted AND order_preserved,false) FROM checks),
 'checks',(SELECT to_jsonb(c) FROM checks c),
 'journals',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'number',journal_number,
 'status',status,'accounting_date',accounting_date,'debit',total_debit,'credit',total_credit)) FROM journals),'[]'::jsonb),
 'entries',coalesce((SELECT jsonb_agg(jsonb_build_object('code',code,'debit',debit,'credit',credit)) FROM lines),'[]'::jsonb),
 'receipt',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'status',status,'journal_id',journal_id,
 'attempts',attempts,'last_error',last_error)) FROM receipts),'[]'::jsonb),
 'scope','One historical catering journal; service completion and full department certification remain separate.'
) AS diagnostic;
COMMIT;
