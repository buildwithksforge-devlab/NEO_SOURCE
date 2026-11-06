-- Read-only replacement for 46 when the SQL Editor exports only its final result.
-- One result row contains the whole catalogue diagnostic; no operational rows/credentials.
BEGIN READ ONLY;
WITH funcs AS (
 SELECT p.oid, n.oid AS schema_oid, p.oid::regprocedure::text AS signature,
        p.proname AS name, p.prosecdef AS security_definer,
        p.proconfig AS function_settings,
        pg_get_function_arguments(p.oid) AS arguments,
        pg_get_function_result(p.oid) AS returns,
        md5(pg_get_functiondef(p.oid)) AS definition_md5,
        pg_get_functiondef(p.oid) AS definition
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.prokind='f'
   AND p.proname IN ('neo_delivery_mpesa_till_claim_queue',
     'neo_delivery_mpesa_till_claim_submit','neo_delivery_mpesa_till_claim_approve',
     'current_org_id','is_org_admin_for','has_permission',
     'neo_branch_in_scope','customer_owns_delivery')
), grants AS (
 SELECT f.signature,r.rolname AS api_role,
        has_schema_privilege(r.oid,f.schema_oid,'USAGE') AS schema_usage,
        has_function_privilege(r.oid,f.oid,'EXECUTE') AS can_execute
 FROM funcs f CROSS JOIN pg_roles r
 WHERE f.name IN ('neo_delivery_mpesa_till_claim_queue',
   'neo_delivery_mpesa_till_claim_submit','neo_delivery_mpesa_till_claim_approve')
 AND r.rolname IN ('anon','authenticated','service_role')
), cols AS (
 SELECT table_name,ordinal_position,column_name,data_type,is_nullable
 FROM information_schema.columns WHERE table_schema='public'
 AND table_name IN ('delivery_mpesa_till_claims','delivery_orders')
), tables AS (
 SELECT c.relname AS table_name,c.relrowsecurity AS rls_enabled,
        c.relforcerowsecurity AS force_rls
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind IN ('r','p')
 AND c.relname IN ('delivery_mpesa_till_claims','delivery_orders')
), policies AS (
 SELECT tablename,policyname,roles,cmd,qual,with_check FROM pg_policies
 WHERE schemaname='public'
 AND tablename IN ('delivery_mpesa_till_claims','delivery_orders')
)
SELECT jsonb_build_object(
 'diagnostic_version','delivery-mpesa-single-result-v1',
 'database_name',current_database(),
 'read_only',current_setting('transaction_read_only'),
 'configured_api_schemas',current_setting('pgrst.db_schemas',true),
 'api_setting_note','NULL means unknown here; not proof of missing exposure',
 'queue_signature','public.neo_delivery_mpesa_till_claim_queue()',
 'queue_present',to_regprocedure('public.neo_delivery_mpesa_till_claim_queue()') IS NOT NULL,
 'functions',coalesce((SELECT jsonb_agg(to_jsonb(f)-'oid'-'schema_oid' ORDER BY f.signature) FROM funcs f),'[]'::jsonb),
 'api_grants',coalesce((SELECT jsonb_agg(to_jsonb(g) ORDER BY g.signature,g.api_role) FROM grants g),'[]'::jsonb),
 'columns',coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.table_name,c.ordinal_position) FROM cols c),'[]'::jsonb),
 'tables',coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.table_name) FROM tables t),'[]'::jsonb),
 'policies',coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.tablename,p.policyname) FROM policies p),'[]'::jsonb)
) AS diagnostic;
COMMIT;
-- Do not replay migrations, widen grants or approve a claim based only on a missing API result.
