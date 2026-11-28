-- READ ONLY: map remaining waves to deployed function inventory before attributing a failure to source.
WITH expected(wave,function_name) AS (VALUES
 (1,'hk_raise_cleaning_task'),(1,'hk_complete_job'),(1,'rooms_derive_state'),
 (1,'neo_maintenance_work_order_create'),(1,'neo_grn_retry_accrual'),
 (2,'pms_check_in'),(2,'pms_check_out'),(2,'pms_record_payment'),
 (2,'neo_laundry_batch_advance'),(2,'neo_minibar_post'),(2,'pos_post_room_charge'),
 (3,'neo_pos_send_to_kitchen'),(3,'neo_kitchen_item_transition'),(3,'pos_reconcile_order_settlement'),
 (3,'neo_print_enqueue'),(3,'neo_print_record_result'),
 (4,'neo_stores_receive_goods'),(4,'neo_stores_issue'),(4,'neo_supplier_invoice_accept'),
 (4,'neo_supplier_payment_advance'),(4,'cash_close_shift'),(4,'neo_mpesa_apply_result'),
 (5,'neo_event_beo_publish'),(5,'neo_delivery_staff_place_order'),(5,'neo_delivery_staff_place_order_once')
)
SELECT e.wave,e.function_name,p.oid::regprocedure AS deployed_signature,
  CASE WHEN p.oid IS NULL THEN 'MISSING — reconcile actual caller before repairing'
       ELSE 'PRESENT — compare build, definition and labelled outcome' END AS inspection_state,
  md5(replace(p.prosrc,E'\r\n',E'\n')) AS body_checksum,
  CASE WHEN p.oid IS NOT NULL THEN has_function_privilege('anon',p.oid,'EXECUTE') END AS anonymous_execution,
  CASE WHEN p.oid IS NOT NULL THEN has_function_privilege('authenticated',p.oid,'EXECUTE') END AS staff_execution
FROM expected e LEFT JOIN (
  pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
) ON p.proname=e.function_name
ORDER BY e.wave,e.function_name,p.oid;

SELECT version,name FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 40;