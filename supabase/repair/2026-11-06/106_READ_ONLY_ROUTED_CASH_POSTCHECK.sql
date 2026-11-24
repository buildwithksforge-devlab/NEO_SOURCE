BEGIN READ ONLY;
SET LOCAL search_path=public;
WITH expected(signature,definition_md5) AS(VALUES ('neo_cash_till_context(uuid)','36b63a8dd5854b9e11417708478100e5'),
('neo_cash_request_payment(uuid,numeric,text,text,text)','518f3792da29a326e556beffc2656b56'),
('neo_cash_request_pos_payment(uuid,numeric,text,text,text)','fd97015abbb7c524905ec33fb5160ae8'),
('neo_cash_settle_request(uuid)','535ce6e7e209b7b9ffb3b998d344ff87')),code AS(
 SELECT signature,coalesce(md5(pg_get_functiondef(to_regprocedure('public.'||signature)))=definition_md5,false) AS matches FROM expected
)
SELECT jsonb_build_object('diagnostic_version','routed-cash-code-postcheck-v1','read_only',current_setting('transaction_read_only'),
 'definitions_match',(SELECT bool_and(matches) FROM code),'code',(SELECT jsonb_agg(to_jsonb(code)) FROM code),
 'scope','Four code definitions only. No historical till, cash request, payment, folio or journal row changed; actual full cash/accounting acceptance remains separate.') AS diagnostic;
COMMIT;
