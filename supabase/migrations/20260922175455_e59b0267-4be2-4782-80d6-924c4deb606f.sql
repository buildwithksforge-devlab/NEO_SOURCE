CREATE OR REPLACE FUNCTION public.delivery_get_settings(_branch uuid)
 RETURNS delivery_settings
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH org AS (
    SELECT coalesce(
      (SELECT b.organization_id FROM public.branches b WHERE b.id = _branch),
      public.current_org_id()
    ) AS id
  ), saved AS (
    SELECT s.* FROM public.delivery_settings s, org
    WHERE s.organization_id = org.id
      AND (s.branch_id = _branch OR s.branch_id IS NULL)
    ORDER BY s.branch_id NULLS LAST
    LIMIT 1
  )
  SELECT * FROM saved
  UNION ALL
  SELECT (jsonb_populate_record(
    NULL::public.delivery_settings,
    jsonb_build_object(
      'id', gen_random_uuid(),
      'organization_id', org.id,
      'branch_id', _branch,
      'delivery_enabled', true,
      'pickup_enabled', true,
      'scheduled_orders_enabled', true,
      'cod_enabled', true,
      'cod_limit', 5000,
      'min_order', 0,
      'order_lead_minutes', 30,
      'max_schedule_days', 7,
      'prep_buffer_minutes', 10,
      'cancellation_window_minutes', 5,
      'rider_capacity', 3,
      'pod_method', 'pin',
      'gps_tracking_enabled', false,
      'location_retention_days', 7,
      'stock_deduction_point', 'order-accepted',
      'auto_accept_paid', false,
      'feedback_delay_minutes', 60,
      'allowed_payment_methods', jsonb_build_array('cash', 'mpesa'),
      'failed_delivery_policy', 'dispatch-review',
      'promotion_approval_required', true,
      'settings', jsonb_build_object('source', 'defaults'),
      'created_at', now(),
      'updated_at', now(),
      'customer_tracking_enabled', true,
      'rider_contact_enabled', true,
      'location_ping_seconds', 30
    )
  )).*
  FROM org
  WHERE NOT EXISTS (SELECT 1 FROM saved)
  LIMIT 1;
$function$;