BEGIN READ ONLY;
SET LOCAL search_path=public;
SELECT jsonb_build_object('diagnostic_version','pos-consumption-boundaries-code-v1','read_only',current_setting('transaction_read_only'),
 'definition_matches',coalesce(md5(pg_get_functiondef(to_regprocedure('public.inventory_consume_order_item_core(uuid)')))='0bd1ef265fdd364b1f942b4a1dc3b25b',false),
 'scope','Code only. Historical stock and posting rows are unchanged; physical inventory, complete service/payment/void flow and multi-session concurrency remain separate acceptance checks.') AS diagnostic;
COMMIT;
