-- READ ONLY. One exportable result; does not submit/approve claims or read money rows.
BEGIN READ ONLY;
WITH expected_new(signature,definition_md5,client_execute) AS (VALUES
('public.neo_delivery_mpesa_claim_evidence(uuid)','81ea1bfadb06162bcea69fb626ad5682',false),
('public.neo_delivery_mpesa_till_claim_approve(uuid,numeric,text,text,uuid)','8ab45fad9bd330c1e5d0ab4fbe240d57',true),
('public.neo_delivery_mpesa_till_claim_queue()','3a8417986af2ac43a1b55d89ae3a09ed',true),
('public.neo_delivery_mpesa_till_claim_submit(uuid,text)','9a655a7a59d2d864a5ce7ab629ec6090',true)
), expected_existing(signature,definition_md5) AS (VALUES
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
), function_proof AS (
 SELECT e.signature,e.definition_md5 AS expected_md5,md5(pg_get_functiondef(p.oid)) AS actual_md5,
  coalesce(md5(pg_get_functiondef(p.oid))=e.definition_md5,false) AS definition_matches,
  coalesce(p.prosecdef,false) AS security_definer,
  coalesce(p.proconfig @> ARRAY['search_path=public']::text[],false) AS fixed_search_path,
  coalesce(has_function_privilege('anon',p.oid,'EXECUTE'),true) AS anon_execute,
  coalesce(has_function_privilege('authenticated',p.oid,'EXECUTE'),false) AS authenticated_execute,
  e.client_execute AS expected_authenticated_execute
 FROM expected_new e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.signature)
), prerequisite_proof AS (
 SELECT e.signature,coalesce(md5(pg_get_functiondef(to_regprocedure(e.signature)))=e.definition_md5,false) AS unchanged
 FROM expected_existing e
), checks AS (
 SELECT
  (SELECT bool_and(definition_matches AND security_definer AND fixed_search_path AND NOT anon_execute
   AND authenticated_execute=expected_authenticated_execute) FROM function_proof) AS function_contracts_ok,
  (SELECT bool_and(unchanged) FROM prerequisite_proof) AS existing_functions_unchanged,
  coalesce((SELECT c.relrowsecurity AND NOT has_table_privilege('anon',c.oid,'SELECT')
    AND NOT has_table_privilege('authenticated',c.oid,'SELECT')
    AND NOT has_table_privilege('authenticated',c.oid,'INSERT')
    AND NOT has_table_privilege('authenticated',c.oid,'UPDATE')
    AND NOT has_table_privilege('authenticated',c.oid,'DELETE')
    FROM pg_class c WHERE c.oid=to_regclass('public.delivery_mpesa_till_claims')),false) AS table_access_ok,
  EXISTS(SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('public.delivery_mpesa_till_claim_payment_uq')
    AND i.indisunique AND i.indisvalid) AS payment_uniqueness_index_ok,
  (SELECT count(*)=2 FROM pg_constraint c WHERE c.conrelid=to_regclass('public.delivery_mpesa_till_claims')
    AND c.conname IN ('delivery_mpesa_till_receipt_uq','delivery_mpesa_till_verified_evidence')
    AND c.convalidated) AS required_constraints_ok
)
SELECT jsonb_build_object('diagnostic_version','delivery-mpesa-install-postcheck-v1',
 'read_only',current_setting('transaction_read_only'),
 'installation_verified',(SELECT function_contracts_ok AND existing_functions_unchanged AND table_access_ok
   AND payment_uniqueness_index_ok AND required_constraints_ok FROM checks),
 'checks',(SELECT to_jsonb(c) FROM checks c),
 'new_functions',(SELECT jsonb_agg(to_jsonb(f) ORDER BY signature) FROM function_proof f),
 'prerequisites',(SELECT jsonb_agg(to_jsonb(p) ORDER BY signature) FROM prerequisite_proof p),
 'scope','SQL installation evidence only; live claim/merchant/payment workflow and separate STK still require evidence') AS diagnostic;
COMMIT;
