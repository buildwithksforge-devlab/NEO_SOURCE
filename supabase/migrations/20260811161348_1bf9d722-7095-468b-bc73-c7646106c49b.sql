-- 1. Restore Data API grants for every table in the public schema (RLS still applies).
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t.tablename);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t.tablename);
  END LOOP;
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'v' LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t.relname);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t.relname);
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO authenticated, service_role;

-- 2. Front Office Manager: full PMS operational authority (except system settings).
INSERT INTO public.role_permissions (organization_id, role_id, permission_id)
SELECT r.organization_id, r.id, p.id
FROM public.roles r
JOIN public.permissions p
  ON p.module = 'pms'
 AND p.action <> 'settings.manage'
WHERE r.name = 'Front Office Manager'
ON CONFLICT DO NOTHING;

-- 3. Receptionist: day-to-day desk authority.
INSERT INTO public.role_permissions (organization_id, role_id, permission_id)
SELECT r.organization_id, r.id, p.id
FROM public.roles r
JOIN public.permissions p
  ON p.module = 'pms'
 AND p.action IN (
   'dashboard.view','reservations.view','reservations.create','reservations.edit',
   'reservations.confirm','reservations.cancel','reservations.mark_no_show',
   'availability.view','rooms.view','rooms.assign','checkin.perform','checkout.perform',
   'folios.view','folios.create','folios.post_charge','payments.record',
   'reports.view','ota.view','rate_override.request','complimentary.request','refunds.request'
 )
WHERE r.name = 'Receptionist'
ON CONFLICT DO NOTHING;

-- 4. Missing operational stations, one per department, for every organisation.
INSERT INTO public.operational_stations (organization_id, branch_id, department_id, code, name, station_type)
SELECT d.organization_id, d.branch_id, d.id, s.code, s.name, 'service'
FROM public.departments d
JOIN (VALUES
  ('Front Office',       'FRONT-DESK',  'Reception / Front Desk'),
  ('Housekeeping',       'HSKP',        'Housekeeping'),
  ('Finance',            'ACCOUNTS',    'Accounts'),
  ('Procurement',        'PROC',        'Procurement'),
  ('Inventory & Stores', 'MAIN-STORE',  'Main Store'),
  ('Marketing',          'MKTG',        'Marketing'),
  ('Events',             'EVENTS',      'Events'),
  ('Maintenance',        'MAINT',       'Maintenance'),
  ('Delivery',           'DELIV',       'Delivery'),
  ('Human Resources',    'HR',          'HR'),
  ('Administration',     'ADMIN',       'Administration')
) AS s(dept, code, name) ON s.dept = d.name
WHERE NOT EXISTS (
  SELECT 1 FROM public.operational_stations os
  WHERE os.organization_id = d.organization_id
    AND os.department_id = d.id
    AND os.name = s.name
);