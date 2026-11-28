-- Run before and after the migration in the intended database.
WITH installed AS (
  SELECT to_regprocedure('public.neo_guest_order_tracking(uuid,text)') AS routine
), definition AS (
  SELECT routine, pg_get_functiondef(routine) AS body FROM installed
)
SELECT
  routine IS NOT NULL AS routine_exists,
  coalesce(strpos(body, 'AND customer_id = _cust') > 0, false) AS customer_check_present,
  coalesce(strpos(body, 'neo_guest_delivery_receipt_v1') > 0, false) AS receipt_projection_installed,
  coalesce(has_function_privilege('authenticated', routine, 'EXECUTE'), false) AS authenticated_can_execute,
  coalesce(has_function_privilege('anon', routine, 'EXECUTE'), false) AS anonymous_can_execute
FROM definition;
