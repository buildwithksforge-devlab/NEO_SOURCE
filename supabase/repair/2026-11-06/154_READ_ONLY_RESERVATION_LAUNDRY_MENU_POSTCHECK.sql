BEGIN READ ONLY;
WITH expected(signature,hash) AS (VALUES
('public.neo_cash_request_payment(uuid,numeric,text,text,text)','025359bfb6c3d6d6ad7464bfcd235df2'),
('public.neo_cash_settle_request(uuid)','d4805592caf414dac4ff438d4da11038'),
('public.neo_pms_collection_headroom(uuid,uuid,uuid)','9fb30a000786d48620c7ce5308d9d7ae'),
('public.neo_pms_collection_lock(uuid)','f7aaca8d7c4d4e2ab13f254784b668d1'),
('public.neo_reservation_collection_facts(uuid,uuid,uuid)','a13333be00fef8e23a31d7cfef2a2d46'),
('public.neo_reservation_collection_position(uuid)','0be2e52d818a5aa61516de603329ecb4'),
('public.neo_reservation_collection_source_refresh()','e0fd6fc005deb3a46e96ca32256e8dcc'),
('public.neo_reservation_deposit_record(uuid,numeric,text,text,text,text)','121422758038ec7edda8bc6f0c9bfbcf'),
('public.neo_reservation_financial_state_sync(uuid)','106d6863e37f1ac73425b99d364ee7a5'),
('public.pms_confirm_payment(uuid,text,text)','987e80e45018a7bb3fc26383f24d46bb'),
('public.pms_record_payment(uuid,numeric,text,text,text,text,uuid)','7f167375d93e63fbd9489e96cbd933da'),
('public.tg_folio_sync_reservation_payment_status()','cba45520d3c2c6bb299155d0d484d11e'),
('public.laundry_rollup_order()','25789d1b48d4f016aabb6dedcee1f08a'),
('public.neo_laundry_intake_item_price_guard()','08fee2a92896cfd2a589c5a51ccbed54'),
('public.neo_laundry_intake_order_price_guard()','8fad6aa2d2c425e795ff011725d1e80f'),
('public.neo_laundry_order_create(uuid,uuid,jsonb,text,boolean,text)','2c3f6fba7f2db303e9d092e49b4641c6'),
('public.neo_pos_sellable_menu_guard()','737b581fc6e7c37249557d9fb24ffda1'),
('public.neo_menu_remove_item(uuid,text,text)','82dec18a18077f6e4c58c502488e7fd3')
), checked AS (SELECT signature,coalesce(md5(pg_get_functiondef(to_regprocedure(signature)))=hash,false) AS matches FROM expected)
SELECT jsonb_build_object('diagnostic_version','reservation-laundry-menu-install-v1','definitions_match',(SELECT bool_and(matches) FROM checked),'definition_checks',(SELECT jsonb_agg(to_jsonb(checked)) FROM checked),'sale_guard_enabled',EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.pos_order_items'::regclass AND tgname='neo_pos_sellable_menu_guard_trg' AND tgenabled IN ('O','A')),'intake_columns_present',(SELECT count(*)=3 FROM information_schema.columns WHERE table_schema='public' AND table_name='guest_laundry_orders' AND column_name IN ('intake_idempotency_key','intake_request_hash','intake_price_mode')),'checkin_unchanged',md5(pg_get_functiondef(to_regprocedure('public.pms_check_in(uuid,integer,text)')))='e1b9f2a87464b3389ac5a146bdd7b459','payment_register_unchanged',md5(pg_get_functiondef(to_regprocedure('public.neo_payment_register(uuid,date,date,text,integer)')))='e256478061449b9e1247073a8a46c444','laundry_item_amounts_unchanged',md5(pg_get_functiondef(to_regprocedure('public.laundry_item_amounts()')))='208d86bff6d774d7a40a32d3c8f28baf','scope','Installs guarded routines, triggers and nullable laundry intake fields only. No collection, check-in, stock movement, product removal or historical balance rewrite is executed by installation. Wider Finance, procurement, receiving, stores and cashier acceptance remain open.') AS result;
COMMIT;

