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
  SELECT
    gen_random_uuid(), org.id, _branch,
    true, true, true,
    true, 5000, 0, 30, 7, 10, 5, 3,
    'pin', false, 7, 'order-accepted', false, 60,
    ARRAY['cash'::text, 'mpesa'::text], 'dispatch-review', true,
    '{"source":"defaults"}'::jsonb, NULL, now(), now()
  FROM org
  WHERE NOT EXISTS (SELECT 1 FROM saved)
  LIMIT 1;
$function$;