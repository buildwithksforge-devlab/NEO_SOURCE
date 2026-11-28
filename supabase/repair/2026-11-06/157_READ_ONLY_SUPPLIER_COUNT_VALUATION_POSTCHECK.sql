BEGIN READ ONLY;
WITH expected(signature,hash) AS (VALUES
('public.inventory_apply_movement(uuid,uuid,numeric,text,text,numeric,text,uuid,text,text,text,date)','3fabb15793d1c35b9619a82d79d2e5dd'),
('public.inventory_post_adjustment(uuid)','830763c76601ffc47289ab895ca8dae8'),
('public.inventory_post_receipt(uuid)','22e93cebfc2501c493350657695a4c86'),
('public.inventory_post_stock_take(uuid)','c86a9f663f490881ab11e3387c14a58d'),
('public.inventory_post_transfer(uuid)','562d697013ab14b8dc5aae480befc8a7'),
('public.neo_cash_shift_reconciliation(uuid)','e82fa3e0db81e5313b7429aae7249dde'),
('public.neo_grn_retry_accrual(uuid)','c81b26b48def2a7612cf6d4b57b0b292'),
('public.neo_grn_reverse(uuid,text)','12c447b9bc5b449d2e5110f3da6d082c'),
('public.neo_payment_schedule_release(uuid,text,uuid,text,date)','5d969e289408a400ffb473decc114556'),
('public.neo_procurement_order_close(uuid,text)','2f76e857ff00a1ee16e5f28727165a5e'),
('public.neo_stores_issue(uuid,jsonb,uuid,uuid,text,text)','2afdbba3ad8cb4852d3fdd65ff946ff7'),
('public.neo_stores_receive_goods(uuid,uuid,jsonb,uuid,text,text,text,text)','8da681dbdabc43053a2ea7f65206d909'),
('public.neo_supplier_invoice_accept(uuid,text)','4fde341f5b26b996ef967e8dc585a5c4'),
('public.neo_supplier_invoice_capture(jsonb)','758c1b024238b1082ecd2cac3dce2a15'),
('public.neo_supplier_payment_advance(uuid,text,text)','9ca13315484923834e9ffe5ca52b222e'),
('public.proc_document_trail(uuid)','19477bf364e4dbf1e0710cf6b72739c2'),
('public.proc_lpo_action(uuid,text,text)','4d87d1704e16980d995ea923def5b598'),
('public.proc_three_way_match(uuid)','35e8a205f2ebdd4b711b12754b8ef9a6'),
('public.req_issue(uuid,jsonb)','1fa9f5c79950d897495719060de1d938')
),checked AS (SELECT signature,coalesce(md5(pg_get_functiondef(to_regprocedure(signature)))=hash,false) AS matches FROM expected)
SELECT jsonb_build_object('diagnostic_version','supplier-count-valuation-install-v1','definitions_match',(SELECT bool_and(matches) FROM checked),'definition_checks',(SELECT jsonb_agg(to_jsonb(checked)) FROM checked),'scope','Three guarded routine corrections only: supplier invoice posted-journal evidence, complete stock counts and converted issue/return valuation. No payment, invoice approval, count closure, stock movement or historical rewrite is executed by installation. Wider operational acceptance remains open.') AS result;
COMMIT;
