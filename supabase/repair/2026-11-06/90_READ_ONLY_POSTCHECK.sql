-- NEØ: READ ONLY. Run after the selected repair scripts have committed.
SELECT p.oid::regprocedure AS signature,
  md5(replace(p.prosrc,E'\r\n',E'\n')) AS deployed_body_checksum,
  CASE WHEN p.proname='hk_raise_cleaning_task'
       THEN position('room_condition=''vacant-dirty''' IN p.prosrc)=0
       WHEN p.proname='neo_grn_retry_accrual'
       THEN position('no journal reference was returned' IN p.prosrc)>0
       ELSE NULL END AS expected_repair_present
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname IN ('hk_raise_cleaning_task','neo_grn_retry_accrual','neo_delivery_staff_place_order_once');

SELECT indexname,indexdef FROM pg_indexes
WHERE schemaname='public' AND indexname='delivery_orders_intake_identity_idx';

SELECT column_name,data_type FROM information_schema.columns
WHERE table_schema='public' AND table_name='delivery_orders'
  AND column_name IN ('intake_idempotency_key','intake_request_hash');

SELECT p.oid::regprocedure AS signature,
  has_function_privilege('anon',p.oid,'EXECUTE') AS anonymous_execution,
  has_function_privilege('authenticated',p.oid,'EXECUTE') AS staff_execution
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname='neo_delivery_staff_place_order_once';

SELECT role_key,module,feature,action FROM public.role_feature_templates
WHERE module='administration' AND feature='devices' AND action='manage' ORDER BY role_key;

SELECT id,module,feature,action FROM public.permissions
WHERE module='administration' AND feature='devices' AND action='manage';

-- The catalogue migration does not by itself modify existing role assignments.
SELECT r.organization_id,r.normalized_role_key,r.active,r.role_status,count(rp.id) AS current_device_grants
FROM public.roles r
LEFT JOIN public.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id
  AND rp.permission_id IN (SELECT id FROM public.permissions WHERE module='administration' AND feature='devices' AND action='manage')
WHERE r.normalized_role_key IN ('owner','it-system-administrator')
GROUP BY r.organization_id,r.normalized_role_key,r.active,r.role_status
ORDER BY r.organization_id,r.normalized_role_key;