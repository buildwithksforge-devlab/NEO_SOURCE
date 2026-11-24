BEGIN READ ONLY;
SET LOCAL search_path=public;
SELECT jsonb_build_object('diagnostic_version','pos-till-intent-scope-code-v1','read_only',current_setting('transaction_read_only'),
 'definition_matches',coalesce(md5(pg_get_functiondef(to_regprocedure('public.pos_record_payment_attempt(uuid,numeric,text,numeric,text,uuid,text,boolean,text,uuid)')))='54ca4b89c5dffe501d5bd3ccd3ac3dc1',false),
 'card_wrapper_unchanged',coalesce(md5(pg_get_functiondef(to_regprocedure('public.pos_record_payment_attempt(uuid,numeric,text,numeric,text,uuid,text,boolean,text,uuid,jsonb)')))='fe6d4802c4b7b16e939c53de4091ebf7',false),
 'scope','Code only. Historical till attribution, payment, order and journal rows are unchanged; actual payment/till/shift acceptance remains separate.') AS diagnostic;
COMMIT;
