CREATE OR REPLACE FUNCTION public.dashboard_key_for_role(_role_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT CASE _role_name
    WHEN 'Owner' THEN 'owner'
    WHEN 'System Administrator' THEN 'administration'
    WHEN 'General Manager' THEN 'general-manager'
    WHEN 'Operations Manager' THEN 'general-manager'
    WHEN 'Finance Manager' THEN 'finance'
    WHEN 'Accountant' THEN 'finance'
    WHEN 'Front Office Manager' THEN 'front-office'
    WHEN 'Receptionist' THEN 'front-office'
    WHEN 'Restaurant Manager' THEN 'restaurant-operations'
    WHEN 'Waiter / Waitress' THEN 'restaurant-floor'
    WHEN 'Barista' THEN 'coffee-station'
    WHEN 'Coffee Station Supervisor' THEN 'coffee-station'
    WHEN 'Bar Manager' THEN 'bar'
    WHEN 'Bar Attendant' THEN 'bar'
    WHEN 'Kitchen Manager' THEN 'kitchen-overview'
    WHEN 'Hot Kitchen Supervisor' THEN 'hot-kitchen'
    WHEN 'Chef' THEN 'hot-kitchen'
    WHEN 'Pastry Supervisor' THEN 'pastry'
    WHEN 'Pastry Chef' THEN 'pastry'
    WHEN 'Housekeeping Supervisor' THEN 'housekeeping'
    WHEN 'Housekeeper' THEN 'housekeeping'
    WHEN 'Procurement Officer' THEN 'procurement'
    WHEN 'Storekeeper' THEN 'stores'
    WHEN 'Marketing Manager' THEN 'marketing'
    WHEN 'Events Manager' THEN 'events'
    WHEN 'Delivery Manager' THEN 'delivery'
    WHEN 'Rider' THEN 'delivery'
    WHEN 'Human Resources' THEN 'human-resources'
    WHEN 'Maintenance Officer' THEN 'maintenance'
    ELSE NULL
  END;
$$;

REVOKE EXECUTE ON FUNCTION public.dashboard_metrics(uuid, uuid, uuid, timestamptz, timestamptz) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.tasks_trend(uuid, uuid, uuid, integer) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.department_workload() FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.station_workload() FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.my_dashboards() FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.evaluate_dashboard_alerts(uuid) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.seed_dashboard_catalogue(uuid) FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.dashboard_key_for_role(text) FROM anon, public;

GRANT EXECUTE ON FUNCTION public.dashboard_metrics(uuid, uuid, uuid, timestamptz, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tasks_trend(uuid, uuid, uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.department_workload() TO authenticated;
GRANT EXECUTE ON FUNCTION public.station_workload() TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_dashboards() TO authenticated;
GRANT EXECUTE ON FUNCTION public.evaluate_dashboard_alerts(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dashboard_key_for_role(text) TO authenticated;