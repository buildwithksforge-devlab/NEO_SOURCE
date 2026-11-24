-- NEØ: READ ONLY. Run before any operational SQL changes.
-- Confirm the Dashboard project matches this checkout: zlrrmrcqlerafptkgucl.supabase.co
SELECT current_database() AS database_name,current_user AS database_role,current_setting('TimeZone') AS timezone;

SELECT name,current_setting(name,true) AS configured_project_value
FROM (VALUES ('app.settings.supabase_url'),('app.settings.api_url')) AS settings(name);

-- Inventory every function required by the proposed repair and device screen.
WITH required(signature) AS (VALUES
 ('public.hk_raise_cleaning_task(uuid,text,text,text,timestamptz,uuid,text,uuid,text,uuid,text,uuid)'),
 ('public.rooms_derive_state()'),
 ('public.neo_grn_retry_accrual(uuid)'),
 ('public.neo_grn_post_accrual(uuid)'),
 ('public.neo_delivery_staff_place_order(uuid,text,text,jsonb,text,uuid,jsonb,text,text)'),
 ('public.neo_assert_capability(text,text,text)'),
 ('public.neo_branch_in_scope(uuid)'),
 ('public.neo_device_admin_list()'),
 ('public.neo_device_activation_issue(uuid,text)')
)
SELECT signature,to_regprocedure(signature) AS deployed_signature FROM required;

-- Save these returned function definitions as the before/recovery evidence.
SELECT p.oid::regprocedure AS signature,
       md5(replace(p.prosrc,E'\r\n',E'\n')) AS body_checksum,
       pg_get_functiondef(p.oid) AS before_definition
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname IN (
 'hk_raise_cleaning_task','rooms_derive_state','neo_grn_retry_accrual',
 'neo_delivery_staff_place_order','neo_delivery_staff_place_order_once',
 'neo_device_admin_allowed','neo_device_admin_list','neo_device_activation_issue','neo_staff_pin_admin'
)
ORDER BY p.proname,p.oid;

SELECT tgname,pg_get_triggerdef(oid) AS before_trigger_definition
FROM pg_trigger WHERE tgrelid='public.rooms'::regclass AND NOT tgisinternal ORDER BY tgname;

-- Check all pending prerequisite/candidate versions. A missing history row alone
-- does not prove the SQL is absent; reconcile against definitions above.
SELECT version,name FROM supabase_migrations.schema_migrations
WHERE version IN ('20261025110000','20261026120000','20261106020000',
                  '20261106090000','20261106090100','20261106090200','20261106090300')
ORDER BY version;

SELECT table_name,column_name,data_type
FROM information_schema.columns WHERE table_schema='public'
  AND table_name IN ('rooms','stays','delivery_orders','permissions','role_feature_templates','role_permissions','roles')
  AND column_name IN ('occupancy_status','maintenance_status','housekeeping_status','room_condition','organization_id',
                      'branch_id','status','checked_out_at','intake_idempotency_key','intake_request_hash',
                      'module','feature','action','source','normalized_role_key','role_status')
ORDER BY table_name,column_name;

-- Find the verified organisation ID for the separately scoped device grant.
SELECT id,name FROM public.organizations WHERE lower(name) LIKE '%savann%' ORDER BY name;