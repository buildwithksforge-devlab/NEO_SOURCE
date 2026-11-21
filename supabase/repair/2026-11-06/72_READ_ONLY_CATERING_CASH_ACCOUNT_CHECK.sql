-- Final account/date evidence for the already-paid catering order. No posting.
BEGIN READ ONLY;
WITH scope AS (
 SELECT 'aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AS org
), resolved AS (
 SELECT org,public.neo_gl_account_code(org,'cash',NULL::uuid) AS code FROM scope
)
SELECT jsonb_build_object(
 'diagnostic_version','catering-cash-account-v1',
 'read_only',current_setting('transaction_read_only'),
 'resolved_cash_account',(SELECT jsonb_build_object('resolved_code',r.code,'id',a.id,
 'name',a.name,'category',a.category,'active',a.active,'postable',a.postable,'header',a.is_header)
 FROM resolved r LEFT JOIN public.chart_of_accounts a ON a.organization_id=r.org AND a.code=r.code),
 'cash_candidates',coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'code',a.code,
 'name',a.name,'category',a.category,'active',a.active,'postable',a.postable,'header',a.is_header))
 FROM public.chart_of_accounts a JOIN scope s ON a.organization_id=s.org
 WHERE a.name ILIKE '%cash%'),'[]'::jsonb),
 'periods_for_original_date',coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.id,
 'name',p.name,'starts_on',p.starts_on,'ends_on',p.ends_on,'status',p.status))
 FROM public.accounting_periods p JOIN scope s ON p.organization_id=s.org
 WHERE DATE '2026-11-02' BETWEEN p.starts_on AND p.ends_on),'[]'::jsonb),
 'base_mapping_definition',(SELECT pg_get_functiondef(to_regprocedure('public.neo_gl_settlement_code_base(text)'))),
 'scope','Cash-account and accounting-period evidence only; no payment, journal, period or service-state change.'
) AS diagnostic;
COMMIT;
