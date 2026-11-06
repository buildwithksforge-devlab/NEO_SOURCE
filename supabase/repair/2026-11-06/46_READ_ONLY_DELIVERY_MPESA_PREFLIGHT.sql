-- NEØ existing-project delivery M-PESA catalogue check.
-- READ ONLY: does not approve a claim, send an STK prompt or change payments/grants.
-- Run in the SAME project's SQL Editor. Do not replay the historical migration.
BEGIN READ ONLY;

SELECT current_database() AS database_name,
       current_setting('transaction_read_only') AS read_only,
       current_setting('pgrst.db_schemas', true) AS configured_api_schemas,
       current_setting('pgrst.db_extra_search_path', true) AS configured_extra_search_path;
-- A NULL API setting here is unknown, not proof that the schema is unexposed.

SELECT expected.signature,
       to_regprocedure(expected.signature)::text AS installed_signature,
       CASE WHEN to_regprocedure(expected.signature) IS NULL THEN 'MISSING'
            ELSE 'PRESENT - inspect definition and grants below' END AS catalogue_status
FROM (VALUES ('public.neo_delivery_mpesa_till_claim_queue()')) AS expected(signature);

-- Include overloads: an existing function with different arguments is not this UI contract.
SELECT p.oid::regprocedure::text AS signature,
       pg_get_function_arguments(p.oid) AS arguments,
       pg_get_function_result(p.oid) AS returns,
       p.prosecdef AS security_definer,
       p.provolatile AS volatility,
       p.proconfig AS function_settings,
       md5(pg_get_functiondef(p.oid)) AS definition_md5,
       pg_get_functiondef(p.oid) AS definition
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.prokind='f'
  AND p.proname IN ('neo_delivery_mpesa_till_claim_queue',
    'neo_delivery_mpesa_till_claim_submit', 'neo_delivery_mpesa_till_claim_approve',
    'current_org_id', 'is_org_admin_for', 'has_permission',
    'neo_branch_in_scope', 'customer_owns_delivery')
ORDER BY p.proname, signature;

-- Effective API-role execute rights. This does not execute any application function.
SELECT p.oid::regprocedure::text AS signature, r.rolname AS api_role,
       has_schema_privilege(r.oid,n.oid,'USAGE') AS schema_usage,
       has_function_privilege(r.oid,p.oid,'EXECUTE') AS can_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
CROSS JOIN pg_roles r
WHERE n.nspname='public' AND p.prokind='f'
  AND p.proname IN ('neo_delivery_mpesa_till_claim_queue',
                    'neo_delivery_mpesa_till_claim_submit',
                    'neo_delivery_mpesa_till_claim_approve')
  AND r.rolname IN ('anon','authenticated','service_role')
ORDER BY signature, api_role;

SELECT table_name, ordinal_position, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema='public'
  AND table_name IN ('delivery_mpesa_till_claims','delivery_orders')
ORDER BY table_name, ordinal_position;

SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS force_rls
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind IN ('r','p')
  AND c.relname IN ('delivery_mpesa_till_claims','delivery_orders');

SELECT tablename,policyname,roles,cmd,qual,with_check
FROM pg_policies WHERE schemaname='public'
  AND tablename IN ('delivery_mpesa_till_claims','delivery_orders')
ORDER BY tablename,policyname;

COMMIT;
-- Missing: review prerequisites and prepare only the scoped repair.
-- Present: compare exact signature/grants/API exposure before considering a cache reload.
-- Do not disable permission checks, add broad grants or approve a claim as a diagnostic.
