-- Read-only schema and function evidence; this does not certify live laundry/GL results.
SELECT to_regprocedure('public.neo_laundry_order_create(uuid,uuid,jsonb,text,boolean,text)') AS intake;
SELECT column_name,data_type FROM information_schema.columns
WHERE table_schema='public' AND table_name='guest_laundry_orders'
AND column_name IN ('intake_idempotency_key','intake_request_hash','delivery_confirmed_by');
SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public'
AND indexname='guest_laundry_orders_intake_identity_idx';
SELECT p.proname,p.prosecdef,p.proconfig,
 has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
 has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute,
 md5(replace(p.prosrc,E'\r\n',E'\n')) AS source_md5
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname IN
('neo_laundry_order_create','neo_laundry_retry_posting','neo_laundry_autopost_after_delivery','neo_laundry_order_advance');
