BEGIN READ ONLY;
WITH expected(signature,hash) AS (VALUES ('public.neo_print_agent_discovery_poll(text)','c5f0f6ef124a3ea3dde83ea9282896cc'),
('public.neo_print_agent_discovery_report(text,uuid,jsonb)','596769177ea4ea190453b9cee65e5f36'),
('public.neo_print_discovery_authorize(uuid)','848e29ba27b4ac608f292021182293ff'),
('public.neo_print_discovery_request(uuid,text)','c23619900245ac6a4e55fe4031f02715'),
('public.neo_print_discovery_status(uuid)','1043b2bc0c3102b358632d38e634dd3d'),
('public.neo_requisition_assign_stock_item(uuid,uuid,uuid)','ad435a6da566cdaa79a57303c590d8e5')), checked AS(SELECT signature,coalesce(md5(pg_get_functiondef(to_regprocedure(signature)))=hash,false) matches FROM expected) SELECT jsonb_build_object('diagnostic_version','stores-printer-connections-v1','definitions_match',(SELECT bool_and(matches) FROM checked),'definition_checks',(SELECT jsonb_agg(to_jsonb(checked)) FROM checked),'scope','Adds missing Stores allocation and property-printer discovery commands only. No stock issued, request approved, printer paired, device search run or print job queued by installation.') result;
COMMIT;
