-- Connected future checkout / financial projection repair. No business command is invoked.
BEGIN;
DO $guard$
DECLARE expected jsonb; actual text;
BEGIN
 FOR expected IN SELECT value FROM jsonb_array_elements($expected$[{"sig":"public.delivery_quote_cart(uuid)","old_hash":"289af03fe0106664cd783e58a4d87991","definition_hash":"3905336739a373e8eaa663eb768c5839","body_hash":"30e87a1eca4f87abf75b1bb9cd07121c","prosecdef":true,"provolatile":"s","proconfig":["search_path=public"],"return_type":"jsonb","language":"plpgsql"},{"sig":"public.delivery_place_order(uuid,text)","old_hash":"1dcc63d3505b1445500536ca7151fdef","definition_hash":"3435927b654fbca52f9b6a8fb1f4d081","body_hash":"29bd7c183ffd362619e3d3d1ac24f6ae","prosecdef":true,"provolatile":"v","proconfig":["search_path=public"],"return_type":"jsonb","language":"plpgsql"},{"sig":"public.neo_guest_place_room_service(uuid,text)","old_hash":"98bb6d2ae5f61d7c3cc7eb887fbf6865","definition_hash":"7101829377341647abbefe18a1aea28e","body_hash":"815132eab48e282a0406c7df24763477","prosecdef":true,"provolatile":"v","proconfig":["search_path=public"],"return_type":"jsonb","language":"plpgsql"},{"sig":"public.tg_pos_order_totals_authoritative()","old_hash":"d1ffd4dde67d3cea775de4933099135b","definition_hash":"c09c5a8cb492dc77b466a3d0f2af36e1","body_hash":"f8fad347217e30559e1586964aa59a65","prosecdef":true,"provolatile":"v","proconfig":["search_path=public"],"return_type":"trigger","language":"plpgsql"},{"sig":"public.neo_delivery_bill(uuid,text)","old_hash":"a69b953a703f6c8f3805652314a740a7","definition_hash":"88d4c672ac207430587876e8831d1072","body_hash":"ae3b8f1801f3cef3a411450bb475b950","prosecdef":true,"provolatile":"v","proconfig":["search_path=public"],"return_type":"jsonb","language":"plpgsql"},{"sig":"public.neo_finance_post_txn(text,uuid,boolean)","old_hash":"5f33d5ef8c7b352450d588e8d927d469","definition_hash":"1695af952c66b3014c9ef03af76020f1","body_hash":"98df457b013ff3e99550855871a0ca77","prosecdef":true,"provolatile":"v","proconfig":["search_path=public"],"return_type":"jsonb","language":"plpgsql"},{"sig":"public.neo_delivery_guest_mpesa_start(uuid,text)","old_hash":"f72c652f4217c8fdd2048b35aeadd1d3","definition_hash":"a66b19b04dc17f2a0ccc12676bf585d4","body_hash":"44bcfceadd5311e16905d4eef9e0d1d6","prosecdef":true,"provolatile":"v","proconfig":["search_path=public"],"return_type":"jsonb","language":"plpgsql"},{"sig":"public.neo_folio_projection(uuid)","old_hash":"280a3fb1d852c286ea99119e759c7ff7","definition_hash":"eab39d38f1604f49c66b36358a63d573","body_hash":"51d5e7cec5075728b174767084d06816","prosecdef":true,"provolatile":"s","proconfig":["search_path=public"],"return_type":"jsonb","language":"plpgsql"},{"sig":"public.neo_guest_folio_projection(uuid)","old_hash":"e675a623d765717117a09935da2efe6d","definition_hash":"94f20c521619d8a61f03c52746298817","body_hash":"b413e1c77eaaa2aaf4534ebeb5ffe594","prosecdef":true,"provolatile":"s","proconfig":["search_path=public"],"return_type":"jsonb","language":"plpgsql"},{"sig":"public.neo_finance_eligible_sources(uuid,date,date)","old_hash":"2ea160e6c3f31f6237ad8609b650400b","definition_hash":"71bf702311e4aa07aaf76cd78bc8c4b3","body_hash":"1ca2a5361d7df66638b4ea83d5fcd094","prosecdef":true,"provolatile":"s","proconfig":["search_path=public"],"return_type":"record","language":"sql"},{"sig":"public.neo_revenue_reconciliation(uuid,date,date)","old_hash":"fe898ebc5a5912d852b3228c140cf27c","definition_hash":"de81c7c64b5a359b6925040ce1f47bd1","body_hash":"0b5134694ef1eb68f9be655f25a6c172","prosecdef":true,"provolatile":"s","proconfig":["search_path=public"],"return_type":"record","language":"plpgsql"},{"sig":"public.neo_finance_posting_queue(uuid,date,date)","old_hash":"06e9f84092e8c40e6dcc1e159b503d08","definition_hash":"7f84a8c5beb8f78ea9c50f11de70cffa","body_hash":"8a1314ecce54709a77acf09439dccf44","prosecdef":true,"provolatile":"s","proconfig":["search_path=public"],"return_type":"record","language":"plpgsql"}]$expected$::jsonb) LOOP
  IF to_regprocedure(expected->>'sig') IS NULL THEN RAISE EXCEPTION 'Required financial routine is absent: %',expected->>'sig'; END IF;
  SELECT md5(pg_get_functiondef(p.oid)) INTO actual FROM pg_proc p WHERE p.oid=to_regprocedure(expected->>'sig');
  IF actual<>expected->>'old_hash' AND NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(expected->>'sig') AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g'))=expected->>'body_hash') THEN
   RAISE EXCEPTION 'Installed financial routine differs from reviewed code: %. Nothing replaced.',expected->>'sig';
  END IF;
 END LOOP;
 FOR expected IN SELECT value FROM jsonb_array_elements($helpers$[{"sig":"public.neo_guest_lock_cart_pricing(uuid)","definition_hash":"64063f40715383dfdb7b0fdced45bab0","body_hash":"a970f3de7b37de811290e3c3746aed40","prosecdef":false,"provolatile":"v","proconfig":["search_path=public, pg_temp"],"return_type":"void","language":"plpgsql"},{"sig":"public.neo_guest_cart_line_write_guard()","definition_hash":"c36b0e69dde69bb2d60214391f717083","body_hash":"90b7119f38f75498ea41a272210dfa81","prosecdef":true,"provolatile":"v","proconfig":["search_path=public, pg_temp"],"return_type":"trigger","language":"plpgsql"},{"sig":"public.neo_guest_order_cart_binding_guard()","definition_hash":"9e44d4405e0bec310f66f2dedab35627","body_hash":"d5a684b3fed0b52a60aa0145a991c4eb","prosecdef":false,"provolatile":"v","proconfig":["search_path=public, pg_temp"],"return_type":"trigger","language":"plpgsql"},{"sig":"public.neo_tip_payable_account(uuid)","definition_hash":"e4dcd008e35978cc049ff60cdd891c0f","body_hash":"7470a2aca7ba4d59ed3941df2690914b","prosecdef":false,"provolatile":"v","proconfig":["search_path=public, pg_temp"],"return_type":"uuid","language":"plpgsql"},{"sig":"public.neo_folio_financial_components(uuid,uuid)","definition_hash":"ef2bedf4ed86215f35e2d6ef949b09bd","body_hash":"29454d5b5922ca223fc47a4062a787a9","prosecdef":false,"provolatile":"s","proconfig":["search_path=public, pg_temp"],"return_type":"jsonb","language":"plpgsql"}]$helpers$::jsonb) LOOP
  IF to_regprocedure(expected->>'sig') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(expected->>'sig') AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g'))=expected->>'body_hash') THEN
   RAISE EXCEPTION 'Internal helper name is already used by different code: %',expected->>'sig';
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid IN (SELECT to_regprocedure(value->>'sig') FROM jsonb_array_elements($owners$[{"sig":"public.delivery_quote_cart(uuid)","old_hash":"289af03fe0106664cd783e58a4d87991","definition_hash":"3905336739a373e8eaa663eb768c5839","body_hash":"30e87a1eca4f87abf75b1bb9cd07121c","prosecdef":true,"provolatile":"s","proconfig":["search_path=public"],"return_type":"jsonb","language":"plpgsql"},{"sig":"public.delivery_place_order(uuid,text)","old_hash":"1dcc63d3505b1445500536ca7151fdef","definition_hash":"3435927b654fbca52f9b6a8fb1f4d081","body_hash":"29bd7c183ffd362619e3d3d1ac24f6ae","prosecdef":true,"provolatile":"v","proconfig":["search_path=public"],"return_type":"jsonb","language":"plpgsql"},{"sig":"public.neo_guest_place_room_service(uuid,text)","old_hash":"98bb6d2ae5f61d7c3cc7eb887fbf6865","definition_hash":"7101829377341647abbefe18a1aea28e","body_hash":"815132eab48e282a0406c7df24763477","prosecdef":true,"provolatile":"v","proconfig":["search_path=public"],"return_type":"jsonb","language":"plpgsql"},{"sig":"public.tg_pos_order_totals_authoritative()","old_hash":"d1ffd4dde67d3cea775de4933099135b","definition_hash":"c09c5a8cb492dc77b466a3d0f2af36e1","body_hash":"f8fad347217e30559e1586964aa59a65","prosecdef":true,"provolatile":"v","proconfig":["search_path=public"],"return_type":"trigger","language":"plpgsql"},{"sig":"public.neo_delivery_bill(uuid,text)","old_hash":"a69b953a703f6c8f3805652314a740a7","definition_hash":"88d4c672ac207430587876e8831d1072","body_hash":"ae3b8f1801f3cef3a411450bb475b950","prosecdef":true,"provolatile":"v","proconfig":["search_path=public"],"return_type":"jsonb","language":"plpgsql"},{"sig":"public.neo_finance_post_txn(text,uuid,boolean)","old_hash":"5f33d5ef8c7b352450d588e8d927d469","definition_hash":"1695af952c66b3014c9ef03af76020f1","body_hash":"98df457b013ff3e99550855871a0ca77","prosecdef":true,"provolatile":"v","proconfig":["search_path=public"],"return_type":"jsonb","language":"plpgsql"},{"sig":"public.neo_delivery_guest_mpesa_start(uuid,text)","old_hash":"f72c652f4217c8fdd2048b35aeadd1d3","definition_hash":"a66b19b04dc17f2a0ccc12676bf585d4","body_hash":"44bcfceadd5311e16905d4eef9e0d1d6","prosecdef":true,"provolatile":"v","proconfig":["search_path=public"],"return_type":"jsonb","language":"plpgsql"},{"sig":"public.neo_folio_projection(uuid)","old_hash":"280a3fb1d852c286ea99119e759c7ff7","definition_hash":"eab39d38f1604f49c66b36358a63d573","body_hash":"51d5e7cec5075728b174767084d06816","prosecdef":true,"provolatile":"s","proconfig":["search_path=public"],"return_type":"jsonb","language":"plpgsql"},{"sig":"public.neo_guest_folio_projection(uuid)","old_hash":"e675a623d765717117a09935da2efe6d","definition_hash":"94f20c521619d8a61f03c52746298817","body_hash":"b413e1c77eaaa2aaf4534ebeb5ffe594","prosecdef":true,"provolatile":"s","proconfig":["search_path=public"],"return_type":"jsonb","language":"plpgsql"},{"sig":"public.neo_finance_eligible_sources(uuid,date,date)","old_hash":"2ea160e6c3f31f6237ad8609b650400b","definition_hash":"71bf702311e4aa07aaf76cd78bc8c4b3","body_hash":"1ca2a5361d7df66638b4ea83d5fcd094","prosecdef":true,"provolatile":"s","proconfig":["search_path=public"],"return_type":"record","language":"sql"},{"sig":"public.neo_revenue_reconciliation(uuid,date,date)","old_hash":"fe898ebc5a5912d852b3228c140cf27c","definition_hash":"de81c7c64b5a359b6925040ce1f47bd1","body_hash":"0b5134694ef1eb68f9be655f25a6c172","prosecdef":true,"provolatile":"s","proconfig":["search_path=public"],"return_type":"record","language":"plpgsql"},{"sig":"public.neo_finance_posting_queue(uuid,date,date)","old_hash":"06e9f84092e8c40e6dcc1e159b503d08","definition_hash":"7f84a8c5beb8f78ea9c50f11de70cffa","body_hash":"8a1314ecce54709a77acf09439dccf44","prosecdef":true,"provolatile":"s","proconfig":["search_path=public"],"return_type":"record","language":"plpgsql"}]$owners$::jsonb)) AND r.rolname IN ('anon','authenticated')) THEN
  RAISE EXCEPTION 'A financial command has an untrusted database owner; inspect before installing.';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='pos_order_items' AND column_name='selection_modifiers' AND data_type='jsonb')
   OR to_regprocedure('public.neo_pos_selection_modifiers()') IS NULL THEN
  RAISE EXCEPTION 'The installed atomic item-selection dependency is missing';
 END IF;
 IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.pos_order_items'::regclass AND tgenabled IN ('O','A')
    AND tgfoid='public.neo_pos_selection_modifiers()'::regprocedure AND
      ((tgname='neo_pos_selection_validate_trg' AND tgtype=23) OR (tgname='neo_pos_selection_persist_trg' AND tgtype=5)))<>2 THEN
  RAISE EXCEPTION 'Both enabled atomic item-selection triggers are required';
 END IF;
 IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='delivery_orders' AND column_name='source_cart_id')
   AND NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.delivery_quote_cart(uuid)'::regprocedure AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g'))='30e87a1eca4f87abf75b1bb9cd07121c') THEN
  RAISE EXCEPTION 'The checkout link column already exists without this verified repair; inspect its use first.';
 END IF;
END $guard$;
CREATE TEMP TABLE neo_finance_existing_acl ON COMMIT DROP AS
 SELECT value->>'sig' signature,p.proowner,coalesce(p.proacl::text,'') acl FROM jsonb_array_elements($acl$[{"sig":"public.delivery_quote_cart(uuid)","old_hash":"289af03fe0106664cd783e58a4d87991","definition_hash":"3905336739a373e8eaa663eb768c5839","body_hash":"30e87a1eca4f87abf75b1bb9cd07121c","prosecdef":true,"provolatile":"s","proconfig":["search_path=public"],"return_type":"jsonb","language":"plpgsql"},{"sig":"public.delivery_place_order(uuid,text)","old_hash":"1dcc63d3505b1445500536ca7151fdef","definition_hash":"3435927b654fbca52f9b6a8fb1f4d081","body_hash":"29bd7c183ffd362619e3d3d1ac24f6ae","prosecdef":true,"provolatile":"v","proconfig":["search_path=public"],"return_type":"jsonb","language":"plpgsql"},{"sig":"public.neo_guest_place_room_service(uuid,text)","old_hash":"98bb6d2ae5f61d7c3cc7eb887fbf6865","definition_hash":"7101829377341647abbefe18a1aea28e","body_hash":"815132eab48e282a0406c7df24763477","prosecdef":true,"provolatile":"v","proconfig":["search_path=public"],"return_type":"jsonb","language":"plpgsql"},{"sig":"public.tg_pos_order_totals_authoritative()","old_hash":"d1ffd4dde67d3cea775de4933099135b","definition_hash":"c09c5a8cb492dc77b466a3d0f2af36e1","body_hash":"f8fad347217e30559e1586964aa59a65","prosecdef":true,"provolatile":"v","proconfig":["search_path=public"],"return_type":"trigger","language":"plpgsql"},{"sig":"public.neo_delivery_bill(uuid,text)","old_hash":"a69b953a703f6c8f3805652314a740a7","definition_hash":"88d4c672ac207430587876e8831d1072","body_hash":"ae3b8f1801f3cef3a411450bb475b950","prosecdef":true,"provolatile":"v","proconfig":["search_path=public"],"return_type":"jsonb","language":"plpgsql"},{"sig":"public.neo_finance_post_txn(text,uuid,boolean)","old_hash":"5f33d5ef8c7b352450d588e8d927d469","definition_hash":"1695af952c66b3014c9ef03af76020f1","body_hash":"98df457b013ff3e99550855871a0ca77","prosecdef":true,"provolatile":"v","proconfig":["search_path=public"],"return_type":"jsonb","language":"plpgsql"},{"sig":"public.neo_delivery_guest_mpesa_start(uuid,text)","old_hash":"f72c652f4217c8fdd2048b35aeadd1d3","definition_hash":"a66b19b04dc17f2a0ccc12676bf585d4","body_hash":"44bcfceadd5311e16905d4eef9e0d1d6","prosecdef":true,"provolatile":"v","proconfig":["search_path=public"],"return_type":"jsonb","language":"plpgsql"},{"sig":"public.neo_folio_projection(uuid)","old_hash":"280a3fb1d852c286ea99119e759c7ff7","definition_hash":"eab39d38f1604f49c66b36358a63d573","body_hash":"51d5e7cec5075728b174767084d06816","prosecdef":true,"provolatile":"s","proconfig":["search_path=public"],"return_type":"jsonb","language":"plpgsql"},{"sig":"public.neo_guest_folio_projection(uuid)","old_hash":"e675a623d765717117a09935da2efe6d","definition_hash":"94f20c521619d8a61f03c52746298817","body_hash":"b413e1c77eaaa2aaf4534ebeb5ffe594","prosecdef":true,"provolatile":"s","proconfig":["search_path=public"],"return_type":"jsonb","language":"plpgsql"},{"sig":"public.neo_finance_eligible_sources(uuid,date,date)","old_hash":"2ea160e6c3f31f6237ad8609b650400b","definition_hash":"71bf702311e4aa07aaf76cd78bc8c4b3","body_hash":"1ca2a5361d7df66638b4ea83d5fcd094","prosecdef":true,"provolatile":"s","proconfig":["search_path=public"],"return_type":"record","language":"sql"},{"sig":"public.neo_revenue_reconciliation(uuid,date,date)","old_hash":"fe898ebc5a5912d852b3228c140cf27c","definition_hash":"de81c7c64b5a359b6925040ce1f47bd1","body_hash":"0b5134694ef1eb68f9be655f25a6c172","prosecdef":true,"provolatile":"s","proconfig":["search_path=public"],"return_type":"record","language":"plpgsql"},{"sig":"public.neo_finance_posting_queue(uuid,date,date)","old_hash":"06e9f84092e8c40e6dcc1e159b503d08","definition_hash":"7f84a8c5beb8f78ea9c50f11de70cffa","body_hash":"8a1314ecce54709a77acf09439dccf44","prosecdef":true,"provolatile":"s","proconfig":["search_path=public"],"return_type":"record","language":"plpgsql"}]$acl$::jsonb) e(value)
 JOIN pg_proc p ON p.oid=to_regprocedure(value->>'sig');
ALTER TABLE public.delivery_orders ADD COLUMN IF NOT EXISTS source_cart_id uuid;
DO $schema$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='delivery_orders' AND column_name='source_cart_id' AND data_type='uuid' AND is_nullable='YES') THEN RAISE EXCEPTION 'Checkout cart link has an unexpected type or nullability'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.delivery_orders'::regclass AND conname='delivery_orders_source_cart_id_fkey') THEN
  ALTER TABLE public.delivery_orders ADD CONSTRAINT delivery_orders_source_cart_id_fkey FOREIGN KEY(source_cart_id) REFERENCES public.carts(id) ON DELETE RESTRICT;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attname='source_cart_id' JOIN pg_attribute target ON target.attrelid='public.carts'::regclass AND target.attname='id'
    WHERE c.conrelid='public.delivery_orders'::regclass AND c.conname='delivery_orders_source_cart_id_fkey' AND c.contype='f' AND c.confrelid='public.carts'::regclass AND c.conkey=ARRAY[a.attnum] AND c.confkey=ARRAY[target.attnum] AND c.confdeltype='r') THEN RAISE EXCEPTION 'Checkout cart foreign key differs from the required relationship'; END IF;
END $schema$;
CREATE UNIQUE INDEX IF NOT EXISTS neo_delivery_source_cart_once ON public.delivery_orders(source_cart_id) WHERE source_cart_id IS NOT NULL;
CREATE OR REPLACE FUNCTION public.neo_guest_lock_cart_pricing(_cart uuid)
RETURNS void LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE c public.carts;
BEGIN
 SELECT * INTO c FROM public.carts WHERE id=_cart FOR UPDATE;
 IF c.id IS NULL OR c.status IS DISTINCT FROM 'active' OR NOT EXISTS(SELECT 1 FROM public.customers owner
   WHERE owner.id=c.customer_id AND owner.organization_id=c.organization_id AND owner.auth_user_id=auth.uid() AND owner.merged_into_id IS NULL) THEN
  RAISE EXCEPTION 'Active cart not found';
 END IF;
 PERFORM 1 FROM public.cart_items WHERE cart_id=_cart FOR SHARE;
 PERFORM 1 FROM public.menu_items mi JOIN public.cart_items ci ON ci.menu_item_id=mi.id WHERE ci.cart_id=_cart FOR SHARE OF mi;
 PERFORM 1 FROM public.cart_item_modifiers cm JOIN public.cart_items ci ON ci.id=cm.cart_item_id WHERE ci.cart_id=_cart FOR SHARE OF cm;
 PERFORM 1 FROM public.modifier_options mo JOIN public.cart_item_modifiers cm ON cm.option_id=mo.id
   JOIN public.cart_items ci ON ci.id=cm.cart_item_id WHERE ci.cart_id=_cart FOR SHARE OF mo;
 PERFORM 1 FROM public.modifier_groups mg JOIN public.menu_item_modifier_groups mm ON mm.group_id=mg.id
   JOIN public.cart_items ci ON ci.menu_item_id=mm.menu_item_id WHERE ci.cart_id=_cart FOR SHARE OF mg,mm;
 PERFORM 1 FROM public.promotion_codes p WHERE p.organization_id=c.organization_id
   AND upper(p.code)=upper(btrim(c.promo_code)) FOR UPDATE;
END;
$function$;
REVOKE ALL ON FUNCTION public.neo_guest_lock_cart_pricing(uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.neo_guest_cart_line_write_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE row_data jsonb; cart uuid; c public.carts;
BEGIN
 row_data:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 IF TG_TABLE_NAME='cart_items' THEN cart:=(row_data->>'cart_id')::uuid;
 ELSE SELECT ci.cart_id INTO cart FROM public.cart_items ci WHERE ci.id=(row_data->>'cart_item_id')::uuid; END IF;
 IF cart IS NULL THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
 SELECT * INTO c FROM public.carts WHERE id=cart FOR UPDATE;
 IF c.id IS NULL THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
 IF c.status IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'A converted cart cannot be edited; review the saved order'; END IF;
 IF (row_data->>'organization_id')::uuid IS DISTINCT FROM c.organization_id THEN RAISE EXCEPTION 'Cart line workspace differs'; END IF;
 IF TG_OP='UPDATE' AND (row_data->>'cart_id' IS DISTINCT FROM to_jsonb(OLD)->>'cart_id'
    OR row_data->>'cart_item_id' IS DISTINCT FROM to_jsonb(OLD)->>'cart_item_id') THEN
  RAISE EXCEPTION 'A cart line cannot move between carts';
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$function$;
REVOKE ALL ON FUNCTION public.neo_guest_cart_line_write_guard() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.neo_guest_order_cart_binding_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF TG_OP='UPDATE' AND OLD.source_cart_id IS NOT NULL AND
    (jsonb_build_array(NEW.organization_id,NEW.branch_id,NEW.pos_order_id,NEW.customer_id,NEW.currency,NEW.fulfilment_type,
       NEW.subtotal,NEW.discount_total,NEW.tax_total,NEW.service_charge_total,NEW.delivery_fee,NEW.tip_amount,NEW.grand_total)) IS DISTINCT FROM
    (jsonb_build_array(OLD.organization_id,OLD.branch_id,OLD.pos_order_id,OLD.customer_id,OLD.currency,OLD.fulfilment_type,
       OLD.subtotal,OLD.discount_total,OLD.tax_total,OLD.service_charge_total,OLD.delivery_fee,OLD.tip_amount,OLD.grand_total)) THEN
  RAISE EXCEPTION 'Saved checkout financial details cannot be rewritten; use the authorised correction/refund workflow';
 END IF;
 IF TG_OP='UPDATE' AND OLD.source_cart_id IS NOT NULL AND NEW.source_cart_id IS DISTINCT FROM OLD.source_cart_id THEN
  RAISE EXCEPTION 'A saved order cart link cannot be changed';
 END IF;
 IF NEW.source_cart_id IS NOT NULL AND (TG_OP='INSERT' OR NEW.source_cart_id IS DISTINCT FROM OLD.source_cart_id) THEN
  IF current_user NOT IN (SELECT pg_get_userbyid(proowner) FROM pg_proc
    WHERE oid IN ('public.delivery_place_order(uuid,text)'::regprocedure,'public.neo_guest_place_room_service(uuid,text)'::regprocedure)) THEN
   RAISE EXCEPTION 'Saved cart links are assigned by checkout only' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.carts c JOIN public.pos_orders p ON p.id=NEW.pos_order_id
    WHERE c.id=NEW.source_cart_id AND c.organization_id=NEW.organization_id AND c.customer_id=NEW.customer_id
      AND c.branch_id IS NOT DISTINCT FROM NEW.branch_id AND c.status='active'
      AND p.organization_id=c.organization_id AND p.branch_id IS NOT DISTINCT FROM c.branch_id AND p.customer_id=c.customer_id) THEN
   RAISE EXCEPTION 'Saved cart, production order and guest links do not agree';
  END IF;
 END IF;
 RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.neo_guest_order_cart_binding_guard() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.neo_tip_payable_account(_org uuid)
RETURNS uuid LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE account public.chart_of_accounts; configured text; matches integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('tips-payable:'||_org::text,0));
 SELECT nullif(btrim(s.settings->>'tipPayableAccountId'),'') INTO configured FROM public.system_settings s WHERE s.organization_id=_org;
 IF configured IS NOT NULL THEN
  SELECT * INTO account FROM public.chart_of_accounts WHERE id=configured::uuid AND organization_id=_org;
 ELSE
  SELECT count(*) INTO matches FROM public.chart_of_accounts WHERE organization_id=_org AND lower(btrim(name)) IN ('tips payable','gratuities payable');
  IF matches>1 THEN RAISE EXCEPTION 'Map one tips payable account in Finance settings before posting tips'; END IF;
  SELECT * INTO account FROM public.chart_of_accounts WHERE organization_id=_org AND lower(btrim(name)) IN ('tips payable','gratuities payable') LIMIT 1;
  IF account.id IS NULL THEN
   IF EXISTS(SELECT 1 FROM public.chart_of_accounts WHERE organization_id=_org AND code='2175') THEN
    RAISE EXCEPTION 'Account 2175 is already in use. Map the correct tips payable account before posting tips';
   END IF;
   PERFORM public.neo_finance_ensure_account(_org,'2175','Tips Payable','liability','Current Liabilities');
   SELECT * INTO account FROM public.chart_of_accounts WHERE organization_id=_org AND code='2175';
  END IF;
 END IF;
 IF account.id IS NULL OR account.category IS DISTINCT FROM 'liability' OR account.active IS NOT TRUE OR coalesce(account.postable,true) IS NOT TRUE OR coalesce(account.is_header,false) THEN
  RAISE EXCEPTION 'An active postable liability account is required for collected tips';
 END IF;
 RETURN account.id;
END;
$function$;
REVOKE ALL ON FUNCTION public.neo_tip_payable_account(uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.neo_folio_financial_components(_folio uuid,_org uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path TO 'public','pg_temp'
AS $function$
DECLARE f public.folios; _net numeric:=0; _tax numeric:=0; _service numeric:=0; _gross numeric:=0; _paid numeric:=0; _other numeric:=0; _discount numeric:=0;
BEGIN
 SELECT * INTO f FROM public.folios WHERE id=_folio AND organization_id=_org;
 IF f.id IS NULL THEN RETURN jsonb_build_object('found',false); END IF;
 IF EXISTS(SELECT 1 FROM public.payments p WHERE p.organization_id=f.organization_id AND p.folio_id=f.id
    AND p.status IN ('confirmed','posted','completed') AND p.currency IS DISTINCT FROM f.currency)
   OR EXISTS(SELECT 1 FROM public.reservation_deposits d WHERE d.organization_id=f.organization_id AND d.applied_folio_id=f.id
    AND d.status='applied' AND d.payment_id IS NULL AND d.currency IS DISTINCT FROM f.currency) THEN
  RAISE EXCEPTION 'Folio collections contain a different currency; verified conversion or reconciliation is required';
 END IF;
  SELECT COALESCE(SUM(fl.net_amount), 0),
         COALESCE(SUM(fl.tax_amount), 0),
         COALESCE(SUM(fl.service_charge_amount), 0),
         COALESCE(SUM(fl.net_amount) FILTER (WHERE fl.category='gratuity'),0),
         COALESCE(SUM(fl.discount_amount),0)
    INTO _gross, _tax, _service, _other, _discount
    FROM public.folio_lines fl
   WHERE fl.folio_id = f.id
     AND fl.organization_id = f.organization_id
     AND COALESCE(fl.status, 'posted') NOT IN ('void', 'voided', 'reversed')
     AND COALESCE(fl.line_type, 'charge') NOT IN ('payment', 'deposit', 'refund');
  _net := _gross - _tax - _service - _other;

  SELECT COALESCE(SUM(pm.amount), 0) INTO _paid
    FROM public.payments pm

   WHERE pm.folio_id = f.id
     -- neo_folio_payment_tenant_guard_v1
     AND pm.organization_id = f.organization_id

     AND pm.status IN ('confirmed', 'posted', 'completed');


  -- neo_folio_applied_deposit_projection_v1
  -- These deposits have no payments row, so the payment sum excludes them.
  SELECT _paid + COALESCE(SUM(d.amount), 0)
    INTO _paid
    FROM public.reservation_deposits d
   WHERE d.organization_id = f.organization_id
     AND d.applied_folio_id = f.id
     AND d.status = 'applied'
     AND d.payment_id IS NULL
     AND EXISTS (
       SELECT 1
       FROM public.folio_lines fl
       WHERE fl.id = d.applied_folio_line_id
         AND fl.folio_id = f.id
         AND fl.organization_id = f.organization_id
         AND fl.line_type IN ('payment', 'deposit')
         AND COALESCE(fl.status, 'posted')
             NOT IN ('void', 'voided', 'reversed')
         AND fl.net_amount = d.amount
     );


 IF EXISTS(SELECT 1 FROM unnest(ARRAY[_net,_tax,_service,_gross,_paid,_other,_discount]) value WHERE value::text IN ('NaN','Infinity','-Infinity')) THEN
  RAISE EXCEPTION 'Folio ledger amounts are not finite; reconcile the source entries before using these totals';
 END IF;
 RETURN jsonb_build_object('found',true,'net_revenue',_net,'tax',_tax,'service_charge',_service,'other_charges',_other,
   'charge_components',CASE WHEN _other<>0 THEN jsonb_build_array(jsonb_build_object('key','gratuity','label','Staff tips','amount',_other,'classification','liability')) ELSE '[]'::jsonb END,
   'total_discounts',_discount,'gross_obligation',_gross,'collected',_paid,'outstanding',_gross-_paid);
END;
$function$;
REVOKE ALL ON FUNCTION public.neo_folio_financial_components(uuid,uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.delivery_quote_cart(_cart uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _c public.carts; _s public.delivery_settings; _z public.delivery_zones;
  _sub numeric := 0; _tax numeric := 0; _mods numeric := 0;
  _fee numeric := 0; _disc numeric := 0; _svc numeric := 0; _promo public.promotion_codes;
  _issues text[] := '{}'; _lines jsonb := '[]'::jsonb; _uses int; _pct numeric; _local time;
BEGIN
  SELECT * INTO _c FROM public.carts WHERE id = _cart;
  IF _c.id IS NULL OR _c.status IS DISTINCT FROM 'active' OR NOT EXISTS(SELECT 1 FROM public.customers owner WHERE owner.id=_c.customer_id AND owner.organization_id=_c.organization_id AND owner.auth_user_id=auth.uid() AND owner.merged_into_id IS NULL) THEN
    RAISE EXCEPTION 'Cart not found';
  END IF;
  _s := public.delivery_get_settings(_c.branch_id);
  IF NOT EXISTS(SELECT 1 FROM public.branches b WHERE b.id=_c.branch_id AND b.organization_id=_c.organization_id AND b.active)
     OR public.neo_fact_currency(_c.organization_id,_c.branch_id) IS NULL
     OR public.neo_fact_currency(_c.organization_id,_c.branch_id) !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'Cart property or currency is not configured for checkout';
  END IF;

  IF EXISTS (SELECT 1 FROM public.cart_items ci LEFT JOIN public.menu_items mi ON mi.id=ci.menu_item_id
      WHERE ci.cart_id=_cart AND (ci.organization_id IS DISTINCT FROM _c.organization_id
        OR mi.organization_id IS DISTINCT FROM _c.organization_id OR mi.id IS NULL
        OR (mi.branch_id IS NOT NULL AND mi.branch_id IS DISTINCT FROM _c.branch_id)
        OR ci.quantity IS NULL OR ci.quantity<=0 OR ci.quantity::text IN ('NaN','Infinity','-Infinity')
        OR mi.base_price IS NULL OR mi.base_price<0 OR mi.base_price::text IN ('NaN','Infinity','-Infinity')
        OR mi.tax_rate IS NULL OR mi.tax_rate<0 OR mi.tax_rate::text IN ('NaN','Infinity','-Infinity'))) THEN
    RAISE EXCEPTION 'Cart has an invalid item, property, quantity, price or tax rate';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cart_item_modifiers cm JOIN public.cart_items ci ON ci.id=cm.cart_item_id
      LEFT JOIN public.modifier_options mo ON mo.id=cm.option_id AND mo.group_id=cm.group_id
      LEFT JOIN public.modifier_groups mg ON mg.id=mo.group_id
      LEFT JOIN public.menu_item_modifier_groups mm ON mm.menu_item_id=ci.menu_item_id AND mm.group_id=mg.id
      WHERE ci.cart_id=_cart AND (cm.organization_id IS DISTINCT FROM _c.organization_id
        OR mo.organization_id IS DISTINCT FROM _c.organization_id OR mg.organization_id IS DISTINCT FROM _c.organization_id
        OR mm.organization_id IS DISTINCT FROM _c.organization_id OR mo.active IS NOT TRUE OR mg.active IS NOT TRUE
        OR mo.extra_charge IS NULL OR mo.extra_charge<0 OR mo.extra_charge::text IN ('NaN','Infinity','-Infinity'))) THEN
    RAISE EXCEPTION 'A selected modifier is unavailable or has an invalid catalogue price';
  END IF;
  IF EXISTS(SELECT 1 FROM public.cart_item_modifiers cm JOIN public.cart_items ci ON ci.id=cm.cart_item_id WHERE ci.cart_id=_cart
      GROUP BY cm.cart_item_id,cm.option_id HAVING count(*)>1) THEN
    _issues:=_issues||array['A modifier option is selected more than once. Correct the item choices.'];
  END IF;
  IF EXISTS(SELECT 1 FROM public.cart_items ci JOIN public.menu_item_modifier_groups mm ON mm.menu_item_id=ci.menu_item_id AND mm.organization_id=_c.organization_id
      JOIN public.modifier_groups mg ON mg.id=mm.group_id AND mg.organization_id=_c.organization_id AND mg.active
      CROSS JOIN LATERAL(SELECT count(*) n FROM public.cart_item_modifiers cm WHERE cm.cart_item_id=ci.id AND cm.group_id=mg.id) picked
      WHERE ci.cart_id=_cart AND (picked.n<greatest(coalesce(mg.min_select,0),CASE WHEN mg.required THEN 1 ELSE 0 END)
        OR (mg.multi_select IS NOT TRUE AND picked.n>1) OR (coalesce(mg.max_select,0)>0 AND picked.n>mg.max_select))) THEN
    _issues:=_issues||array['Complete the required item choices within their selection limits.'];
  END IF;
  WITH priced AS (
    SELECT ci.*,mi.name,mi.base_price,mi.tax_rate,mi.station_id,mi.availability,mi.available_delivery,
      round(ci.quantity*(mi.base_price+coalesce(mods.amount,0)),2) AS payable,
      coalesce(mods.selections,'[]'::jsonb) AS selections
    FROM public.cart_items ci JOIN public.menu_items mi ON mi.id=ci.menu_item_id
    LEFT JOIN LATERAL (
      SELECT sum(mo.extra_charge) amount,jsonb_agg(jsonb_build_object('group_id',cm.group_id,'option_id',cm.option_id) ORDER BY cm.id) selections
      FROM public.cart_item_modifiers cm JOIN public.modifier_options mo ON mo.id=cm.option_id AND mo.group_id=cm.group_id
      WHERE cm.cart_item_id=ci.id
    ) mods ON true WHERE ci.cart_id=_cart
  ) SELECT coalesce(sum(payable),0),coalesce(sum(round(payable*tax_rate/(100+tax_rate),2)),0),
      coalesce(jsonb_agg(jsonb_build_object('cart_item_id',id,'menu_item_id',menu_item_id,'name',name,
        'quantity',quantity,'unit_price',base_price,'tax_rate',tax_rate,'station_id',station_id,
        'availability',availability,'delivery_eligible',available_delivery,'line_total',payable,
        'selection_modifiers',selections,'special_instructions',special_instructions,'allergy_note',allergy_note) ORDER BY created_at,id),'[]'::jsonb)
    INTO _sub,_tax,_lines FROM priced;

  IF EXISTS (SELECT 1 FROM public.cart_items ci JOIN public.menu_items mi ON mi.id = ci.menu_item_id
             WHERE ci.cart_id = _cart
               AND (mi.availability <> 'available'
                 OR (_c.fulfilment_type = 'delivery' AND NOT mi.available_delivery)
                 OR (_c.fulfilment_type = 'pickup' AND NOT coalesce(mi.available_takeaway, false))
                 OR (_c.fulfilment_type = 'room-service' AND NOT coalesce(mi.available_room_service, false)))) THEN
    _issues := _issues || array['Some items are unavailable for this fulfilment type and must be removed.'];
  END IF;

  IF _c.fulfilment_type = 'room-service' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.reservations r
       WHERE r.customer_id = _c.customer_id
         AND r.organization_id = _c.organization_id
         AND r.branch_id IS NOT DISTINCT FROM _c.branch_id AND r.status IN ('checked_in','in_house','checked-in','in-house')
    ) THEN
      _issues := _issues || array['Room service is available during an in-house stay only.'];
    END IF;
  END IF;

  IF _c.fulfilment_type = 'delivery' THEN
    SELECT * INTO _z FROM public.delivery_zones WHERE id = _c.zone_id AND organization_id=_c.organization_id AND active
      AND (branch_id IS NULL OR branch_id IS NOT DISTINCT FROM _c.branch_id);
    IF _z.id IS NULL THEN
      _issues := _issues || array['Select a delivery address inside a served zone.'];
    ELSE
      _fee := _z.base_fee;
      IF _z.free_delivery_threshold IS NOT NULL AND _sub >= _z.free_delivery_threshold THEN _fee := 0; END IF;
      IF _sub < greatest(_z.min_order, coalesce(_s.min_order, 0)) THEN
        _issues := _issues || array[format('Minimum order for this zone is %s.', greatest(_z.min_order, coalesce(_s.min_order,0)))];
      END IF;
      _local := (coalesce(_c.scheduled_for,now()) AT TIME ZONE public.neo_fact_timezone(_c.organization_id,_c.branch_id))::time;
      IF NOT (CASE WHEN _z.service_start<=_z.service_end THEN _local BETWEEN _z.service_start AND _z.service_end
        ELSE _local>=_z.service_start OR _local<=_z.service_end END) THEN
        _issues := _issues || array['This zone is outside its service hours right now — schedule the order instead.'];
      END IF;
    END IF;
  ELSIF _c.fulfilment_type = 'pickup' AND coalesce(_s.pickup_enabled, true) = false THEN
    _issues := _issues || array['Pickup is not enabled for this branch.'];
  END IF;

  IF _c.promo_code IS NOT NULL AND length(trim(_c.promo_code)) > 0 THEN
    SELECT * INTO _promo FROM public.promotion_codes
    WHERE organization_id = _c.organization_id AND upper(code) = upper(trim(_c.promo_code))
      AND active AND approval_status = 'approved';
    IF _promo.id IS NOT NULL AND (
      (_promo.discount_type IN ('percentage','fixed') AND (_promo.discount_value IS NULL OR _promo.discount_value<0 OR _promo.discount_value::text IN ('NaN','Infinity','-Infinity')))
      OR (_promo.discount_type='percentage' AND _promo.discount_value>100)
      OR _promo.max_discount<0 OR _promo.max_discount::text IN ('NaN','Infinity','-Infinity')
      OR _promo.min_order<0 OR _promo.min_order::text IN ('NaN','Infinity','-Infinity')
      OR _promo.usage_count<0 OR _promo.per_customer_limit<0 OR _promo.total_usage_limit<0
      OR (_promo.starts_at IS NOT NULL AND _promo.ends_at IS NOT NULL AND _promo.starts_at>_promo.ends_at)) THEN
      RAISE EXCEPTION 'The promotion amount or validity policy is invalid';
    END IF;
    IF _promo.id IS NULL THEN
      _issues := _issues || array['Promo code is not valid.'];
    ELSIF (_promo.starts_at IS NOT NULL AND now() < _promo.starts_at)
       OR (_promo.ends_at IS NOT NULL AND now() > _promo.ends_at) THEN
      _issues := _issues || array['Promo code is outside its validity period.'];
    ELSIF _sub < _promo.min_order THEN
      _issues := _issues || array['Order value is below the promo minimum.'];
    ELSE
      SELECT count(*) INTO _uses FROM public.promotion_redemptions
      WHERE promotion_id = _promo.id AND customer_id = _c.customer_id;
      IF _uses >= _promo.per_customer_limit THEN
        _issues := _issues || array['Promo usage limit reached for this customer.'];
      ELSIF _promo.total_usage_limit IS NOT NULL AND _promo.usage_count >= _promo.total_usage_limit THEN
        _issues := _issues || array['Promo code is fully redeemed.'];
      ELSE
        IF _promo.discount_type = 'percentage' THEN _disc := _sub * _promo.discount_value / 100;
        ELSIF _promo.discount_type = 'fixed' THEN _disc := _promo.discount_value;
        END IF;
        IF _promo.max_discount IS NOT NULL THEN _disc := least(_disc, _promo.max_discount); END IF;
        IF _promo.free_delivery OR _promo.discount_type = 'free-delivery' THEN _fee := 0; END IF;
        _disc := least(_disc, _sub);
      END IF;
    END IF;
  END IF;

  _pct := coalesce(public.neo_service_charge_percent(_c.organization_id,_c.branch_id),0);
  IF _pct<0 OR _pct::text IN ('NaN','Infinity','-Infinity') OR _fee IS NULL OR _fee<0
     OR _fee::text IN ('NaN','Infinity','-Infinity') OR coalesce(_c.tip_amount,0)<0
     OR coalesce(_c.tip_amount,0)::text IN ('NaN','Infinity','-Infinity')
     OR _disc<0 OR _disc::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'Cart fee, tip, discount or service percentage is invalid';
  END IF;
  _disc := round(least(_disc,_sub),2);
  _fee := round(_fee,2);
  IF _sub>0 THEN _tax:=round(_tax*greatest(_sub-_disc,0)/_sub,2); END IF;
  _svc := round(greatest(_sub-_disc,0)*_pct/100,2);

  RETURN jsonb_build_object(
    'cart_id', _c.id,
    'branch_id', _c.branch_id,
    'currency', public.neo_fact_currency(_c.organization_id,_c.branch_id),
    'fulfilment_type', _c.fulfilment_type,
    'lines', _lines,
    'subtotal', round(_sub, 2),
    'tax_total', round(_tax, 2),
    'discount_total', round(_disc, 2),
    'service_charge', _svc,
    'delivery_fee', round(_fee, 2),
    'tip_amount', round(coalesce(_c.tip_amount, 0), 2),
    'grand_total', round(greatest(_sub + _svc + _fee + coalesce(_c.tip_amount,0) - _disc, 0), 2),
    'promotion_id', _promo.id,
    'zone_id', _z.id,
    'eta_minutes', coalesce(_z.eta_minutes, 45),
    'issues', to_jsonb(_issues),
    'can_checkout', (cardinality(_issues) = 0 AND jsonb_array_length(_lines) > 0)
  );
END; $function$
;

CREATE OR REPLACE FUNCTION public.delivery_place_order(_cart uuid, _payment_method text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _c public.carts; _q jsonb; _s public.delivery_settings; _addr public.customer_addresses;
  _pos uuid; _del uuid; _num text; _line jsonb; _item uuid; _cust public.customers;
  _pin text; _pay_status text; _actor uuid; _order_status text; _collect boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(_cart::text, 77));

  SELECT * INTO _c FROM public.carts WHERE id = _cart AND status = 'active' FOR UPDATE;
  IF _c.id IS NULL OR NOT EXISTS(SELECT 1 FROM public.customers owner WHERE owner.id=_c.customer_id AND owner.organization_id=_c.organization_id AND owner.auth_user_id=auth.uid() AND owner.merged_into_id IS NULL) THEN
    -- Already converted by an earlier submission: return that order rather
    -- than creating a second one for the same basket.
    SELECT jsonb_build_object('delivery_order_id', d.id, 'pos_order_id', d.pos_order_id,
                              'order_number', d.order_number, 'pin', NULL,
                              'duplicate_suppressed', true)
      INTO _q
      FROM public.delivery_orders d
      JOIN public.carts c2 ON c2.id = _cart JOIN public.customers owner ON owner.id=c2.customer_id AND owner.organization_id=c2.organization_id AND owner.auth_user_id=auth.uid() AND owner.merged_into_id IS NULL
     WHERE d.customer_id = c2.customer_id AND d.organization_id=c2.organization_id AND d.source_cart_id=c2.id
     ORDER BY d.created_at DESC LIMIT 1;
    IF _q IS NOT NULL THEN RETURN _q; END IF;
    RAISE EXCEPTION 'Cart is unavailable or has no exact saved order link. Review existing orders before retrying.';
  END IF;
  PERFORM public.neo_guest_lock_cart_pricing(_cart);
  IF _c.fulfilment_type NOT IN ('delivery','pickup') THEN RAISE EXCEPTION 'Use the room-service checkout for this cart'; END IF;
  _q := public.delivery_quote_cart(_cart);
  IF NOT (_q->>'can_checkout')::boolean THEN RAISE EXCEPTION 'Cart cannot be checked out: %', _q->>'issues'; END IF;

  IF _payment_method IS NULL THEN RAISE EXCEPTION 'Choose a configured payment method'; END IF;
  IF _payment_method='mpesa' AND ((_q->>'currency') IS DISTINCT FROM 'KES' OR (_q->>'grand_total')::numeric<=0
     OR (_q->>'grand_total')::numeric<>trunc((_q->>'grand_total')::numeric) OR (_q->>'grand_total')::numeric>9007199254740991) THEN
    RAISE EXCEPTION 'M-Pesa requires a positive whole KES total. Choose another payment method; no order or prompt was created.';
  END IF;
  _s := public.delivery_get_settings(_c.branch_id);

  _collect := _c.fulfilment_type = 'pickup' AND _payment_method = 'pay-on-collection';

  IF NOT _collect THEN
    IF _payment_method <> ALL (coalesce(_s.allowed_payment_methods, ARRAY['cash'])) THEN
      RAISE EXCEPTION 'Payment method not allowed';
    END IF;
    IF _payment_method = 'cash' AND (_q->>'grand_total')::numeric > coalesce(_s.cod_limit, 0) THEN
      RAISE EXCEPTION 'Cash on delivery limit exceeded';
    END IF;
  END IF;

  SELECT p.id INTO _actor FROM public.profiles p WHERE p.id = auth.uid();

  SELECT * INTO _cust FROM public.customers WHERE id = _c.customer_id;
  SELECT * INTO _addr FROM public.customer_addresses WHERE id = _c.address_id;
  _num := public.next_document_number('delivery_order', NULL, NULL, _c.organization_id);
  _pay_status := CASE WHEN _payment_method IN ('cash', 'pay-on-collection') THEN 'unpaid' ELSE 'pending' END;
  _order_status := CASE WHEN _payment_method IN ('cash', 'pay-on-collection') THEN 'confirmed' ELSE 'pending-payment' END;

  INSERT INTO public.pos_orders (
    organization_id, branch_id, order_number, order_type, order_source,
    customer_id, guest_count, guest_name, contact_phone, status, payment_status,
    subtotal, discount_total, tax_total, grand_total, currency, notes, created_by
  ) VALUES (
    _c.organization_id, _c.branch_id, _num,
    CASE WHEN _c.fulfilment_type = 'pickup' THEN 'takeaway' ELSE 'delivery' END,
    'customer-app', _c.customer_id, 1, _cust.full_name, coalesce(_addr.phone, _cust.phone),
    'confirmed', _pay_status,
    (_q->>'subtotal')::numeric, (_q->>'discount_total')::numeric, (_q->>'tax_total')::numeric,
    (_q->>'grand_total')::numeric, _q->>'currency', _c.notes, _actor
  ) RETURNING id INTO _pos;

  FOR _line IN SELECT * FROM jsonb_array_elements(_q->'lines') LOOP
    INSERT INTO public.pos_order_items (
      organization_id, order_id, menu_item_id, station_id, item_name, quantity,
      selection_modifiers, unit_price, tax_rate, tax_amount, line_total, status, special_instructions, allergy_note, created_by
    ) VALUES (
      _c.organization_id, _pos, (_line->>'menu_item_id')::uuid, nullif(_line->>'station_id','')::uuid,
      _line->>'name', (_line->>'quantity')::numeric, _line->'selection_modifiers', (_line->>'unit_price')::numeric,
      (_line->>'tax_rate')::numeric,
      round((_line->>'quantity')::numeric * (_line->>'unit_price')::numeric * (_line->>'tax_rate')::numeric / nullif(100 + (_line->>'tax_rate')::numeric, 0), 2),
      round((_line->>'quantity')::numeric * (_line->>'unit_price')::numeric, 2),
      'draft', _line->>'special_instructions', _line->>'allergy_note', _actor
    ) RETURNING id INTO _item;

  END LOOP;

  INSERT INTO public.delivery_orders (
    source_cart_id, currency, organization_id, branch_id, pos_order_id, customer_id, auth_user_id, order_number,
    fulfilment_type, contact_name, contact_phone, address_snapshot, zone_id, latitude, longitude,
    subtotal, tax_total, discount_total, service_charge_total, delivery_fee, tip_amount, grand_total,
    payment_method, payment_status, promo_code, promotion_id, scheduled_for,
    estimated_prep_minutes, estimated_delivery_at, order_status, notes, created_by
  ) VALUES (
    _cart, _q->>'currency', _c.organization_id, _c.branch_id, _pos, _c.customer_id, auth.uid(), _num,
    _c.fulfilment_type, coalesce(_addr.recipient_name, _cust.full_name), coalesce(_addr.phone, _cust.phone),
    CASE WHEN _addr.id IS NULL THEN '{}'::jsonb ELSE to_jsonb(_addr) - 'created_by' END,
    (_q->>'zone_id')::uuid, _addr.latitude, _addr.longitude,
    (_q->>'subtotal')::numeric, (_q->>'tax_total')::numeric, (_q->>'discount_total')::numeric,
    coalesce((_q->>'service_charge')::numeric, 0),
    (_q->>'delivery_fee')::numeric, (_q->>'tip_amount')::numeric, (_q->>'grand_total')::numeric,
    _payment_method, _pay_status, _c.promo_code, (_q->>'promotion_id')::uuid, _c.scheduled_for,
    coalesce((_q->>'eta_minutes')::int, 45),
    now() + make_interval(mins => coalesce((_q->>'eta_minutes')::int, 45)),
    _order_status,
    _c.notes, _actor
  ) RETURNING id INTO _del;

  UPDATE public.pos_orders SET discount_total=(_q->>'discount_total')::numeric, updated_at=now() WHERE id=_pos;
  IF NOT EXISTS(SELECT 1 FROM public.pos_orders p WHERE p.id=_pos AND p.organization_id=_c.organization_id
      AND p.currency=_q->>'currency' AND p.subtotal=(_q->>'subtotal')::numeric
      AND p.tax_total=(_q->>'tax_total')::numeric AND p.discount_total=(_q->>'discount_total')::numeric
      AND p.service_charge_total=(_q->>'service_charge')::numeric AND p.grand_total=(_q->>'grand_total')::numeric) THEN
    RAISE EXCEPTION 'Saved order amounts differ from the quote; checkout rolled back before collection';
  END IF;

  SELECT nullif(p.pin_secret, '') INTO _pin
    FROM public.delivery_order_pins p WHERE p.delivery_order_id = _del;

  IF (_q->>'promotion_id') IS NOT NULL THEN
    INSERT INTO public.promotion_redemptions (organization_id, promotion_id, customer_id, delivery_order_id, discount_amount)
    VALUES (_c.organization_id, (_q->>'promotion_id')::uuid, _c.customer_id, _del, (_q->>'discount_total')::numeric)
    ON CONFLICT DO NOTHING;
    UPDATE public.promotion_codes SET usage_count = usage_count + 1 WHERE id = (_q->>'promotion_id')::uuid;
  END IF;

  INSERT INTO public.delivery_order_status_history (organization_id, delivery_order_id, status_kind, new_status, source, changed_by)
  VALUES (_c.organization_id, _del, 'order', _order_status, 'customer', _actor);

  IF _order_status = 'confirmed' THEN
    PERFORM public.neo_pos_route_tickets_internal(_pos, _c.organization_id);
    UPDATE public.pos_orders SET status = 'sent' WHERE id = _pos;
    UPDATE public.delivery_orders SET kitchen_status = 'new' WHERE id = _del;
  ELSE
    UPDATE public.delivery_orders SET kitchen_status = 'not-sent' WHERE id = _del;
  END IF;

  UPDATE public.carts SET status = 'converted' WHERE id = _cart;

  RETURN jsonb_build_object('delivery_order_id', _del, 'pos_order_id', _pos, 'order_number', _num, 'pin', _pin);
END; $function$
;

CREATE OR REPLACE FUNCTION public.neo_guest_place_room_service(_cart uuid, _payment_intent text DEFAULT 'room-charge'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _c public.carts; _q jsonb; _cust public.customers; _stay jsonb;
  _pos uuid; _del uuid; _num text; _line jsonb; _item uuid; _folio uuid; _line_id uuid; _tip_line uuid;
BEGIN
  IF _payment_intent IS NULL OR _payment_intent NOT IN ('room-charge','pay-at-property') THEN
    RAISE EXCEPTION 'Unsupported payment option';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(_cart::text, 77));

  SELECT * INTO _c FROM public.carts WHERE id = _cart AND status = 'active' FOR UPDATE;
  IF _c.id IS NULL OR NOT EXISTS(SELECT 1 FROM public.customers owner WHERE owner.id=_c.customer_id AND owner.organization_id=_c.organization_id AND owner.auth_user_id=auth.uid() AND owner.merged_into_id IS NULL) THEN
    SELECT jsonb_build_object('delivery_order_id', d.id, 'pos_order_id', d.pos_order_id,
                              'order_number', d.order_number, 'folio_line_id', NULL,
                              'charged_to_room', d.payment_method = 'room-charge',
                              'duplicate_suppressed', true)
      INTO _q
      FROM public.delivery_orders d
      JOIN public.carts c2 ON c2.id = _cart JOIN public.customers owner ON owner.id=c2.customer_id AND owner.organization_id=c2.organization_id AND owner.auth_user_id=auth.uid() AND owner.merged_into_id IS NULL
     WHERE d.customer_id = c2.customer_id AND d.organization_id=c2.organization_id AND d.source_cart_id=c2.id AND d.fulfilment_type = 'room-service'
     ORDER BY d.created_at DESC LIMIT 1;
    IF _q IS NOT NULL THEN RETURN _q; END IF;
    RAISE EXCEPTION 'Cart is unavailable or has no exact saved order link. Review existing orders before retrying.';
  END IF;
  IF _c.fulfilment_type <> 'room-service' THEN RAISE EXCEPTION 'Cart is not a room-service order'; END IF;

  PERFORM public.neo_guest_lock_cart_pricing(_cart);
  _q := public.delivery_quote_cart(_cart);
  IF NOT (_q->>'can_checkout')::boolean THEN
    RAISE EXCEPTION 'Order cannot be placed: %', _q->>'issues';
  END IF;

  _stay := public.neo_guest_active_stay(_c.organization_id);
  IF _stay IS NULL THEN RAISE EXCEPTION 'Room service is available during an in-house stay only'; END IF;
  _folio := nullif(_stay->>'folio_id','')::uuid;
  IF _payment_intent = 'room-charge' AND _folio IS NULL THEN
    RAISE EXCEPTION 'No open room bill is available — please choose to settle at the property';
  END IF;

  SELECT * INTO _cust FROM public.customers WHERE id = _c.customer_id;
  _num := public.next_document_number('delivery_order', NULL, NULL, _c.organization_id);

  INSERT INTO public.pos_orders (
    organization_id, branch_id, order_number, order_type, order_source, customer_id,
    stay_id, room_id, folio_id, guest_count, guest_name, contact_phone, status, payment_status,
    subtotal, discount_total, tax_total, grand_total, currency, notes)
  VALUES (
    _c.organization_id, coalesce(_c.branch_id, nullif(_stay->>'branch_id','')::uuid), _num,
    'room-service', 'guest-app', _c.customer_id,
    NULL, (SELECT r.room_id FROM public.reservations r WHERE r.id = (_stay->>'reservation_id')::uuid),
    CASE WHEN _payment_intent = 'room-charge' THEN _folio ELSE NULL END,
    1, _cust.full_name, _cust.phone, 'confirmed',
    CASE WHEN _payment_intent = 'room-charge' THEN 'credit' ELSE 'unpaid' END,
    (_q->>'subtotal')::numeric, (_q->>'discount_total')::numeric, (_q->>'tax_total')::numeric,
    (_q->>'grand_total')::numeric, _q->>'currency', _c.notes)
  RETURNING id INTO _pos;

  FOR _line IN SELECT * FROM jsonb_array_elements(_q->'lines') LOOP
    INSERT INTO public.pos_order_items (
      organization_id, order_id, menu_item_id, station_id, item_name, quantity,
      selection_modifiers, unit_price, tax_rate, tax_amount, line_total, status, special_instructions, allergy_note)
    VALUES (
      _c.organization_id, _pos, (_line->>'menu_item_id')::uuid, nullif(_line->>'station_id','')::uuid,
      _line->>'name', (_line->>'quantity')::numeric, _line->'selection_modifiers', (_line->>'unit_price')::numeric,
      (_line->>'tax_rate')::numeric,
      round((_line->>'quantity')::numeric * (_line->>'unit_price')::numeric * (_line->>'tax_rate')::numeric / nullif(100 + (_line->>'tax_rate')::numeric, 0), 2),
      round((_line->>'quantity')::numeric * (_line->>'unit_price')::numeric, 2),
      'draft', _line->>'special_instructions', _line->>'allergy_note')
    RETURNING id INTO _item;

  END LOOP;

  INSERT INTO public.delivery_orders (
    source_cart_id, currency, organization_id, branch_id, pos_order_id, customer_id, auth_user_id, order_number,
    fulfilment_type, contact_name, contact_phone, subtotal, tax_total, discount_total,
    service_charge_total, delivery_fee, tip_amount, grand_total, payment_method, payment_status,
    estimated_prep_minutes, estimated_delivery_at, order_status, kitchen_status, notes)
  VALUES (
    _cart, _q->>'currency', _c.organization_id, coalesce(_c.branch_id, nullif(_stay->>'branch_id','')::uuid), _pos,
    _c.customer_id, auth.uid(), _num, 'room-service', _cust.full_name, _cust.phone,
    (_q->>'subtotal')::numeric, (_q->>'tax_total')::numeric, (_q->>'discount_total')::numeric,
    coalesce((_q->>'service_charge')::numeric, 0),
    0, (_q->>'tip_amount')::numeric, (_q->>'grand_total')::numeric,
    CASE WHEN _payment_intent = 'room-charge' THEN 'room-charge' ELSE 'cash' END,
    CASE WHEN _payment_intent = 'room-charge' THEN 'charged' ELSE 'unpaid' END,
    coalesce((_q->>'eta_minutes')::int, 30),
    now() + make_interval(mins => coalesce((_q->>'eta_minutes')::int, 30)),
    'confirmed', 'not-sent', _c.notes)
  RETURNING id INTO _del;

  UPDATE public.pos_orders SET discount_total=(_q->>'discount_total')::numeric, updated_at=now() WHERE id=_pos;
  IF NOT EXISTS(SELECT 1 FROM public.pos_orders p WHERE p.id=_pos AND p.organization_id=_c.organization_id
      AND p.currency=_q->>'currency' AND p.subtotal=(_q->>'subtotal')::numeric
      AND p.tax_total=(_q->>'tax_total')::numeric AND p.discount_total=(_q->>'discount_total')::numeric
      AND p.service_charge_total=(_q->>'service_charge')::numeric AND p.grand_total=(_q->>'grand_total')::numeric) THEN
    RAISE EXCEPTION 'Saved order amounts differ from the quote; checkout rolled back before collection';
  END IF;

  PERFORM public.neo_pos_route_tickets_internal(_pos, _c.organization_id);
  UPDATE public.delivery_orders SET kitchen_status = 'new' WHERE id = _del;

  IF _payment_intent = 'room-charge' THEN
    PERFORM set_config('neo.system_posting', 'on', true);
    _line_id := public.folio_post_charge(
      _folio, 'restaurant',
      'Room service order ' || _num,
      1, (_q->>'subtotal')::numeric - (_q->>'discount_total')::numeric - (_q->>'tax_total')::numeric,
      (_q->>'tax_total')::numeric, coalesce((_q->>'service_charge')::numeric, 0), 0,
      'pos_order', _pos, 'restaurant', 'guest_room_service:' || _pos::text, NULL);
    IF (_q->>'tip_amount')::numeric>0 THEN
      _tip_line:=public.folio_post_charge(_folio,'gratuity','Staff tip for room service '||_num,
        1,(_q->>'tip_amount')::numeric,0,0,0,'pos_order',_pos,'restaurant','guest_room_service_tip:'||_pos::text,NULL);
    END IF;
    IF NOT EXISTS(SELECT 1 FROM public.folio_lines fl WHERE fl.id=_line_id AND fl.folio_id=_folio
      AND fl.organization_id=_c.organization_id AND fl.net_amount=(_q->>'grand_total')::numeric-(_q->>'tip_amount')::numeric)
      OR ((_q->>'tip_amount')::numeric>0 AND NOT EXISTS(SELECT 1 FROM public.folio_lines fl WHERE fl.id=_tip_line
        AND fl.folio_id=_folio AND fl.organization_id=_c.organization_id AND fl.net_amount=(_q->>'tip_amount')::numeric)) THEN
      RAISE EXCEPTION 'Saved room charge does not agree with the order; checkout rolled back';
    END IF;
    PERFORM set_config('neo.system_posting', 'off', true);
    UPDATE public.pos_orders SET folio_post_status = 'posted', status = 'sent' WHERE id = _pos;
  END IF;

  INSERT INTO public.delivery_order_status_history (organization_id, delivery_order_id, status_kind, new_status, source)
  VALUES (_c.organization_id, _del, 'order', 'confirmed', 'customer');

  UPDATE public.carts SET status = 'converted' WHERE id = _cart;

  RETURN jsonb_build_object('delivery_order_id', _del, 'pos_order_id', _pos,
                            'order_number', _num, 'folio_line_id', _line_id,
                            'charged_to_room', (_payment_intent = 'room-charge'));
END $function$
;

CREATE OR REPLACE FUNCTION public.tg_pos_order_totals_authoritative()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _sub numeric(14,2);
  _tax numeric(14,2);
  _net numeric(14,2);
  _pct numeric;
  _svc numeric(14,2);
  _disc numeric(14,2);
  _delivery public.delivery_orders;
BEGIN
  SELECT COALESCE(sum(line_total),0), COALESCE(sum(tax_amount),0)
    INTO _sub, _tax
  FROM public.pos_order_items
  WHERE order_id = NEW.id AND COALESCE(status,'draft') NOT IN ('cancelled','voided');

  IF EXISTS (SELECT 1 FROM public.pos_order_items WHERE order_id = NEW.id) THEN
    _disc := COALESCE(NEW.discount_total, 0);
    NEW.subtotal := _sub;
    _net := GREATEST(0, _sub - _disc);

    IF _disc > 0 AND _sub > 0 THEN
      NEW.tax_total := ROUND(_tax * (_net / _sub), 2);
    ELSE
      NEW.tax_total := _tax;
    END IF;

    SELECT COALESCE((s.settings->>'serviceChargePercent')::numeric, 0)
      INTO _pct
    FROM public.pos_settings s
    WHERE s.organization_id = NEW.organization_id
      AND (s.branch_id = NEW.branch_id OR s.branch_id IS NULL)
    ORDER BY (s.branch_id IS NULL)
    LIMIT 1;

    _svc := ROUND(_net * COALESCE(_pct,0) / 100.0, 2);
    NEW.service_charge_total := _svc;
    SELECT * INTO _delivery FROM public.delivery_orders d
      WHERE d.pos_order_id=NEW.id AND d.organization_id=NEW.organization_id AND d.source_cart_id IS NOT NULL;
    IF _delivery.id IS NOT NULL THEN
      IF _delivery.branch_id IS DISTINCT FROM NEW.branch_id OR _delivery.currency IS DISTINCT FROM NEW.currency
        OR _delivery.delivery_fee<0 OR _delivery.tip_amount<0
        OR _delivery.delivery_fee::text IN ('NaN','Infinity','-Infinity')
        OR _delivery.tip_amount::text IN ('NaN','Infinity','-Infinity') THEN
        RAISE EXCEPTION 'Linked guest order property, currency, fee or tip is invalid';
      END IF;
      -- Retain the service amount agreed at checkout, rather than applying later settings changes.
      NEW.service_charge_total:=_delivery.service_charge_total;
      NEW.grand_total:=_net+NEW.service_charge_total+_delivery.delivery_fee+_delivery.tip_amount;
    ELSE
      NEW.grand_total := _net + _svc;
    END IF;
  ELSE
    NEW.subtotal := 0;
    NEW.tax_total := 0;
    NEW.service_charge_total := 0;
    NEW.grand_total := 0;
    NEW.discount_total := 0;
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.neo_delivery_bill(_order uuid, _reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  o public.delivery_orders;
  org uuid;
  v_invoice uuid;
  v_number text;
  v_journal uuid;
  v_jnum text;
  v_key text;
  v_revenue uuid;
  v_vat uuid;
  v_service uuid;
  v_tip_account uuid;
  v_debit uuid;
  v_method text;
  v_paid boolean;
  v_tax numeric;
  v_service_amount numeric;
  v_net_items numeric;
  v_revenue_credit numeric;
  v_invoice_subtotal numeric;
  v_line int := 0;
  v_jline int := 0;
  v_existing public.invoices; v_prior text;
BEGIN
  IF auth.uid() IS NULL OR public.current_org_id() IS NULL OR public.current_access_scope() IS NULL OR public.current_access_scope()='technical' THEN RAISE EXCEPTION 'An authorised staff workspace is required'; END IF;
  SELECT * INTO o FROM public.delivery_orders WHERE id = _order FOR UPDATE;
  IF o.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'order_not_found'); END IF;
  org := o.organization_id;
  IF org <> public.current_org_id() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'order_not_found');
  END IF;
  IF NOT (public.has_permission('finance','invoices','create')
          OR public.has_permission('finance','approve')
          OR public.is_org_admin_for(org)) THEN
    RAISE EXCEPTION 'Permission to raise an invoice is required.' USING ERRCODE = '42501';
  END IF;
  IF NOT public.neo_branch_in_scope(o.branch_id) THEN
    RAISE EXCEPTION 'That order is outside your access scope.' USING ERRCODE = '42501';
  END IF;
  IF o.order_status IN ('cancelled','rejected','failed') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'order_closed',
      'detail', 'A cancelled order cannot be billed.');
  END IF;
  IF o.fulfilment_type='room-service' AND o.payment_method='room-charge' THEN
    RETURN jsonb_build_object('ok',false,'reason','room_folio_owns_charge','detail','This order is charged through its guest folio; do not issue a second delivery invoice.');
  END IF;
  IF coalesce(o.grand_total, 0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'nothing_to_bill');
  END IF;

  SELECT * INTO v_existing FROM public.invoices
   WHERE organization_id = org AND notes LIKE '%delivery-order:' || _order::text || '%'
   LIMIT 1;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.branch_id IS DISTINCT FROM o.branch_id OR v_existing.currency IS DISTINCT FROM o.currency OR v_existing.total IS DISTINCT FROM o.grand_total OR NOT public.neo_connection_journal_matches(v_existing.journal_id,org,o.branch_id,o.currency,v_existing.total,'delivery_invoice',v_existing.id) THEN RAISE EXCEPTION 'Saved delivery invoice lacks matching posted journal evidence; reconcile before replay'; END IF;
    RETURN jsonb_build_object('ok', true, 'already_billed', true,
      'invoice_id', v_existing.id, 'invoice_number', v_existing.invoice_number,
      'journal_id', v_existing.journal_id);
  END IF;

  IF o.grand_total::text IN ('NaN','Infinity','-Infinity') OR coalesce(o.subtotal,0)::text IN ('NaN','Infinity','-Infinity') OR coalesce(o.tax_total,0)::text IN ('NaN','Infinity','-Infinity') OR coalesce(o.service_charge_total,0)::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Delivery amounts must be finite'; END IF;
  IF EXISTS(SELECT 1 FROM public.journal_entries j WHERE j.organization_id=org AND j.source_document_id=o.id AND j.status='posted' AND j.reversed_by_journal_id IS NULL) THEN RAISE EXCEPTION 'Delivery already has financial recognition; reconcile existing evidence before issuing another invoice'; END IF;
  IF coalesce(o.discount_total,0)<0 OR coalesce(o.delivery_fee,0)<0 OR coalesce(o.tip_amount,0)<0 OR EXISTS(SELECT 1 FROM unnest(ARRAY[o.discount_total,o.delivery_fee,o.tip_amount]) value WHERE value::text IN ('NaN','Infinity','-Infinity')) THEN RAISE EXCEPTION 'Delivery discount, fee and tip must be finite and nonnegative'; END IF;
  v_method := lower(coalesce(o.payment_method, ''));
  v_paid := lower(coalesce(o.payment_status,'')) IN ('paid','settled','captured','completed');
  IF v_paid THEN RAISE EXCEPTION 'This delivery is already marked paid. Reconcile its existing receipt before creating a new receivable'; END IF;
  v_tax := coalesce(o.tax_total, 0);
  v_service_amount := coalesce(o.service_charge_total, 0);

  v_net_items := coalesce(o.subtotal,0) - coalesce(o.discount_total,0) - v_tax;
  v_revenue_credit := v_net_items + coalesce(o.delivery_fee,0);
  v_invoice_subtotal := v_revenue_credit + v_service_amount + coalesce(o.tip_amount,0);

  IF round(v_invoice_subtotal + v_tax, 2) <> round(coalesce(o.grand_total,0), 2) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'totals_mismatch',
      'detail', 'The order total does not equal its items, fee, service charge and tax.',
      'expected', round(v_invoice_subtotal + v_tax, 2), 'grand_total', coalesce(o.grand_total,0));
  END IF;

  SELECT a.id INTO v_revenue FROM public.chart_of_accounts a
   WHERE a.organization_id = org AND a.active AND coalesce(a.postable, true)
     AND a.name ILIKE 'Delivery Revenue'
   ORDER BY a.code LIMIT 1;
  IF v_revenue IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_revenue_account',
      'detail', 'This property has no active Delivery Revenue account.');
  END IF;

  IF coalesce(o.tip_amount,0)>0 THEN v_tip_account:=public.neo_tip_payable_account(org); END IF;

  IF v_tax > 0 THEN
    SELECT a.id INTO v_vat FROM public.chart_of_accounts a
     WHERE a.organization_id = org AND a.active AND coalesce(a.postable, true)
       AND a.name ILIKE '%VAT Payable%'
     ORDER BY a.code LIMIT 1;
    IF v_vat IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'no_vat_account',
        'detail', 'This order carries tax but the property has no VAT Payable account.');
    END IF;
  END IF;

  IF v_service_amount <> 0 THEN
    SELECT a.id INTO v_service FROM public.chart_of_accounts a
     WHERE a.organization_id = org AND a.active AND coalesce(a.postable, true)
       AND a.name ILIKE '%Service Charge%'
     ORDER BY a.code LIMIT 1;
    IF v_service IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'no_service_charge_account',
        'detail', 'This order carries a service charge but the property has no Service Charge account.');
    END IF;
  END IF;

  IF v_paid THEN
    SELECT a.id INTO v_debit FROM public.chart_of_accounts a
     WHERE a.organization_id = org AND a.active AND coalesce(a.postable, true)
       AND a.code = public.neo_gl_settlement_code_for(org, v_method)
     LIMIT 1;
  END IF;
  IF v_debit IS NULL THEN
    SELECT a.id INTO v_debit FROM public.chart_of_accounts a
     WHERE a.organization_id = org AND a.active AND coalesce(a.postable, true)
       AND a.name ILIKE 'Accounts Receivable'
     ORDER BY a.code LIMIT 1;
  END IF;
  IF v_debit IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_settlement_account',
      'detail', 'No account is configured to carry the money for this order.');
  END IF;

  v_number := public.next_document_number('invoice', NULL, o.branch_id);

  INSERT INTO public.invoices (organization_id, branch_id, invoice_number, document_type,
    customer_id, issue_date, currency, bill_to_snapshot, subtotal, discount_total, tax_total,
    total, amount_paid, balance, status, notes, created_by, issued_at)
  VALUES (org, o.branch_id, v_number, 'tax_invoice', o.customer_id, CURRENT_DATE,
    coalesce(o.currency,'KES'),
    jsonb_build_object('name', o.contact_name, 'phone', o.contact_phone,
                       'address', o.address_snapshot),
    v_invoice_subtotal + coalesce(o.discount_total,0), coalesce(o.discount_total,0), v_tax, coalesce(o.grand_total,0),
    CASE WHEN v_paid THEN coalesce(o.grand_total,0) ELSE 0 END,
    CASE WHEN v_paid THEN 0 ELSE coalesce(o.grand_total,0) END,
    'draft',
    'delivery-order:' || _order::text || ' · ' || o.order_number
      || coalesce(' · ' || nullif(btrim(coalesce(_reason,'')),''), ''),
    auth.uid(), now())
  RETURNING id INTO v_invoice;

  v_line := v_line + 1;
  INSERT INTO public.invoice_lines (organization_id, invoice_id, line_number, description,
    source_module, source_record_id, revenue_account_id, quantity, unit_price,
    discount_amount, tax_amount, net_amount, total_amount)
  VALUES (org, v_invoice, v_line, 'Delivery order ' || o.order_number || ' — food and beverage',
    'delivery', _order, v_revenue, 1, coalesce(o.subtotal,0), coalesce(o.discount_total,0),
    v_tax, v_net_items, v_net_items + v_tax);

  IF coalesce(o.delivery_fee,0) <> 0 THEN
    v_line := v_line + 1;
    INSERT INTO public.invoice_lines (organization_id, invoice_id, line_number, description,
      source_module, source_record_id, revenue_account_id, quantity, unit_price,
      net_amount, total_amount)
    VALUES (org, v_invoice, v_line, 'Delivery fee', 'delivery', _order, v_revenue, 1,
      o.delivery_fee, o.delivery_fee, o.delivery_fee);
  END IF;

  IF v_service_amount <> 0 THEN
    v_line := v_line + 1;
    INSERT INTO public.invoice_lines (organization_id, invoice_id, line_number, description,
      source_module, source_record_id, revenue_account_id, quantity, unit_price,
      net_amount, total_amount)
    VALUES (org, v_invoice, v_line, 'Service charge', 'delivery', _order, v_service, 1,
      v_service_amount, v_service_amount, v_service_amount);
  END IF;

  IF coalesce(o.tip_amount,0) <> 0 THEN
    v_line := v_line + 1;
    INSERT INTO public.invoice_lines (organization_id, invoice_id, line_number, description,
      source_module, source_record_id, revenue_account_id, quantity, unit_price,
      net_amount, total_amount)
    VALUES (org, v_invoice, v_line, 'Rider tip payable', 'delivery', _order, v_tip_account, 1,
      o.tip_amount, o.tip_amount, o.tip_amount);
  END IF;

  v_key := 'delivery-invoice:' || _order::text;
  v_jnum := public.next_document_number('journal');

  INSERT INTO public.journal_entries (organization_id, branch_id, journal_number, journal_type,
    accounting_date, source_module, source_document_type, source_document_id, document_number,
    idempotency_key, description, currency, created_by, status)
  VALUES (org, o.branch_id, v_jnum, 'automatic', CURRENT_DATE, 'delivery', 'delivery_invoice',
    v_invoice, v_number, v_key,
    'Delivery order ' || o.order_number || ' billed on invoice ' || v_number
      || coalesce(' — ' || nullif(btrim(coalesce(_reason,'')),''), ''),
    coalesce(o.currency,'KES'), auth.uid(), 'draft')
  RETURNING id INTO v_journal;

  v_jline := v_jline + 1;
  INSERT INTO public.journal_entry_lines (organization_id, journal_id, line_number, account_id,
    description, debit, credit, branch_id, customer_id, revenue_centre, payment_method)
  VALUES (org, v_journal, v_jline, v_debit,
    CASE WHEN v_paid THEN 'Delivery receipt ' || o.order_number
         ELSE 'Delivery receivable ' || o.order_number END,
    coalesce(o.grand_total,0), 0, o.branch_id, o.customer_id, 'delivery',
    nullif(v_method,''));

  v_jline := v_jline + 1;
  INSERT INTO public.journal_entry_lines (organization_id, journal_id, line_number, account_id,
    description, debit, credit, branch_id, customer_id, revenue_centre, payment_method)
  VALUES (org, v_journal, v_jline, v_revenue, 'Delivery revenue ' || o.order_number,
    0, v_revenue_credit, o.branch_id, o.customer_id, 'delivery', nullif(v_method,''));

  IF coalesce(o.tip_amount,0)>0 THEN
    v_jline:=v_jline+1;
    INSERT INTO public.journal_entry_lines(organization_id,journal_id,line_number,account_id,description,debit,credit,branch_id,customer_id,revenue_centre,payment_method)
    VALUES(org,v_journal,v_jline,v_tip_account,'Collected rider/staff tip payable',0,o.tip_amount,o.branch_id,o.customer_id,'delivery',nullif(v_method,''));
  END IF;

  IF v_service_amount <> 0 THEN
    v_jline := v_jline + 1;
    INSERT INTO public.journal_entry_lines (organization_id, journal_id, line_number, account_id,
      description, debit, credit, branch_id, customer_id, revenue_centre, payment_method)
    VALUES (org, v_journal, v_jline, v_service, 'Service charge on ' || o.order_number,
      0, v_service_amount, o.branch_id, o.customer_id, 'delivery', nullif(v_method,''));
  END IF;

  IF v_tax > 0 THEN
    v_jline := v_jline + 1;
    INSERT INTO public.journal_entry_lines (organization_id, journal_id, line_number, account_id,
      description, debit, credit, branch_id, customer_id, revenue_centre, payment_method)
    VALUES (org, v_journal, v_jline, v_vat, 'Output VAT on ' || o.order_number,
      0, v_tax, o.branch_id, o.customer_id, 'delivery', nullif(v_method,''));
  END IF;

  v_prior:=coalesce(current_setting('neo.system_posting',true),'off');
  BEGIN PERFORM set_config('neo.system_posting','on',true);PERFORM public.fin_post_journal(v_journal);PERFORM set_config('neo.system_posting',v_prior,true);EXCEPTION WHEN OTHERS THEN PERFORM set_config('neo.system_posting',v_prior,true);RAISE;END;
  IF NOT public.neo_connection_journal_matches(v_journal,org,o.branch_id,o.currency,o.grand_total,'delivery_invoice',v_invoice) THEN RAISE EXCEPTION 'Delivery invoice did not produce a matching balanced posted journal'; END IF;

  UPDATE public.invoices SET status='issued',journal_id = v_journal, updated_at = now() WHERE id = v_invoice;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, user_name, action, module,
    record_id, previous_value, new_value, reason)
  VALUES (org, o.branch_id, auth.uid(),
    coalesce((SELECT full_name FROM public.profiles WHERE id = auth.uid()), ''),
    'delivery.billed', 'delivery', o.order_number,
    jsonb_build_object('payment_status', o.payment_status),
    jsonb_build_object('invoice_number', v_number, 'journal_number', v_jnum,
      'total', o.grand_total, 'settled', v_paid,
      'service_charge', v_service_amount, 'delivery_fee', coalesce(o.delivery_fee,0)),
    nullif(btrim(coalesce(_reason,'')),''));

  RETURN jsonb_build_object('ok', true, 'invoice_id', v_invoice, 'invoice_number', v_number,
    'journal_id', v_journal, 'journal_number', v_jnum, 'settled', v_paid,
    'total', coalesce(o.grand_total,0), 'delivery_fee', coalesce(o.delivery_fee,0),
    'service_charge', v_service_amount);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.neo_finance_post_txn(_source_type text, _source_id uuid, _silent boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  org uuid := public.current_org_id();
  branch uuid; cur text; ref text; occurred date; amount numeric := 0;
  posting text := 'revenue'; lines jsonb := '[]'::jsonb; res jsonb;
  customer uuid; net numeric; tax numeric; svc numeric; settle text; tip_account uuid; tip_code text;
  o public.pos_orders; fl public.folio_lines; pay public.payments;
  ev public.event_bookings; inv public.invoices; si public.supplier_invoices;
  sp public.supplier_payments; lo public.guest_laundry_orders; deliv record;
  paid numeric; remainder numeric; key text; refund_deposit_source public.reservation_deposits; refund_deposit_journal uuid;
BEGIN
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT _silent AND NOT (public.is_org_admin()
        OR public.has_permission('finance','edit') OR public.has_permission('finance','approve')) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(_source_type || ':' || _source_id::text, 0));

  IF _source_type = 'pos_order' THEN
    SELECT * INTO o FROM public.pos_orders
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF o.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    IF EXISTS(SELECT 1 FROM public.delivery_orders d WHERE d.pos_order_id=o.id AND d.organization_id=org AND d.payment_method='room-charge') THEN
      RETURN public.neo_finance_post_txn('delivery_order',(SELECT d.id FROM public.delivery_orders d WHERE d.pos_order_id=o.id AND d.organization_id=org),true);
    END IF;
    IF EXISTS(SELECT 1 FROM public.delivery_orders d WHERE d.pos_order_id=o.id AND d.organization_id=org) THEN
      SELECT i.* INTO inv FROM public.invoices i JOIN public.delivery_orders d ON i.notes LIKE 'delivery-order:'||d.id::text||'%' AND i.organization_id=d.organization_id WHERE d.pos_order_id=o.id AND d.organization_id=org ORDER BY i.created_at LIMIT 1;
      IF inv.id IS NOT NULL AND inv.branch_id IS NOT DISTINCT FROM o.branch_id AND public.neo_connection_journal_matches(inv.journal_id,org,inv.branch_id,inv.currency,inv.total,'delivery_invoice',inv.id) THEN RETURN jsonb_build_object('ok',true,'journal_id',inv.journal_id,'duplicate_prevented',true,'posting_type','invoice','amount',inv.total); END IF;
      RETURN jsonb_build_object('ok',false,'reason','delivery_source_owns_posting','detail','This production order is accounted for by its linked delivery, not a second POS sale.');
    END IF;
    branch := o.branch_id; ref := o.order_number; customer := o.customer_id;
    occurred := (coalesce(o.closed_at, o.created_at))::date; amount := coalesce(o.grand_total,0);
    IF o.status NOT IN ('closed','paid','settled','completed','charged-to-room') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle',
        'detail', 'Order is ' || o.status || '. Draft, sent, ready and served orders are not revenue.');
    END IF;

    IF o.folio_id IS NOT NULL THEN
      posting := 'room_charge';
      res := public.neo_post_pos_order(o.id);
      PERFORM public.neo_record_posting_receipt(org, branch, 'pos', o.id, ref,
        CASE WHEN coalesce((res->>'ok')::boolean,false) THEN 'posted' ELSE 'blocked' END,
        amount, public.neo_fact_currency(org, branch), nullif(res->>'folio_line_id','')::uuid,
        'Routed to folio ' || o.folio_id::text || ' - revenue is recognised on the folio charge, not on the order.',
        NULL, occurred);
      UPDATE public.finance_posting_receipts SET posting_type = posting
        WHERE organization_id = org AND idempotency_key = 'pos:' || o.id::text;
      SELECT coalesce(res,'{}'::jsonb) || jsonb_build_object(
        'posting_type',posting,'posting_receipt_id',r.id,'folio_line_id',r.folio_line_id,'journal_id',r.journal_id,
        'ok',r.status='posted' AND r.folio_line_id IS NOT NULL AND r.journal_id IS NOT NULL,
        'reason',CASE WHEN r.status='posted' AND r.folio_line_id IS NOT NULL AND r.journal_id IS NOT NULL
                     THEN 'room_charge_reconciled' ELSE 'room_charge_journal_unverified' END)
      INTO res FROM public.finance_posting_receipts r
      WHERE r.organization_id=org AND r.idempotency_key='pos:'||o.id::text;
      RETURN coalesce(res,jsonb_build_object('ok',false,'reason','room_charge_receipt_missing'));
    END IF;

    tax := coalesce(o.tax_total,0); svc := coalesce(o.service_charge_total,0);
    amount := greatest(coalesce(o.grand_total,0),
                       coalesce(o.subtotal,0) - coalesce(o.discount_total,0));
    net := amount - tax - svc;
    IF o.corporate_account_id IS NOT NULL AND coalesce(o.paid_total,0) < amount THEN
      settle := '1060';
    ELSE
      -- The money account follows the receipt: the account the cashier chose,
      -- otherwise the account this property uses for that tender.
      SELECT public.neo_gl_account_code(org, p.method, p.destination_account_id) INTO settle
        FROM public.pos_payments p WHERE p.order_id = o.id
         AND p.status IN ('confirmed','paid','completed','captured','settled')
        ORDER BY p.amount DESC LIMIT 1;
      settle := coalesce(settle, public.neo_gl_settlement_code_for(org, 'cash'), '1010');
    END IF;
    lines := jsonb_build_array(
      jsonb_build_object('code', settle, 'debit', amount, 'description', 'Settlement ' || coalesce(ref,'')),
      jsonb_build_object('code', public.neo_gl_revenue_code_scoped(org, o.order_type, NULL), 'credit', net),
      jsonb_build_object('code', '2040', 'credit', tax, 'description', 'VAT'),
      jsonb_build_object('code', '2050', 'credit', svc, 'description', 'Service charge'));

  ELSIF _source_type = 'folio_charge' THEN
    SELECT * INTO fl FROM public.folio_lines
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF fl.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := fl.branch_id; ref := coalesce(fl.reference, fl.description); customer := fl.customer_id;
    occurred := coalesce(fl.operational_date, fl.posting_date::date);
    IF fl.status <> 'posted' OR coalesce(fl.line_type,'charge') = 'payment' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle',
        'detail', 'Only posted folio charges are recognised.');
    END IF;
    tax := coalesce(fl.tax_amount,0);
    svc := coalesce(fl.service_charge_amount,0);
    amount := coalesce(fl.gross_amount,0) - coalesce(fl.discount_amount,0) + tax + svc;
    IF fl.category='gratuity' THEN posting:='gratuity-liability'; END IF;
    net := coalesce(fl.gross_amount,0) - coalesce(fl.discount_amount,0);
    IF fl.category='gratuity' THEN
      tip_account:=public.neo_tip_payable_account(org);
      SELECT a.code INTO tip_code FROM public.chart_of_accounts a WHERE a.id=tip_account;
    END IF;
    IF amount <= 0 THEN RETURN jsonb_build_object('ok', false, 'reason', 'zero_amount'); END IF;
    lines := jsonb_build_array(
      jsonb_build_object('code', '1060', 'debit', amount, 'description', 'Guest ledger ' || coalesce(ref,'')),
      jsonb_build_object('code', CASE WHEN fl.category='gratuity' THEN tip_code ELSE public.neo_gl_revenue_code_scoped(org, fl.category, fl.revenue_centre) END, 'credit', net),
      jsonb_build_object('code', '2040', 'credit', tax, 'description', 'VAT'),
      jsonb_build_object('code', '2050', 'credit', svc, 'description', 'Service charge'));

  ELSIF _source_type = 'folio_payment' THEN
    SELECT * INTO pay FROM public.payments
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF pay.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := pay.branch_id; ref := pay.receipt_number; customer := pay.customer_id;
    occurred := coalesce(pay.paid_at, pay.created_at)::date; amount := coalesce(pay.amount,0);
    posting := 'collection';
    IF coalesce(pay.status,'') NOT IN ('confirmed','completed','paid','succeeded','captured') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle',
        'detail', 'Only confirmed receipts reduce the outstanding balance.');
    END IF;
    SELECT * INTO refund_deposit_source FROM public.reservation_deposits d WHERE d.payment_id=pay.id AND d.organization_id=org AND d.status IN ('held','applied');
    IF refund_deposit_source.id IS NOT NULL THEN
      IF refund_deposit_source.amount IS DISTINCT FROM amount THEN RAISE EXCEPTION 'Original deposit receipt amount differs'; END IF;
      SELECT j.id INTO refund_deposit_journal FROM public.journal_entries j WHERE public.neo_connection_journal_matches(j.id,org,branch,pay.currency,amount,'reservation_deposit:deposit',refund_deposit_source.id) LIMIT 1;
      IF refund_deposit_journal IS NULL THEN RAISE EXCEPTION 'Original deposit receipt requires its posted liability journal'; END IF;
      RETURN jsonb_build_object('ok',true,'journal_id',refund_deposit_journal,'duplicate_prevented',true,'posting_type','deposit','amount',amount);
    END IF;
    IF pay.source_module='cash_refund' THEN
      IF NOT public.neo_cash_refund_payment_valid(pay.id) THEN RAISE EXCEPTION 'Refund receipt requires its settled original-receipt link and matching posted journal'; END IF;
      PERFORM public.neo_record_posting_receipt(org,branch,_source_type,_source_id,ref,'posted',amount,pay.currency,NULL,'Verified separately linked refund payout journal',NULL,occurred);
      UPDATE public.finance_posting_receipts SET posting_type='refund',journal_id=pay.posted_journal_id WHERE organization_id=org AND source_module=_source_type AND source_id=_source_id;
      RETURN jsonb_build_object('ok',true,'journal_id',pay.posted_journal_id,'duplicate_prevented',true,'amount',amount,'posting_type','refund');
    END IF;
    IF pay.source_module='delivery' AND pay.posted_journal_id IS NOT NULL THEN
      IF NOT EXISTS(SELECT 1 FROM public.journal_entries j WHERE j.id=pay.posted_journal_id AND j.organization_id=org AND j.branch_id IS NOT DISTINCT FROM branch AND j.status='posted' AND j.source_module='delivery' AND j.source_document_type='delivery_payment' AND j.source_document_id=pay.id AND j.currency=pay.currency AND j.total_debit=amount AND j.total_credit=amount AND amount>0 AND amount::text NOT IN ('NaN','Infinity','-Infinity') AND NOT EXISTS(SELECT 1 FROM public.journal_entry_lines l WHERE l.journal_id=j.id AND (l.organization_id IS DISTINCT FROM org OR l.branch_id IS DISTINCT FROM branch)) AND (SELECT coalesce(sum(l.debit),0) FROM public.journal_entry_lines l WHERE l.journal_id=j.id)=amount AND (SELECT coalesce(sum(l.credit),0) FROM public.journal_entry_lines l WHERE l.journal_id=j.id)=amount) THEN RAISE EXCEPTION 'Delivery payment journal evidence is incomplete'; END IF;
      PERFORM public.neo_record_posting_receipt(org,branch,_source_type,_source_id,ref,'posted',amount,pay.currency,NULL,'Existing delivery receipt journal verified',NULL,occurred);
      UPDATE public.finance_posting_receipts SET posting_type='collection',journal_id=pay.posted_journal_id WHERE organization_id=org AND source_module=_source_type AND source_id=_source_id;
      RETURN jsonb_build_object('ok',true,'journal_id',pay.posted_journal_id,'duplicate_prevented',true,'amount',amount,'posting_type','collection');
    END IF;
    IF amount = 0 THEN RETURN jsonb_build_object('ok', false, 'reason', 'zero_amount'); END IF;
    lines := jsonb_build_array(
      jsonb_build_object('code', public.neo_gl_account_code(org, pay.method, pay.destination_account_id),
                         'debit', amount, 'description', 'Receipt ' || coalesce(ref,'')),
      jsonb_build_object('code', '1060', 'credit', amount, 'description', 'Guest / customer ledger'));

  ELSIF _source_type = 'event_deposit' THEN
    SELECT * INTO ev FROM public.event_bookings
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF ev.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := ev.branch_id; ref := ev.event_reference; customer := ev.customer_id;
    occurred := coalesce(ev.confirmed_at::date, ev.event_date); posting := 'deposit';
    amount := coalesce(ev.deposit_paid, 0);
    IF amount <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle',
        'detail', 'No deposit has been received. Forecast is never revenue.');
    END IF;
    SELECT public.neo_gl_account_code(org, p.method, p.destination_account_id) INTO settle
      FROM public.payments p
     WHERE p.organization_id = org AND p.source_module = 'events' AND p.source_record_id = ev.id
       AND coalesce(p.status,'') IN ('confirmed','completed','paid','succeeded','captured')
     ORDER BY p.amount DESC LIMIT 1;
    settle := coalesce(settle, public.neo_gl_settlement_code_for(org, 'cash'), '1010');
    lines := jsonb_build_array(
      jsonb_build_object('code', settle, 'debit', amount, 'description', 'Event deposit ' || coalesce(ref,'')),
      jsonb_build_object('code', '2030', 'credit', amount, 'description', 'Event deposit held'));

  ELSIF _source_type = 'event_invoice' THEN
    SELECT * INTO inv FROM public.invoices
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF inv.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := inv.branch_id; ref := inv.invoice_number; customer := inv.customer_id;
    occurred := inv.issue_date; posting := 'invoice'; amount := coalesce(inv.total,0);
    IF coalesce(inv.status,'draft') NOT IN ('issued','sent','partially_paid','paid','overdue') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle',
        'detail', 'Draft and cancelled invoices are not receivables.');
    END IF;
    IF inv.notes LIKE 'delivery-order:%' THEN
      IF NOT public.neo_connection_journal_matches(inv.journal_id,org,branch,inv.currency,amount,'delivery_invoice',inv.id) THEN RAISE EXCEPTION 'Delivery invoice journal evidence needs review'; END IF;
      RETURN jsonb_build_object('ok',true,'journal_id',inv.journal_id,'duplicate_prevented',true,'posting_type','invoice','amount',amount);
    END IF;
    net := coalesce(inv.subtotal,0) - coalesce(inv.discount_total,0);
    lines := jsonb_build_array(
      jsonb_build_object('code', '1060', 'debit', amount, 'description', 'Invoice ' || coalesce(ref,'')),
      jsonb_build_object('code', CASE WHEN inv.event_booking_id IS NOT NULL THEN public.neo_gl_revenue_code_scoped(org, 'events', NULL) ELSE '4090' END,
                         'credit', net),
      jsonb_build_object('code', '2050', 'credit', coalesce(inv.service_charge_total,0),
                         'description', 'Service charge'),
      jsonb_build_object('code', '2040', 'credit', coalesce(inv.tax_total,0), 'description', 'VAT'));

  ELSIF _source_type = 'event_earned' THEN
    SELECT * INTO ev FROM public.event_bookings
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF ev.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := ev.branch_id; ref := ev.event_reference; customer := ev.customer_id;
    occurred := ev.event_date; posting := 'earned'; amount := coalesce(ev.total_amount,0);
    IF ev.status NOT IN ('completed','closed') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle',
        'detail', 'Event is ' || ev.status || '. Confirmed and provisional bookings are forecast, not revenue.');
    END IF;
    IF amount <= 0 THEN RETURN jsonb_build_object('ok', false, 'reason', 'zero_amount'); END IF;
    paid := least(coalesce(ev.deposit_paid,0), amount);
    remainder := amount - paid;
    lines := jsonb_build_array(
      jsonb_build_object('code', '2030', 'debit', paid, 'description', 'Deposit applied'),
      jsonb_build_object('code', '1060', 'debit', remainder, 'description', 'Event receivable'),
      jsonb_build_object('code', public.neo_gl_revenue_code_scoped(org, 'events', NULL), 'credit', amount, 'description', 'Event revenue ' || coalesce(ref,'')));

  ELSIF _source_type = 'event_cancellation' THEN
    SELECT * INTO ev FROM public.event_bookings
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF ev.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := ev.branch_id; ref := ev.event_reference; customer := ev.customer_id;
    occurred := coalesce(ev.cancelled_at::date, ev.event_date); posting := 'cancellation';
    IF ev.status <> 'cancelled' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle');
    END IF;
    PERFORM public.neo_finance_reverse_posting('event_earned', ev.id, 'earned', 'Event cancelled');
    amount := coalesce(ev.cancellation_fee, 0);
    paid := coalesce(ev.deposit_paid, 0);
    remainder := greatest(paid - amount, 0);
    IF amount = 0 AND remainder = 0 THEN
      RETURN jsonb_build_object('ok', true, 'reason', 'nothing_to_recognise');
    END IF;
    SELECT public.neo_gl_account_code(org, p.method, p.destination_account_id) INTO settle
      FROM public.payments p
     WHERE p.organization_id = org AND p.source_module = 'events' AND p.source_record_id = ev.id
     ORDER BY p.amount DESC LIMIT 1;
    settle := coalesce(settle, public.neo_gl_settlement_code_for(org, 'cash'), '1010');
    lines := jsonb_build_array(
      jsonb_build_object('code', '2030', 'debit', paid, 'description', 'Deposit released'),
      jsonb_build_object('code', '1060', 'debit', greatest(amount - paid, 0),
                         'description', 'Cancellation receivable'),
      jsonb_build_object('code', public.neo_gl_revenue_code_scoped(org, 'events', NULL), 'credit', amount, 'description', 'Cancellation fee ' || coalesce(ref,'')),
      jsonb_build_object('code', settle, 'credit', remainder, 'description', 'Refund to client'));
    amount := greatest(amount, paid);

  ELSIF _source_type = 'delivery_order' THEN
    SELECT d.id, d.branch_id, d.order_number, d.customer_id, d.grand_total, d.tax_total,
           d.order_status, d.payment_status, d.payment_method, d.delivered_at, d.created_at,
           d.pos_order_id,d.fulfilment_type,d.service_charge_total,d.tip_amount,d.currency
      INTO deliv FROM public.delivery_orders d
      WHERE d.id = _source_id AND d.organization_id = org FOR UPDATE;
    IF deliv.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := deliv.branch_id; ref := deliv.order_number; customer := deliv.customer_id;
    occurred := coalesce(deliv.delivered_at, deliv.created_at)::date;
    amount := coalesce(deliv.grand_total,0); tax := coalesce(deliv.tax_total,0);
    IF deliv.payment_method='room-charge' THEN
      SELECT * INTO o FROM public.pos_orders WHERE id=deliv.pos_order_id AND organization_id=org;
      IF o.id IS NULL OR o.folio_id IS NULL OR o.folio_post_status IS DISTINCT FROM 'posted' THEN
        RETURN jsonb_build_object('ok',false,'reason','awaiting_room_folio','detail','Room service must reach its saved guest folio before Finance completion.');
      END IF;
      SELECT coalesce(sum(f.net_amount),0) INTO paid FROM public.folio_lines f
       WHERE f.organization_id=org AND f.folio_id=o.folio_id AND f.status='posted'
         AND f.source_record_uuid=o.id AND f.source_module='pos_order'
         AND f.idempotency_key IN ('guest_room_service:'||o.id::text,'guest_room_service_tip:'||o.id::text);
      IF paid IS DISTINCT FROM amount OR NOT EXISTS(SELECT 1 FROM public.folio_lines f
          WHERE f.organization_id=org AND f.folio_id=o.folio_id AND f.status='posted' AND f.source_record_uuid=o.id
            AND f.idempotency_key='guest_room_service:'||o.id::text)
        OR EXISTS(SELECT 1 FROM public.folio_lines f WHERE f.organization_id=org AND f.folio_id=o.folio_id
          AND f.status='posted' AND f.source_record_uuid=o.id AND f.source_module='pos_order'
          AND f.idempotency_key IN ('guest_room_service:'||o.id::text,'guest_room_service_tip:'||o.id::text)
          AND f.net_amount>0 AND NOT EXISTS(SELECT 1 FROM public.journal_entries j WHERE j.organization_id=org
            AND j.branch_id IS NOT DISTINCT FROM o.branch_id AND j.source_document_id=f.id
            AND j.source_document_type='folio_charge:'||CASE WHEN f.category='gratuity' THEN 'gratuity-liability' ELSE 'revenue' END
            AND j.status='posted' AND j.reversed_by_journal_id IS NULL AND j.currency=o.currency
            AND j.total_debit=f.net_amount AND j.total_credit=f.net_amount
            AND (SELECT coalesce(sum(l.debit),0) FROM public.journal_entry_lines l WHERE l.journal_id=j.id)=f.net_amount
            AND (SELECT coalesce(sum(l.credit),0) FROM public.journal_entry_lines l WHERE l.journal_id=j.id)=f.net_amount
            AND NOT EXISTS(SELECT 1 FROM public.journal_entry_lines l LEFT JOIN public.chart_of_accounts a ON a.id=l.account_id
              WHERE l.journal_id=j.id AND (l.organization_id IS DISTINCT FROM org OR l.branch_id IS DISTINCT FROM o.branch_id
                OR a.organization_id IS DISTINCT FROM org OR l.debit IS NULL OR l.credit IS NULL OR l.debit<0 OR l.credit<0
                OR (l.debit>0 AND l.credit>0) OR l.debit::text IN ('NaN','Infinity','-Infinity') OR l.credit::text IN ('NaN','Infinity','-Infinity'))))) THEN
        RETURN jsonb_build_object('ok',false,'reason','awaiting_folio_journals','detail','The saved folio amounts or their posted journals need reconciliation; no second sale was posted.');
      END IF;
      PERFORM public.neo_record_posting_receipt(org,branch,_source_type,_source_id,ref,'posted',amount,o.currency,NULL,
        'Recognised through guest folio; no duplicate delivery sale',NULL,occurred);
      UPDATE public.finance_posting_receipts SET posting_type='folio-transfer',journal_id=NULL
        WHERE organization_id=org AND source_module=_source_type AND source_id=_source_id;
      RETURN jsonb_build_object('ok',true,'posting_type','folio-transfer','folio_id',o.folio_id,'amount',amount,'duplicate_prevented',true);
    END IF;
    IF deliv.order_status NOT IN ('delivered','completed') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle',
        'detail', 'Only completed deliveries are recognised.');
    END IF;
    SELECT * INTO inv FROM public.invoices i WHERE i.organization_id=org AND i.notes LIKE 'delivery-order:'||deliv.id::text||'%' ORDER BY i.created_at LIMIT 1;
    IF inv.id IS NOT NULL THEN
      IF inv.branch_id IS DISTINCT FROM branch OR inv.currency IS DISTINCT FROM public.neo_fact_currency(org,branch) OR inv.total IS DISTINCT FROM amount OR NOT public.neo_connection_journal_matches(inv.journal_id,org,branch,inv.currency,amount,'delivery_invoice',inv.id) THEN RAISE EXCEPTION 'Completed delivery invoice evidence needs review'; END IF;
      RETURN jsonb_build_object('ok',true,'journal_id',inv.journal_id,'duplicate_prevented',true,'posting_type','invoice','amount',amount);
    END IF;
    IF deliv.payment_status IN ('paid','settled','completed') THEN
      SELECT public.neo_gl_account_code(org, coalesce(p.method, deliv.payment_method), p.destination_account_id)
        INTO settle
        FROM public.payments p
       WHERE p.organization_id = org AND p.source_module = 'delivery' AND p.source_record_id = deliv.id
         AND coalesce(p.status,'') IN ('confirmed','completed','paid','succeeded','captured')
       ORDER BY p.amount DESC LIMIT 1;
      settle := coalesce(settle, public.neo_gl_account_code(org, deliv.payment_method, NULL), '1010');
    ELSE
      settle := '1060';
    END IF;
    IF coalesce(deliv.tip_amount,0)>0 THEN
      tip_account:=public.neo_tip_payable_account(org);
      SELECT a.code INTO tip_code FROM public.chart_of_accounts a WHERE a.id=tip_account;
    END IF;
    lines := jsonb_build_array(
      jsonb_build_object('code', settle, 'debit', amount, 'description', 'Delivery ' || coalesce(ref,'')),
      jsonb_build_object('code', public.neo_gl_revenue_code_scoped(org,'delivery',NULL), 'credit', amount-tax-coalesce(deliv.service_charge_total,0)-coalesce(deliv.tip_amount,0)),
      jsonb_build_object('code', '2040', 'credit', tax, 'description', 'VAT'),
      jsonb_build_object('code', '2050', 'credit', coalesce(deliv.service_charge_total,0), 'description', 'Service charge'));
    IF coalesce(deliv.tip_amount,0)>0 THEN
      lines:=lines||jsonb_build_array(jsonb_build_object('code',tip_code,
        'credit',deliv.tip_amount,'description','Collected rider/staff tips payable'));
    END IF;

  ELSIF _source_type = 'laundry_order' THEN
    SELECT * INTO lo FROM public.guest_laundry_orders
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF lo.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := lo.branch_id; ref := lo.laundry_number;
    occurred := coalesce(lo.delivered_at, lo.created_at)::date; amount := coalesce(lo.total,0);
    IF lo.status NOT IN ('delivered','completed','closed') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle',
        'detail', 'Only completed laundry orders are recognised.');
    END IF;
    IF lo.folio_id IS NULL AND (lo.reservation_id IS NOT NULL OR lo.resident IS TRUE) THEN
      RETURN jsonb_build_object('ok',false,'reason','resident_laundry_missing_folio',
        'detail','Resident laundry must reach a guest folio; it cannot be treated as an assumed cash collection.');
    END IF;
    IF lo.folio_id IS NOT NULL THEN
      posting := 'folio_charge';
      res := public.laundry_post_charge(lo.id);
      PERFORM public.neo_record_posting_receipt(org, branch, 'laundry', lo.id, ref,
        CASE WHEN coalesce((res->>'ok')::boolean,false) THEN 'posted' ELSE 'blocked' END,
        amount, public.neo_fact_currency(org, branch), nullif(res->>'folio_line_id','')::uuid,
        'Charged to the guest folio - revenue is recognised on the folio charge.', NULL, occurred);
      UPDATE public.finance_posting_receipts SET posting_type = posting
        WHERE organization_id = org AND source_module = 'laundry' AND source_id = lo.id;
      RETURN coalesce(res,'{}'::jsonb) || jsonb_build_object('posting_type', posting);
    END IF;
    tax := coalesce(lo.tax_amount,0);
    settle := coalesce(public.neo_gl_settlement_code_for(org, 'cash'), '1010');
    lines := jsonb_build_array(
      jsonb_build_object('code', settle, 'debit', amount, 'description', 'Laundry ' || coalesce(ref,'')),
      jsonb_build_object('code', public.neo_gl_revenue_code_scoped(org, 'laundry', NULL), 'credit', amount - tax),
      jsonb_build_object('code', '2040', 'credit', tax, 'description', 'VAT'));

  ELSIF _source_type = 'supplier_invoice' THEN
    SELECT * INTO si FROM public.supplier_invoices
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF si.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := si.branch_id; ref := si.invoice_number; occurred := si.invoice_date;
    amount := coalesce(si.amount,0); tax := coalesce(si.tax_amount,0); posting := 'payable';
    IF si.approved_at IS NULL OR si.status NOT IN ('approved','matched','partially_paid','paid') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle',
        'detail', 'Only approved supplier invoices become payables. Requests and purchase orders do not.');
    END IF;
    lines := jsonb_build_array(
      jsonb_build_object('code', '1070', 'debit', amount - tax, 'description', 'Goods / services received'),
      jsonb_build_object('code', '2040', 'debit', tax, 'description', 'Input VAT'),
      jsonb_build_object('code', '2010', 'credit', amount, 'description', 'Supplier invoice ' || coalesce(ref,'')));

  ELSIF _source_type = 'supplier_payment' THEN
    SELECT * INTO sp FROM public.supplier_payments
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF sp.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := sp.branch_id; ref := sp.payment_number; occurred := sp.paid_on;
    amount := coalesce(sp.amount,0); posting := 'payable_payment';
    IF sp.status NOT IN ('paid','completed','settled') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle');
    END IF;
    -- Money leaves the account the hotel actually paid from.
    lines := jsonb_build_array(
      jsonb_build_object('code', '2010', 'debit', amount, 'description', 'Supplier payment ' || coalesce(ref,'')),
      jsonb_build_object('code', public.neo_gl_account_code(org, sp.method, sp.bank_account_id),
                         'credit', amount));

  ELSE
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_source_type');
  END IF;

  cur := public.neo_fact_currency(org, branch);
  occurred := coalesce(occurred, (now() AT TIME ZONE public.neo_fact_timezone(org, branch))::date);
  key := _source_type || ':' || _source_id::text || ':' || posting;

  res := public.neo_gl_post(org, branch, split_part(_source_type,'_',1), _source_type, _source_id,
                            posting, occurred, cur,
                            initcap(replace(_source_type,'_',' ')) || ' ' || coalesce(ref,''),
                            lines, customer, NULL);

  -- A duplicate key or ok flag alone is not evidence of a completed posting.
  IF res->>'ok' IS DISTINCT FROM 'true' OR NOT EXISTS(
    SELECT 1 FROM public.journal_entries j
    CROSS JOIN LATERAL(SELECT coalesce(sum(l.debit),0) AS d,coalesce(sum(l.credit),0) AS c
      FROM public.journal_entry_lines l WHERE l.journal_id=j.id) actual
    WHERE j.id=nullif(res->>'journal_id','')::uuid AND j.organization_id=org
      AND j.branch_id IS NOT DISTINCT FROM branch AND j.status='posted'
      AND j.reversed_by_journal_id IS NULL AND j.currency=cur
      AND j.source_document_id=_source_id AND j.source_document_type=_source_type||':'||posting
      AND actual.d=round(amount,2) AND actual.c=round(amount,2)
      AND j.total_debit=actual.d AND j.total_credit=actual.c
      AND NOT EXISTS(SELECT 1 FROM public.journal_entry_lines l WHERE l.journal_id=j.id
        AND (l.organization_id IS DISTINCT FROM org OR l.branch_id IS DISTINCT FROM branch))
  ) THEN
    RAISE EXCEPTION 'Posting did not produce a matching balanced posted journal' USING ERRCODE='23514';
  END IF;

  PERFORM public.neo_record_posting_receipt(org, branch, _source_type, _source_id, ref,
    'posted', amount, cur, NULL,
    CASE WHEN coalesce((res->>'duplicate_prevented')::boolean,false)
         THEN 'Duplicate replay prevented - the existing journal was reused.'
         ELSE 'Posted to journal ' || (res->>'journal_id') END,
    NULL, occurred);

  UPDATE public.finance_posting_receipts
     SET posting_type = posting, journal_id = (res->>'journal_id')::uuid
   WHERE organization_id = org AND source_module = _source_type AND source_id = _source_id;

  PERFORM public.emit_domain_event(org, branch, 'finance.posted', _source_type, _source_id,
    jsonb_build_object('posting_type', posting, 'amount', amount, 'currency', cur,
                       'journal_id', res->>'journal_id', 'occurred_on', occurred),
    'finance.posted:' || key, customer);

  RETURN res || jsonb_build_object('source_type', _source_type, 'source_id', _source_id,
                                   'posting_type', posting, 'amount', amount);
EXCEPTION WHEN OTHERS THEN
  PERFORM public.neo_record_posting_receipt(org, branch, _source_type, _source_id, ref,
    'failed', amount, coalesce(cur,'KES'), NULL, NULL, SQLERRM, occurred);
  IF _silent THEN RETURN jsonb_build_object('ok', false, 'reason', 'failed', 'detail', SQLERRM); END IF;
  RAISE;
END $function$
;

CREATE OR REPLACE FUNCTION public.neo_delivery_guest_mpesa_start(_order uuid, _msisdn text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _d public.delivery_orders;
  _o public.pos_orders;
  _confirmed numeric := 0;
  _active numeric := 0;
  _due numeric;
  _payment uuid;
  _txn uuid;
  _ref text;
  _digits text;
  _env text;
  _code text;
BEGIN
  SELECT * INTO _d FROM public.delivery_orders WHERE id = _order;
  IF _d.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF NOT public.customer_owns_delivery(_d.id) THEN
    RAISE EXCEPTION 'That order does not belong to you';
  END IF;
  IF coalesce(_d.payment_method, '') <> 'mpesa' THEN
    RAISE EXCEPTION 'This order is not set to be paid by M-Pesa';
  END IF;


  _digits := regexp_replace(coalesce(nullif(btrim(coalesce(_msisdn, '')), ''), coalesce(_d.contact_phone, '')), '[^0-9]', '', 'g');
  IF length(_digits) < 9 THEN RAISE EXCEPTION 'A valid mobile number is required'; END IF;

  SELECT * INTO _o FROM public.pos_orders WHERE id = _d.pos_order_id FOR UPDATE;
  IF _o.id IS NULL THEN RAISE EXCEPTION 'Bill not found for this order'; END IF;
  IF _o.organization_id IS DISTINCT FROM _d.organization_id OR _o.branch_id IS DISTINCT FROM _d.branch_id
     OR _o.customer_id IS DISTINCT FROM _d.customer_id OR _o.currency IS DISTINCT FROM _d.currency
     OR _o.currency IS DISTINCT FROM 'KES' OR public.neo_fact_currency(_d.organization_id,_d.branch_id) IS DISTINCT FROM 'KES' THEN
    RAISE EXCEPTION 'M-Pesa requires matching guest/property links and a verified KES bill';
  END IF;
  IF _o.grand_total IS NULL OR _o.grand_total<=0 OR _o.grand_total::text IN ('NaN','Infinity','-Infinity')
     OR _d.grand_total IS DISTINCT FROM _o.grand_total THEN
    RAISE EXCEPTION 'Delivery and POS totals do not agree; reconcile the existing bill before collecting';
  END IF;
  IF _o.status IN ('cancelled','voided') OR _d.order_status IN ('cancelled','rejected','failed','refunded') THEN
    RAISE EXCEPTION 'This order cannot start another collection';
  END IF;
  IF EXISTS(SELECT 1 FROM public.mpesa_transactions t JOIN public.pos_payments p ON p.id=t.payment_id AND p.organization_id=t.organization_id
    WHERE p.order_id=_o.id AND t.organization_id=_o.organization_id AND t.payment_table='pos_payments'
      AND (t.status IN ('initiated','pending','unknown') OR (t.status='success' AND p.status IS DISTINCT FROM 'confirmed'))) THEN
    RETURN jsonb_build_object('already_paid',false,'pending',true,'order_id',_d.id,
      'detail','An existing provider attempt is unresolved. Check it before starting another prompt.');
  END IF;

  SELECT coalesce(sum(amount) FILTER (WHERE status = 'confirmed'), 0),
         coalesce(sum(amount) FILTER (WHERE status IN ('initiated','pending')), 0)
    INTO _confirmed, _active
    FROM public.pos_payments WHERE order_id = _o.id;

  IF _confirmed::text IN ('NaN','Infinity','-Infinity') OR _active::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'Saved payment amounts need review';
  END IF;
  IF _d.payment_status='paid' AND _confirmed<_o.grand_total THEN
    RAISE EXCEPTION 'The recorded paid status lacks matching saved collections; reconcile before retrying';
  END IF;
  _due := round(_o.grand_total - _confirmed - _active, 2);
  IF _due <= 0 THEN
    RETURN jsonb_build_object('already_paid', _confirmed >= coalesce(_o.grand_total, 0),
                              'pending', _active > 0, 'order_id', _d.id);
  END IF;

  IF _due<>trunc(_due) OR _due>9007199254740991 THEN
    RAISE EXCEPTION 'M-Pesa requires a whole KES amount. No payment attempt or prompt was created; choose another method for this balance.';
  END IF;
  _ref := 'STK-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));

  INSERT INTO public.pos_payments (
    organization_id, branch_id, order_id, amount, currency, method,
    external_reference, status, provider_status, customer_id, idempotency_key
  ) VALUES (
    _d.organization_id, _d.branch_id, _o.id, _due, coalesce(_o.currency, 'KES'), 'mpesa',
    _ref, 'pending', 'awaiting-provider', _d.customer_id, 'mpesa:' || _ref
  ) RETURNING id INTO _payment;

  SELECT environment, short_code INTO _env, _code
    FROM public.mpesa_settings WHERE organization_id = _d.organization_id;

  INSERT INTO public.mpesa_transactions (
    organization_id, branch_id, source_module, source_record_id, payment_table, payment_id,
    msisdn, amount, account_reference, description, environment, short_code, status, created_by)
  VALUES (_d.organization_id, _d.branch_id, 'pos_order', _o.id, 'pos_payments', _payment,
          _digits, _due, coalesce(_d.order_number, _o.order_number), 'Delivery order',
          coalesce(_env, 'sandbox'), _code, 'initiated', auth.uid())
  RETURNING id INTO _txn;

  UPDATE public.delivery_orders SET payment_status = 'pending', updated_at = now() WHERE id = _d.id;

  RETURN jsonb_build_object(
    'order_id', _d.id,
    'organization_id', _d.organization_id,
    'transaction_id', _txn,
    'payment_id', _payment,
    'amount', _due,
    'msisdn', _digits,
    'reference', _ref,
    'account_reference', coalesce(_d.order_number, _o.order_number)
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.neo_folio_projection(_folio uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  f public.folios;
  _position jsonb;
  _net numeric := 0;
  _tax numeric := 0;
  _service numeric := 0;
  _other numeric := 0;
  _gross numeric := 0;
  _paid numeric := 0;
  _guest text;
  _res text;
BEGIN
  IF auth.uid() IS NULL
     OR public.can_read_guest_ledger() IS NOT TRUE
  THEN
    RAISE EXCEPTION 'Guest ledger read permission required'
      USING ERRCODE = '42501';
  END IF;
  SELECT * INTO f FROM public.folios
   WHERE id = _folio
     AND organization_id = current_org_id()
     AND (in_my_branch_scope(organization_id, branch_id) OR is_org_admin_for(organization_id));
  IF f.id IS NULL THEN RETURN jsonb_build_object('found', false); END IF;

  _position:=public.neo_folio_financial_components(f.id,f.organization_id);

  SELECT c.full_name INTO _guest FROM public.customers c WHERE c.id = f.customer_id AND c.organization_id=f.organization_id;
  SELECT r.confirmation_number INTO _res FROM public.reservations r WHERE r.id = f.reservation_id AND r.organization_id=f.organization_id;

  RETURN jsonb_build_object('found',true,'folio_id',f.id,'folio_number',f.folio_number,'status',f.status,'currency',f.currency,
    'branch_id',f.branch_id,'reservation_id',f.reservation_id,'reservation_number',_res,'customer_id',f.customer_id,'guest_name',_guest) || _position;
END;
$function$;

CREATE OR REPLACE FUNCTION public.neo_guest_folio_projection(_org uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _cust uuid; _folios jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT id INTO _cust FROM public.customers
   WHERE organization_id = _org AND auth_user_id = auth.uid() AND merged_into_id IS NULL
   LIMIT 1;
  IF _cust IS NULL THEN
    RETURN jsonb_build_object('folios', '[]'::jsonb, 'payments', '[]'::jsonb);
  END IF;

  SELECT coalesce(jsonb_agg(f ORDER BY f->>'opened_at' DESC), '[]'::jsonb) INTO _folios
  FROM (
    SELECT jsonb_build_object(
      'id', fo.id,
      'folio_number', fo.folio_number,
      'status', fo.status,
      'currency', fo.currency,
      'opened_at', fo.opened_at,
      'closed_at', fo.closed_at,
      'lines', (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
                 'id', fl.id,
                 'description', coalesce(fl.description, fl.category),
                 'quantity', fl.quantity,
                 'unit_price', fl.unit_price,
                 'tax_amount', fl.tax_amount,
                 'discount_amount', fl.discount_amount,
                 'net_amount', fl.net_amount,
                 'posting_date', fl.posting_date) ORDER BY fl.posting_date), '[]'::jsonb)
        FROM public.folio_lines fl
        WHERE fl.folio_id = fo.id AND fl.organization_id=fo.organization_id
          AND coalesce(fl.status,'posted') NOT IN ('void','voided','reversed')
          AND coalesce(fl.line_type,'charge') NOT IN ('payment','deposit','refund')
      )) || position.value AS f
    FROM public.folios fo
    CROSS JOIN LATERAL(SELECT public.neo_folio_financial_components(fo.id,fo.organization_id) AS value) position
    WHERE fo.organization_id = _org AND fo.customer_id = _cust
  ) s;

  RETURN jsonb_build_object(
    'folios', _folios,
    'payments', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'id', p.id,
               'receipt_number', p.receipt_number,
               'amount', p.amount,
               'currency', p.currency,
               'method', p.method,
               'paid_at', p.paid_at,
               'folio_id', p.folio_id) ORDER BY p.paid_at DESC), '[]'::jsonb)
      FROM public.payments p
      WHERE p.organization_id = _org AND p.customer_id = _cust
        AND coalesce(p.status,'completed') NOT IN ('void','voided','failed')
      LIMIT 50));
END;
$function$
;

CREATE OR REPLACE FUNCTION public.neo_finance_eligible_sources(_branch uuid DEFAULT NULL::uuid, _from date DEFAULT NULL::date, _to date DEFAULT NULL::date)
 RETURNS TABLE(source_type text, source_id uuid, reference text, source_status text, amount numeric, occurred_on date, branch_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH scope AS (SELECT public.current_org_id() org)
  SELECT 'pos_order', o.id, o.order_number, o.status, o.grand_total,
         coalesce(o.closed_at, o.created_at)::date, o.branch_id
    FROM public.pos_orders o, scope s
   WHERE o.organization_id = s.org AND o.status IN ('closed','paid','settled','completed')
  UNION ALL
  SELECT 'folio_charge', f.id, coalesce(f.reference, f.description), f.status,
         coalesce(f.net_amount,0),
         coalesce(f.operational_date, f.posting_date::date), f.branch_id
    FROM public.folio_lines f, scope s
   WHERE f.organization_id = s.org AND f.status = 'posted'
     AND coalesce(f.line_type,'charge') NOT IN ('payment','deposit','refund')
  UNION ALL
  SELECT 'folio_payment', p.id, p.receipt_number, p.status, p.amount,
         coalesce(p.paid_at, p.created_at)::date, p.branch_id
    FROM public.payments p, scope s
   WHERE p.organization_id = s.org
     AND p.status IN ('confirmed','completed','paid','succeeded','captured')
  UNION ALL
  SELECT 'event_deposit', e.id, e.event_reference, e.status, e.deposit_paid,
         coalesce(e.confirmed_at::date, e.event_date), e.branch_id
    FROM public.event_bookings e, scope s
   WHERE e.organization_id = s.org AND coalesce(e.deposit_paid,0) > 0
     AND e.status <> 'cancelled'
  UNION ALL
  SELECT 'event_invoice', i.id, i.invoice_number, i.status, i.total, i.issue_date, i.branch_id
    FROM public.invoices i, scope s
   WHERE i.organization_id = s.org
     AND i.status IN ('issued','sent','partially_paid','paid','overdue')
  UNION ALL
  SELECT 'event_earned', e.id, e.event_reference, e.status, e.total_amount, e.event_date, e.branch_id
    FROM public.event_bookings e, scope s
   WHERE e.organization_id = s.org AND e.status IN ('completed','closed')
  UNION ALL
  SELECT 'event_cancellation', e.id, e.event_reference, e.status,
         greatest(coalesce(e.cancellation_fee,0), coalesce(e.deposit_paid,0)),
         coalesce(e.cancelled_at::date, e.event_date), e.branch_id
    FROM public.event_bookings e, scope s
   WHERE e.organization_id = s.org AND e.status = 'cancelled'
     AND (coalesce(e.cancellation_fee,0) > 0 OR coalesce(e.deposit_paid,0) > 0)
  UNION ALL
  SELECT 'delivery_order', d.id, d.order_number, d.order_status, d.grand_total,
         coalesce(d.delivered_at, d.created_at)::date, d.branch_id
    FROM public.delivery_orders d, scope s
   WHERE d.organization_id = s.org AND d.order_status IN ('delivered','completed')
  UNION ALL
  SELECT 'laundry_order', l.id, l.laundry_number, l.status, l.total,
         coalesce(l.delivered_at, l.created_at)::date, l.branch_id
    FROM public.guest_laundry_orders l, scope s
   WHERE l.organization_id = s.org AND l.status IN ('delivered','completed','closed')
  UNION ALL
  SELECT 'supplier_invoice', v.id, v.invoice_number, v.status, v.amount, v.invoice_date, v.branch_id
    FROM public.supplier_invoices v, scope s
   WHERE v.organization_id = s.org AND v.approved_at IS NOT NULL
     AND v.status IN ('approved','matched','partially_paid','paid')
  UNION ALL
  SELECT 'supplier_payment', sp.id, sp.payment_number, sp.status, sp.amount, sp.paid_on, sp.branch_id
    FROM public.supplier_payments sp, scope s
   WHERE sp.organization_id = s.org AND sp.status IN ('paid','completed','settled');
$function$
;

CREATE OR REPLACE FUNCTION public.neo_revenue_reconciliation(_branch uuid DEFAULT NULL::uuid, _from date DEFAULT NULL::date, _to date DEFAULT NULL::date)
 RETURNS TABLE(module text, operational_amount numeric, posted_amount numeric, variance numeric, awaiting_amount numeric, blocked_amount numeric, failed_amount numeric, explanation text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare org uuid := public.current_org_id(); tz text; f date; t date; report_currency text;
begin
  if org is null or not (public.is_org_admin() or public.has_permission('finance','view')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if _branch is not null and not public.is_org_admin() and not coalesce(public.neo_branch_in_scope(_branch),false) then
    raise exception 'Report property is outside your access' using errcode='42501';
  end if;
  tz := public.neo_fact_timezone(org, _branch);
  t := coalesce(_to, (now() at time zone tz)::date);
  f := coalesce(_from, t - 29);
  report_currency:=public.neo_fact_currency(org,_branch);
  if nullif(btrim(report_currency),'') is null then raise exception 'Report currency is not configured'; end if;

  -- This contract has no currency column: never add different currencies.
  if exists (
    select 1 from public.pos_orders o where o.organization_id=org
      and ((_branch is null or o.branch_id=_branch) and (public.is_org_admin() or coalesce(public.neo_branch_in_scope(o.branch_id),false))) and o.folio_id is null
      and not exists(select 1 from public.delivery_orders d where d.pos_order_id=o.id and d.organization_id=o.organization_id)
      and o.status in ('closed','paid','settled','completed') and o.currency is distinct from report_currency
      and (coalesce(o.closed_at,o.created_at) at time zone tz)::date between f and t
  ) or exists (
    select 1 from public.folio_lines fl join public.folios fo on fo.id=fl.folio_id and fo.organization_id=fl.organization_id
    where fl.organization_id=org and ((_branch is null or fl.branch_id=_branch) and (public.is_org_admin() or coalesce(public.neo_branch_in_scope(fl.branch_id),false)))
      and fl.status='posted' and coalesce(fl.line_type,'charge')<>'payment'
      and coalesce(fl.operational_date,(fl.posting_date at time zone tz)::date) between f and t
      and fo.currency is distinct from report_currency
  ) or exists (
    select 1 from public.delivery_orders d where d.organization_id=org and ((_branch is null or d.branch_id=_branch) and (public.is_org_admin() or coalesce(public.neo_branch_in_scope(d.branch_id),false)))
      and d.order_status in ('delivered','completed') and d.payment_method<>'room-charge'
      and (coalesce(d.delivered_at,d.created_at) at time zone tz)::date between f and t
      and d.currency is distinct from report_currency
  ) or exists (
    select 1 from public.journal_entries j where j.organization_id=org
      and ((_branch is null or j.branch_id=_branch) and (public.is_org_admin() or coalesce(public.neo_branch_in_scope(j.branch_id),false))) and j.status='posted'
      and j.accounting_date between f and t and j.currency is distinct from report_currency
  ) then raise exception 'Revenue report contains currencies different from %. Filter to one currency/property or configure verified conversion.',report_currency; end if;

  if exists(select 1 from public.journal_entries j
    where j.organization_id=org and (_branch is null or j.branch_id=_branch)
      and (public.is_org_admin() or coalesce(public.neo_branch_in_scope(j.branch_id),false))
      and j.status='posted' and j.accounting_date between f and t
      and (j.total_debit is null or j.total_credit is null or j.total_debit<=0 or j.total_debit<>j.total_credit
        or j.total_debit::text in ('NaN','Infinity','-Infinity') or j.total_credit::text in ('NaN','Infinity','-Infinity')
        or (select coalesce(sum(l.debit),0) from public.journal_entry_lines l where l.journal_id=j.id)<>j.total_debit
        or (select coalesce(sum(l.credit),0) from public.journal_entry_lines l where l.journal_id=j.id)<>j.total_credit
        or exists(select 1 from public.journal_entry_lines l left join public.chart_of_accounts a on a.id=l.account_id where l.journal_id=j.id
          and (l.organization_id is distinct from org or a.organization_id is distinct from org or l.branch_id is distinct from j.branch_id
            or l.debit is null or l.credit is null or l.debit<0 or l.credit<0 or (l.debit>0 and l.credit>0)
            or l.debit::text in ('NaN','Infinity','-Infinity') or l.credit::text in ('NaN','Infinity','-Infinity'))))) then
    raise exception 'Posted journal amounts or tenant/property links need reconciliation before reporting';
  end if;

  return query
  with source_rows as (
    -- Finalised standalone sales are revenue; room transfers are recognised on folio charges.
    select 'pos'::text as m,o.id as source_id,'pos_order:revenue'::text as source_type,
      (coalesce(o.grand_total,0)-coalesce(o.tax_total,0)-coalesce(o.service_charge_total,0))::numeric as net,
      o.branch_id
    from public.pos_orders o
    where o.organization_id=org
      and ((_branch is null or o.branch_id=_branch) and (public.is_org_admin() or coalesce(public.neo_branch_in_scope(o.branch_id),false))) and o.folio_id is null
      and not exists(select 1 from public.delivery_orders d where d.pos_order_id=o.id and d.organization_id=o.organization_id)
      and o.status in ('closed','paid','settled','completed')
      and (coalesce(o.closed_at,o.created_at) at time zone tz)::date between f and t
    union all
    select 'folio',fl.id,'folio_charge:revenue',
      (coalesce(fl.gross_amount,0)-coalesce(fl.discount_amount,0))::numeric,fl.branch_id
    from public.folio_lines fl
    where fl.organization_id=org
      and ((_branch is null or fl.branch_id=_branch) and (public.is_org_admin() or coalesce(public.neo_branch_in_scope(fl.branch_id),false))) and fl.status='posted'
      and coalesce(fl.line_type,'charge') NOT IN ('payment','deposit','refund')
      and coalesce(fl.category,'')<>'gratuity'
      and coalesce(fl.operational_date,(fl.posting_date at time zone tz)::date) between f and t
    union all
    select 'delivery',coalesce(invoice.id,d.id),CASE WHEN invoice.id IS NOT NULL THEN 'delivery_invoice' ELSE 'delivery_order:revenue' END,
      (coalesce(d.grand_total,0)-coalesce(d.tax_total,0)-coalesce(d.service_charge_total,0)-coalesce(d.tip_amount,0))::numeric,d.branch_id
    from public.delivery_orders d
    left join lateral(select i.id from public.invoices i where i.organization_id=d.organization_id
      and i.notes like 'delivery-order:'||d.id::text||'%' order by i.created_at,i.id limit 1) invoice on true
    where d.organization_id=org and ((_branch is null or d.branch_id=_branch) and (public.is_org_admin() or coalesce(public.neo_branch_in_scope(d.branch_id),false)))
      and d.order_status in ('delivered','completed') and d.payment_method<>'room-charge'
      and (coalesce(d.delivered_at,d.created_at) at time zone tz)::date between f and t
  ), source_evidence as (
    select s.*,exists(select 1 from public.journal_entries j
      where j.organization_id=org and j.branch_id is not distinct from s.branch_id
      and j.source_document_id=s.source_id and j.source_document_type=s.source_type
      and j.status='posted' and j.reversed_by_journal_id is null
      and j.reverses_journal_id is null and j.total_debit=j.total_credit and j.total_debit<>0
      and (select coalesce(sum(l.debit),0) from public.journal_entry_lines l where l.journal_id=j.id)=j.total_debit
      and (select coalesce(sum(l.credit),0) from public.journal_entry_lines l where l.journal_id=j.id)=j.total_credit
      and (select coalesce(sum(l.credit-l.debit),0) from public.journal_entry_lines l join public.chart_of_accounts a on a.id=l.account_id
        where l.journal_id=j.id and a.organization_id=org and a.category in ('revenue','other_income'))=s.net
      and not exists(select 1 from public.journal_entry_lines l join public.chart_of_accounts a on a.id=l.account_id where l.journal_id=j.id
        and (l.organization_id is distinct from org or a.organization_id is distinct from org or l.branch_id is distinct from s.branch_id))) as posted,
      (select r.status from public.finance_posting_receipts r
       where r.organization_id=org and r.branch_id is not distinct from s.branch_id
       and r.source_id=s.source_id order by r.updated_at desc,r.id limit 1) as receipt_status
    from source_rows s
  ), q_source as (
    select m,sum(net) as source_amount,
      sum(net) filter(where not posted and coalesce(receipt_status,'') not in ('failed','blocked')) as awaiting,
      sum(net) filter(where not posted and receipt_status='blocked') as blocked,
      sum(net) filter(where not posted and receipt_status='failed') as failed
    from source_evidence group by m
  ), q_legacy as (
    select public.neo_module_label(k.source_module) as m,
           sum(k.amount) as source_amount,
           sum(k.amount) filter (where k.eligible) as awaiting,
           sum(k.amount) filter (where not k.eligible) as blocked
      from public.neo_finance_posting_queue(_branch, f, t) k
     where public.neo_module_label(k.source_module) not in ('pos','folio','delivery')
     group by 1
  ), q as (
    select m,source_amount,awaiting,blocked,failed from q_source
    union all select m,source_amount,awaiting,blocked,null::numeric from q_legacy
  ), r as (
    select public.neo_module_label(x.source_module) as m,
           sum(x.amount) filter (where x.status = 'failed') as failed
      from public.finance_posting_receipts x
     where x.organization_id = org
       and ((_branch is null or x.branch_id = _branch) and (public.is_org_admin() or coalesce(public.neo_branch_in_scope(x.branch_id),false)))
       and coalesce(x.occurred_on, (x.created_at at time zone tz)::date) between f and t
     group by 1
  ), g as (
    select public.neo_module_label(j.source_module) as m,
           sum(l.credit - l.debit) as posted
      from public.journal_entries j
      join public.journal_entry_lines l on l.journal_id = j.id
      join public.chart_of_accounts c on c.id = l.account_id
     where j.organization_id = org
       and j.status = 'posted'
       and ((_branch is null or j.branch_id = _branch) and (public.is_org_admin() or coalesce(public.neo_branch_in_scope(j.branch_id),false)))
       and j.accounting_date between f and t
       and c.category in ('revenue','other_income')
     group by 1
  ), joined as (
    select coalesce(q.m, r.m, g.m)::text as m,
           coalesce(q.source_amount, 0)::numeric(18,2) as src,
           coalesce(g.posted, 0)::numeric(18,2) as pst,
           coalesce(q.awaiting, 0)::numeric(18,2) as await_amt,
           coalesce(q.blocked, 0)::numeric(18,2) as blk,
           case when coalesce(q.m,r.m,g.m) in ('pos','folio','delivery')
             then coalesce(q.failed,0) else coalesce(r.failed,0) end::numeric(18,2) as fail
      from q
      full outer join r on r.m = q.m
      full outer join g on g.m = coalesce(q.m, r.m)
  )
  select j.m,
         j.src, j.pst, (j.src - j.pst)::numeric(18,2),
         j.await_amt, j.blk, j.fail,
         case
           when j.m not in ('pos','folio','delivery')
             then 'Legacy stream calculation: not certified as earned-revenue reconciliation. Review this stream separately.'
           when abs(j.src - j.pst) < 0.01 then 'Reconciled — operations and Finance agree.'
           else trim(both ' ' from concat_ws(' ',
             case when j.await_amt > 0 then 'Awaiting posting: ' || to_char(j.await_amt, 'FM999,999,999.00') || '.' end,
             case when j.blk > 0 then 'Blocked by a posting rule: ' || to_char(j.blk, 'FM999,999,999.00') || '.' end,
             case when j.fail > 0 then 'Failed postings needing retry: ' || to_char(j.fail, 'FM999,999,999.00') || '.' end,
             case when j.await_amt = 0 and j.blk = 0 and j.fail = 0
                  then 'Difference sits outside the posting queue — review the period and source records.' end))
         end::text
    from joined j
   order by 1;
end $function$
;

CREATE OR REPLACE FUNCTION public.neo_finance_posting_queue(_branch uuid DEFAULT NULL::uuid, _from date DEFAULT NULL::date, _to date DEFAULT NULL::date)
 RETURNS TABLE(source_module text, source_id uuid, reference text, source_status text, amount numeric, currency text, occurred_on date, eligible boolean, posting_status text, rule text, required_action text, drill_to text, last_error text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE org uuid:=public.current_org_id(); BEGIN
 IF org IS NULL OR NOT(public.is_org_admin() OR public.has_permission('finance','view')) THEN RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT s.source_module,s.source_id,s.source_reference,s.operational_state,s.amount,s.currency,s.occurred_at::date,s.financial_state='eligible',s.financial_state,
  'Canonical state '||s.operational_state||' → '||s.financial_state,
  coalesce(s.next_action,CASE s.financial_state WHEN 'eligible' THEN 'Post to the general ledger.' WHEN 'blocked' THEN 'Resolve the source exception.' WHEN 'failed' THEN 'Correct the failure and retry safely.' ELSE 'Complete the current operational stage.' END),
  CASE s.source_module WHEN 'inventory' THEN '/inventory/receiving' WHEN 'supplier_invoice' THEN '/finance/payables' WHEN 'supplier_payment' THEN '/finance/payables' WHEN 'deposit' THEN '/finance/deposits' WHEN 'payment' THEN '/finance/queue' WHEN 'pos' THEN '/pos/orders' WHEN 'events' THEN '/events/bookings' WHEN 'delivery' THEN '/delivery' WHEN 'laundry' THEN '/laundry' ELSE '/finance/posting' END,
  coalesce(s.blocking_reason,(SELECT r.last_error FROM public.finance_posting_receipts r WHERE r.organization_id=s.organization_id AND public.neo_canonical_posting_module(r.source_module)=s.source_module AND r.source_id=s.source_id ORDER BY r.updated_at DESC LIMIT 1))
 FROM public.canonical_transaction_states s WHERE s.organization_id=org AND (public.is_org_admin() OR coalesce(public.neo_branch_in_scope(s.branch_id),false)) AND (_branch IS NULL OR s.branch_id=_branch) AND (_from IS NULL OR s.occurred_at::date>=_from) AND (_to IS NULL OR s.occurred_at::date<=_to) AND s.source_module IN('pos','folio','laundry','events','delivery','inventory','supplier_invoice','supplier_payment','deposit','payment') AND s.financial_state NOT IN('posted','reversed','not-applicable') ORDER BY (s.financial_state='eligible') DESC,s.occurred_at DESC LIMIT 500;
END $function$
;

DO $internal_owners$
DECLARE trusted record; helper jsonb;
BEGIN
 FOR trusted IN SELECT DISTINCT r.rolname FROM neo_finance_existing_acl s JOIN pg_roles r ON r.oid=s.proowner LOOP
  FOR helper IN SELECT value FROM jsonb_array_elements($helper_grants$[{"sig":"public.neo_guest_lock_cart_pricing(uuid)","definition_hash":"64063f40715383dfdb7b0fdced45bab0","body_hash":"a970f3de7b37de811290e3c3746aed40","prosecdef":false,"provolatile":"v","proconfig":["search_path=public, pg_temp"],"return_type":"void","language":"plpgsql"},{"sig":"public.neo_guest_cart_line_write_guard()","definition_hash":"c36b0e69dde69bb2d60214391f717083","body_hash":"90b7119f38f75498ea41a272210dfa81","prosecdef":true,"provolatile":"v","proconfig":["search_path=public, pg_temp"],"return_type":"trigger","language":"plpgsql"},{"sig":"public.neo_guest_order_cart_binding_guard()","definition_hash":"9e44d4405e0bec310f66f2dedab35627","body_hash":"d5a684b3fed0b52a60aa0145a991c4eb","prosecdef":false,"provolatile":"v","proconfig":["search_path=public, pg_temp"],"return_type":"trigger","language":"plpgsql"},{"sig":"public.neo_tip_payable_account(uuid)","definition_hash":"e4dcd008e35978cc049ff60cdd891c0f","body_hash":"7470a2aca7ba4d59ed3941df2690914b","prosecdef":false,"provolatile":"v","proconfig":["search_path=public, pg_temp"],"return_type":"uuid","language":"plpgsql"},{"sig":"public.neo_folio_financial_components(uuid,uuid)","definition_hash":"ef2bedf4ed86215f35e2d6ef949b09bd","body_hash":"29454d5b5922ca223fc47a4062a787a9","prosecdef":false,"provolatile":"s","proconfig":["search_path=public, pg_temp"],"return_type":"jsonb","language":"plpgsql"}]$helper_grants$::jsonb) LOOP
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',helper->>'sig',trusted.rolname);
  END LOOP;
 END LOOP;
END $internal_owners$;
DO $trigger_names$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND (
    (tgrelid='public.cart_items'::regclass AND tgname='neo_guest_cart_line_write_guard_trg' AND (tgfoid<>'public.neo_guest_cart_line_write_guard()'::regprocedure OR tgtype<>31))
 OR (tgrelid='public.cart_item_modifiers'::regclass AND tgname='neo_guest_cart_modifier_write_guard_trg' AND (tgfoid<>'public.neo_guest_cart_line_write_guard()'::regprocedure OR tgtype<>31))
 OR (tgrelid='public.delivery_orders'::regclass AND tgname='neo_guest_cart_order_binding_guard_trg' AND (tgfoid<>'public.neo_guest_order_cart_binding_guard()'::regprocedure OR tgtype<>23)))) THEN
  RAISE EXCEPTION 'A checkout trigger name is already used by another behavior';
 END IF;
END $trigger_names$;
DROP TRIGGER IF EXISTS neo_guest_cart_line_write_guard_trg ON public.cart_items;
CREATE TRIGGER neo_guest_cart_line_write_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON public.cart_items FOR EACH ROW EXECUTE FUNCTION public.neo_guest_cart_line_write_guard();
DROP TRIGGER IF EXISTS neo_guest_cart_modifier_write_guard_trg ON public.cart_item_modifiers;
CREATE TRIGGER neo_guest_cart_modifier_write_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON public.cart_item_modifiers FOR EACH ROW EXECUTE FUNCTION public.neo_guest_cart_line_write_guard();
DROP TRIGGER IF EXISTS neo_guest_cart_order_binding_guard_trg ON public.delivery_orders;
CREATE TRIGGER neo_guest_cart_order_binding_guard_trg BEFORE INSERT OR UPDATE ON public.delivery_orders FOR EACH ROW EXECUTE FUNCTION public.neo_guest_order_cart_binding_guard();
DO $verify$
DECLARE expected jsonb;
BEGIN
 FOR expected IN SELECT value FROM jsonb_array_elements($verify_existing$[{"sig":"public.delivery_quote_cart(uuid)","old_hash":"289af03fe0106664cd783e58a4d87991","definition_hash":"3905336739a373e8eaa663eb768c5839","body_hash":"30e87a1eca4f87abf75b1bb9cd07121c","prosecdef":true,"provolatile":"s","proconfig":["search_path=public"],"return_type":"jsonb","language":"plpgsql"},{"sig":"public.delivery_place_order(uuid,text)","old_hash":"1dcc63d3505b1445500536ca7151fdef","definition_hash":"3435927b654fbca52f9b6a8fb1f4d081","body_hash":"29bd7c183ffd362619e3d3d1ac24f6ae","prosecdef":true,"provolatile":"v","proconfig":["search_path=public"],"return_type":"jsonb","language":"plpgsql"},{"sig":"public.neo_guest_place_room_service(uuid,text)","old_hash":"98bb6d2ae5f61d7c3cc7eb887fbf6865","definition_hash":"7101829377341647abbefe18a1aea28e","body_hash":"815132eab48e282a0406c7df24763477","prosecdef":true,"provolatile":"v","proconfig":["search_path=public"],"return_type":"jsonb","language":"plpgsql"},{"sig":"public.tg_pos_order_totals_authoritative()","old_hash":"d1ffd4dde67d3cea775de4933099135b","definition_hash":"c09c5a8cb492dc77b466a3d0f2af36e1","body_hash":"f8fad347217e30559e1586964aa59a65","prosecdef":true,"provolatile":"v","proconfig":["search_path=public"],"return_type":"trigger","language":"plpgsql"},{"sig":"public.neo_delivery_bill(uuid,text)","old_hash":"a69b953a703f6c8f3805652314a740a7","definition_hash":"88d4c672ac207430587876e8831d1072","body_hash":"ae3b8f1801f3cef3a411450bb475b950","prosecdef":true,"provolatile":"v","proconfig":["search_path=public"],"return_type":"jsonb","language":"plpgsql"},{"sig":"public.neo_finance_post_txn(text,uuid,boolean)","old_hash":"5f33d5ef8c7b352450d588e8d927d469","definition_hash":"1695af952c66b3014c9ef03af76020f1","body_hash":"98df457b013ff3e99550855871a0ca77","prosecdef":true,"provolatile":"v","proconfig":["search_path=public"],"return_type":"jsonb","language":"plpgsql"},{"sig":"public.neo_delivery_guest_mpesa_start(uuid,text)","old_hash":"f72c652f4217c8fdd2048b35aeadd1d3","definition_hash":"a66b19b04dc17f2a0ccc12676bf585d4","body_hash":"44bcfceadd5311e16905d4eef9e0d1d6","prosecdef":true,"provolatile":"v","proconfig":["search_path=public"],"return_type":"jsonb","language":"plpgsql"},{"sig":"public.neo_folio_projection(uuid)","old_hash":"280a3fb1d852c286ea99119e759c7ff7","definition_hash":"eab39d38f1604f49c66b36358a63d573","body_hash":"51d5e7cec5075728b174767084d06816","prosecdef":true,"provolatile":"s","proconfig":["search_path=public"],"return_type":"jsonb","language":"plpgsql"},{"sig":"public.neo_guest_folio_projection(uuid)","old_hash":"e675a623d765717117a09935da2efe6d","definition_hash":"94f20c521619d8a61f03c52746298817","body_hash":"b413e1c77eaaa2aaf4534ebeb5ffe594","prosecdef":true,"provolatile":"s","proconfig":["search_path=public"],"return_type":"jsonb","language":"plpgsql"},{"sig":"public.neo_finance_eligible_sources(uuid,date,date)","old_hash":"2ea160e6c3f31f6237ad8609b650400b","definition_hash":"71bf702311e4aa07aaf76cd78bc8c4b3","body_hash":"1ca2a5361d7df66638b4ea83d5fcd094","prosecdef":true,"provolatile":"s","proconfig":["search_path=public"],"return_type":"record","language":"sql"},{"sig":"public.neo_revenue_reconciliation(uuid,date,date)","old_hash":"fe898ebc5a5912d852b3228c140cf27c","definition_hash":"de81c7c64b5a359b6925040ce1f47bd1","body_hash":"0b5134694ef1eb68f9be655f25a6c172","prosecdef":true,"provolatile":"s","proconfig":["search_path=public"],"return_type":"record","language":"plpgsql"},{"sig":"public.neo_finance_posting_queue(uuid,date,date)","old_hash":"06e9f84092e8c40e6dcc1e159b503d08","definition_hash":"7f84a8c5beb8f78ea9c50f11de70cffa","body_hash":"8a1314ecce54709a77acf09439dccf44","prosecdef":true,"provolatile":"s","proconfig":["search_path=public"],"return_type":"record","language":"plpgsql"}]$verify_existing$::jsonb) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN neo_finance_existing_acl b ON p.oid=to_regprocedure(b.signature)
    WHERE b.signature=expected->>'sig' AND p.proowner=b.proowner AND coalesce(p.proacl::text,'')=b.acl
      AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g'))=expected->>'body_hash' AND p.prosecdef=(expected->>'prosecdef')::boolean
      AND p.provolatile=expected->>'provolatile' AND p.proconfig=ARRAY(SELECT jsonb_array_elements_text(expected->'proconfig'))
      AND p.prorettype=(expected->>'return_type')::regtype AND p.prolang=(SELECT oid FROM pg_language WHERE lanname=expected->>'language')) THEN
   RAISE EXCEPTION 'Financial definition, owner or existing permissions failed verification: %',expected->>'sig';
  END IF;
 END LOOP;
 FOR expected IN SELECT value FROM jsonb_array_elements($verify_helpers$[{"sig":"public.neo_guest_lock_cart_pricing(uuid)","definition_hash":"64063f40715383dfdb7b0fdced45bab0","body_hash":"a970f3de7b37de811290e3c3746aed40","prosecdef":false,"provolatile":"v","proconfig":["search_path=public, pg_temp"],"return_type":"void","language":"plpgsql"},{"sig":"public.neo_guest_cart_line_write_guard()","definition_hash":"c36b0e69dde69bb2d60214391f717083","body_hash":"90b7119f38f75498ea41a272210dfa81","prosecdef":true,"provolatile":"v","proconfig":["search_path=public, pg_temp"],"return_type":"trigger","language":"plpgsql"},{"sig":"public.neo_guest_order_cart_binding_guard()","definition_hash":"9e44d4405e0bec310f66f2dedab35627","body_hash":"d5a684b3fed0b52a60aa0145a991c4eb","prosecdef":false,"provolatile":"v","proconfig":["search_path=public, pg_temp"],"return_type":"trigger","language":"plpgsql"},{"sig":"public.neo_tip_payable_account(uuid)","definition_hash":"e4dcd008e35978cc049ff60cdd891c0f","body_hash":"7470a2aca7ba4d59ed3941df2690914b","prosecdef":false,"provolatile":"v","proconfig":["search_path=public, pg_temp"],"return_type":"uuid","language":"plpgsql"},{"sig":"public.neo_folio_financial_components(uuid,uuid)","definition_hash":"ef2bedf4ed86215f35e2d6ef949b09bd","body_hash":"29454d5b5922ca223fc47a4062a787a9","prosecdef":false,"provolatile":"s","proconfig":["search_path=public, pg_temp"],"return_type":"jsonb","language":"plpgsql"}]$verify_helpers$::jsonb) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(expected->>'sig') AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g'))=expected->>'body_hash' AND p.prosecdef=(expected->>'prosecdef')::boolean)
    OR has_function_privilege('anon',expected->>'sig','EXECUTE') OR has_function_privilege('authenticated',expected->>'sig','EXECUTE') THEN
   RAISE EXCEPTION 'Internal financial helper boundary failed: %',expected->>'sig';
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_index i JOIN pg_class name ON name.oid=i.indexrelid JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attname='source_cart_id'
   WHERE name.relname='neo_delivery_source_cart_once' AND i.indrelid='public.delivery_orders'::regclass AND i.indisunique AND i.indnkeyatts=1 AND i.indkey[0]=a.attnum
     AND i.indexprs IS NULL AND pg_get_expr(i.indpred,i.indrelid)='(source_cart_id IS NOT NULL)') THEN RAISE EXCEPTION 'Exact cart-to-order uniqueness was not verified'; END IF;
END $verify$;
NOTIFY pgrst,'reload schema';
SELECT jsonb_build_object('diagnostic_version','finance-checkout-ledger-parity-v1','definitions_match',true,'routine_count',12,'private_helper_count',5,'existing_permissions_unchanged',true,
 'scope','Installs future checkout/ledger/projection consistency, exact cart identity, liability accounting for collected tips and scoped reconciliation. Creates no order, payment, invoice, approval, stock movement or historical correction during installation. Existing worker permissions and routine owners remain.');
COMMIT;
