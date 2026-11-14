-- Read-only installation check. Does not reconcile/close any existing bill.
BEGIN READ ONLY;
WITH retained(signature,hash) AS (VALUES ('public.neo_branch_in_scope(uuid)','073af6634a1614993b8a1c0061643270'),
('public.neo_cash_request_payment(uuid,numeric,text,text,text)','33a7c2397ac3e245cb9d883f0990ebda'),
('public.neo_cash_request_pos_payment(uuid,numeric,text,text,text)','ca4a6bcb4641691751f5de1c70761206'),
('public.neo_cash_settle_request(uuid)','8536b8f2fb47d499c37bb423cc5373b2'),
('public.neo_cash_till_context(uuid)','0056bf3ebc240af86eec6901d53680c2'),
('public.pos_reconcile_order_settlement(uuid)','39307e5eca40679a396faa1eff3efd33'),
('public.pos_record_payment_attempt(uuid,numeric,text,numeric,text,uuid,text,boolean,text,uuid)','e3a09ce80f0bf557e4bfd9520c93b21c'),
('public.pos_record_payment_attempt(uuid,numeric,text,numeric,text,uuid,text,boolean,text,uuid,jsonb)','fe6d4802c4b7b16e939c53de4091ebf7')), proof AS (
 SELECT signature,md5(pg_get_functiondef(to_regprocedure(signature)))=hash AS unchanged FROM retained
)
SELECT jsonb_build_object('diagnostic_version','prepaid-service-closure-install-v1',
 'read_only',current_setting('transaction_read_only'),
 'engine_definition_matches',md5(pg_get_functiondef('public.pos_reconcile_settlement_internal(uuid)'::regprocedure))='872e20df354399ff6d9984bdee4246d9',
 'neighbors_unchanged',(SELECT bool_and(unchanged) FROM proof),
 'retained',(SELECT jsonb_agg(to_jsonb(p)) FROM proof p),
 'scope','Code installation only. No order was closed, payment recorded or historical till changed by this check. Full service-to-close regression remains separate.'
) AS diagnostic;
COMMIT;