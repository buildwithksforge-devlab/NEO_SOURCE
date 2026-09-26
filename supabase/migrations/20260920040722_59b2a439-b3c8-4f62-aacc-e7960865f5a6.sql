REVOKE ALL ON FUNCTION public.neo_guard_maker_checker_journal() FROM PUBLIC, anon, authenticated;

INSERT INTO public.privileged_function_review (function_name, classification, reachability, trusts_client_tenant, review_note)
SELECT 'neo_guard_maker_checker_journal', 'privileged_trigger', 'internal_only', false,
       'Trigger-only maker/checker guard for journal_entries; exempts module-generated automatic and reversal journals. Direct execution revoked.'
WHERE NOT EXISTS (SELECT 1 FROM public.privileged_function_review WHERE function_name='neo_guard_maker_checker_journal');

INSERT INTO public.privileged_function_review (function_name, classification, reachability, trusts_client_tenant, review_note)
SELECT 'neo_grn_retry_accrual', 'tenant_validated_privileged', 'app_callable', false,
       'Retries a failed goods-receipt accrual; derives tenant from current_org_id(), checks branch scope and finance posting permission.'
WHERE NOT EXISTS (SELECT 1 FROM public.privileged_function_review WHERE function_name='neo_grn_retry_accrual');