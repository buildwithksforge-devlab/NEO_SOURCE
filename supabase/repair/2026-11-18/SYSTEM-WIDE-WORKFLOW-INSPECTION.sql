-- READ ONLY, all organisations in this managed database. No balance, policy,
-- configuration or business-record changes. Run in the original Lovable SQL editor.
WITH expected(signature,earlier_hash,shared_hash,later_hashes) AS (VALUES
('public.neo_cash_settle_request(uuid)','d4805592caf414dac4ff438d4da11038','9217c85e7679c639650f79fb7fdd87ea','[]'::jsonb),
('public.pms_available_rooms(uuid,date,date,uuid,integer,integer,uuid)','9e36e6b7f47c1f87cda18d9724896f56','b2b0aa063506ccc86dcceef31b2759bc','[]'::jsonb),
('public.ops_room_state(uuid)','5fdd347962dfacb2fc93ebaedf42a348','d42f1e6a0d4516ea129135c5954ee434','[]'::jsonb),
('public.pms_record_payment(uuid,numeric,text,text,text,text,uuid)','7f167375d93e63fbd9489e96cbd933da','d5c0acac22026f8f024a7f6f5751823d','[]'::jsonb),
('public.neo_cash_till_context(uuid)','36b63a8dd5854b9e11417708478100e5','a20f1fd2483c58b3bc4671d0ca9c3e0f','[]'::jsonb),
('public.neo_cash_request_payment(uuid,numeric,text,text,text)','025359bfb6c3d6d6ad7464bfcd235df2','6b21da0e161adcaeeee6ad2e3179db32','[]'::jsonb),
('public.neo_cash_request_pos_payment(uuid,numeric,text,text,text)','fd97015abbb7c524905ec33fb5160ae8','f11b167821be12080cc22324f843d13c','[]'::jsonb),
('public.neo_cash_request_pos_payment(uuid,numeric,text,text,text,numeric)','e3f20676ebb812a4b1357c99a9b25038','c40eacd9e94530e01e0818de74a8d096','[]'::jsonb),
('public.neo_supplier_invoice_accept(uuid,text)','4fde341f5b26b996ef967e8dc585a5c4','dc36db393c366c4b3e8fbd30c3ee1690','["e23c4c22a3c48c7fbcca961b95438bac"]'::jsonb),
('public.neo_reservation_deposit_record(uuid,numeric,text,text,text,text)','121422758038ec7edda8bc6f0c9bfbcf','d07a7ae828c74596ad4a0bb01fb3a198','[]'::jsonb),
('public.neo_reservation_financial_state_sync(uuid)','106d6863e37f1ac73425b99d364ee7a5','221250a170cc5862b988f26bf7931b0d','[]'::jsonb),
('public.neo_gl_revenue_code_scoped(uuid,text,text)','a127ad1bfb734e62f7a3954e0e4305b3','5250b67c6e29ee6fc949b72fd847ac59','[]'::jsonb),
('public.ops_room_availability(uuid,date,date)','0613e5026b13e25a75960c240fce7293','fc376d87b1ce7b568fa43a4bbd8a93f1','[]'::jsonb),
('public.inventory_consume_order_item_core(uuid)','7cf50f83f00f127384f17e703e4bfb5b','0ff5a66b125e3aee34ffb5598cfb1685','[]'::jsonb),
('public.pos_record_payment_attempt(uuid,numeric,text,numeric,text,uuid,text,boolean,text,uuid)','54ca4b89c5dffe501d5bd3ccd3ac3dc1','261a88efb731375ff8c31557c79b6411','["915008ca2eb86bd57147bb54230b7817"]'::jsonb),
('public.neo_gl_post(uuid,uuid,text,text,uuid,text,date,text,text,jsonb,uuid,uuid)','08e96545d8fc2cfe60b3839131c4ee08','bb97bc255ef2b3c0644d4248240d1406','[]'::jsonb),
('public.tg_folio_sync_reservation_payment_status()','cba45520d3c2c6bb299155d0d484d11e','a8a9705fee7ed15013653b71ec9bef74','[]'::jsonb),
('public.neo_reservation_collection_source_refresh()','e0fd6fc005deb3a46e96ca32256e8dcc','29e89bf056097b5d0ef6c50b8cfe2ac5','[]'::jsonb),
('public.inventory_post_stock_take(uuid)','c86a9f663f490881ab11e3387c14a58d','c2c1b4212c3e36ad219236109e977fd7','[]'::jsonb),
('public.neo_stores_issue(uuid,jsonb,uuid,uuid,text,text)','2afdbba3ad8cb4852d3fdd65ff946ff7','32ed1a1bd69d2a852c6a45ecc40e57da','[]'::jsonb),
('public.neo_stores_count_submit_variance(uuid,text)','c16e752accfd06c60527171ecfe685d6','e6c05479319fdbb2dca31d9afdc32274','[]'::jsonb),
('public.neo_revenue_reconciliation(uuid,date,date)','18b839422b51de507a25fbea284f9417','fe898ebc5a5912d852b3228c140cf27c','["de81c7c64b5a359b6925040ce1f47bd1"]'::jsonb),
('public.pms_confirm_payment(uuid,text,text)','987e80e45018a7bb3fc26383f24d46bb','96b6d1965ba35f1f78ccbfa21277320b','[]'::jsonb)
), installed AS (
 SELECT expected.*,p.oid,p.prosecdef,p.proowner,
   CASE WHEN p.oid IS NOT NULL THEN pg_get_functiondef(p.oid) END AS definition
 FROM expected LEFT JOIN pg_proc p ON p.oid=to_regprocedure(expected.signature)
)
SELECT jsonb_build_object(
 'shared_workflow_checks',(SELECT jsonb_agg(jsonb_build_object(
   'signature',signature,'installed',oid IS NOT NULL,
   'body_hash',md5(definition),
   'review_status',CASE WHEN oid IS NULL THEN 'missing'
     WHEN md5(definition)=shared_hash THEN 'known_shared_definition'
     WHEN later_hashes ? md5(definition) THEN 'known_reviewed_followup_definition'
     WHEN md5(definition)=earlier_hash THEN 'earlier_definition_review_required'
     ELSE 'different_or_newer_definition_review_required' END,
   'contains_known_tenant_gate',coalesce(definition ~* '(aa17d427-f816-49bc-b02e-1a89e44806a2|c10e5d20-dc04-4959-9db4-4c2afb9d2f8c)',false)
 )) FROM installed),
 'other_workflow_routines',(
   SELECT jsonb_agg(jsonb_build_object('name',wanted.name,'signatures',coalesce((
     SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,
       'body_hash',md5(pg_get_functiondef(p.oid)),
       'authenticated_execute',has_function_privilege('authenticated',p.oid,'EXECUTE'),
       'anonymous_execute',has_function_privilege('anon',p.oid,'EXECUTE')))
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname=wanted.name),'[]'::jsonb)))
   FROM (VALUES ('neo_recipe_sheet_save'),('neo_recipe_activate'),('pms_check_out'),
     ('neo_minibar_post_once'),('neo_blind_receiving_decide'),
     ('neo_blind_receiving_approved_queue'),('neo_document_payload'),
     ('neo_station_consumption_location')) wanted(name)
 ),
 'organisation_mapping_checks',(
   SELECT coalesce(jsonb_agg(to_jsonb(report)),'[]'::jsonb) FROM (
     SELECT org.id AS organization_id,org.name AS organization_name,
       (SELECT count(*) FROM public.recipes r WHERE r.organization_id=org.id AND r.status='active') AS active_recipes,
       (SELECT count(*) FROM public.recipes r LEFT JOIN public.stock_items s ON s.id=r.output_stock_item_id
        WHERE r.organization_id=org.id AND r.status='active' AND r.recipe_type='direct_sale'
          AND (s.id IS NULL OR s.organization_id IS DISTINCT FROM r.organization_id
            OR (s.branch_id IS NOT NULL AND s.branch_id IS DISTINCT FROM r.branch_id))) AS invalid_active_direct_sale_outputs,
       (SELECT count(*) FROM public.menu_items m LEFT JOIN public.stock_items s ON s.id=m.stock_item_id
        WHERE m.organization_id=org.id AND m.consumption_mode='direct_stock'
          AND (s.id IS NULL OR s.organization_id IS DISTINCT FROM m.organization_id
            OR (s.branch_id IS NOT NULL AND s.branch_id IS DISTINCT FROM m.branch_id))) AS invalid_direct_stock_menu_ownership,
       (SELECT count(*) FROM public.operational_stations station WHERE station.organization_id=org.id AND station.active
          AND NOT EXISTS(SELECT 1 FROM public.station_consumption_stores mapping
            JOIN public.stock_locations location ON location.id=mapping.location_id
            WHERE mapping.station_id=station.id AND mapping.organization_id=station.organization_id
              AND mapping.branch_id IS NOT DISTINCT FROM station.branch_id
              AND location.organization_id=station.organization_id AND location.active
              AND NOT coalesce(location.is_main,false)
              AND location.branch_id IS NOT DISTINCT FROM station.branch_id)) AS active_stations_without_canonical_consumption_store
     FROM public.organizations org ORDER BY org.name,org.id
   ) report
 )
) AS system_workflow_inspection;
