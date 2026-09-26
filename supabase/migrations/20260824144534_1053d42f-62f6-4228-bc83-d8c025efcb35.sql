-- ============================================================
-- NEØ Final Departments & Roles (departments 1-17).
-- System Administration / it-system-administrator: untouched.
-- ============================================================

-- 1) New catalogue roles ------------------------------------------------
INSERT INTO public.role_catalogue
  (role_key, role_name, department, reports_to_key, multiplicity, access_scope,
   restricted_authority, optional_role, sort_order, summary, management_level, managerial_scope)
VALUES
  ('cashier','Cashier','Finance','finance-manager','multiple','self',false,false,230,
   'Collects payments and accounts for shift takings.',0,'self'),
  ('restaurant-manager','Restaurant Manager','Food & Beverage','food-and-beverage-manager','single','department',false,false,320,
   'Runs restaurant service, floor and covers.',50,'department'),
  ('bar-manager','Bar Manager','Bar','food-and-beverage-manager','single','department',false,false,400,
   'Runs the bar, its stock and its attendants.',60,'department'),
  ('front-office-manager','Front Office Manager','Front Office','operations-manager','single','department',false,false,600,
   'Runs front office, reservations and the guest arrival experience.',70,'department'),
  ('housekeeping-manager','Housekeeping Manager','Housekeeping','operations-manager','single','department',false,false,700,
   'Runs housekeeping and room readiness.',70,'department'),
  ('laundry-manager','Laundry Manager','Laundry','operations-manager','single','department',false,false,900,
   'Runs laundry production and guest laundry.',60,'department'),
  ('social-media-manager','Social Media Manager','Marketing','marketing-manager','multiple','team',false,false,1220,
   'Runs social channels and content calendar.',30,'team')
ON CONFLICT (role_key) DO UPDATE SET
  role_name = EXCLUDED.role_name,
  department = EXCLUDED.department,
  reports_to_key = EXCLUDED.reports_to_key,
  access_scope = EXCLUDED.access_scope,
  management_level = EXCLUDED.management_level,
  managerial_scope = EXCLUDED.managerial_scope,
  sort_order = EXCLUDED.sort_order,
  retired = false,
  updated_at = now();

-- 2) Departments 1-17: canonical department, reporting line and titles ---
UPDATE public.role_catalogue SET role_name='Owner / Director', department='Executive Management',
       reports_to_key=NULL, sort_order=100, updated_at=now() WHERE role_key='owner';
UPDATE public.role_catalogue SET department='Executive Management', reports_to_key='owner',
       sort_order=110, updated_at=now() WHERE role_key='operations-manager';

UPDATE public.role_catalogue SET department='Finance', reports_to_key='owner', sort_order=210,
       updated_at=now() WHERE role_key='finance-manager';
UPDATE public.role_catalogue SET department='Finance', reports_to_key='finance-manager', sort_order=220,
       updated_at=now() WHERE role_key='accountant';

UPDATE public.role_catalogue SET role_name='F&B Manager', department='Food & Beverage',
       reports_to_key='operations-manager', sort_order=310, updated_at=now()
 WHERE role_key='food-and-beverage-manager';
UPDATE public.role_catalogue SET department='Food & Beverage', reports_to_key='restaurant-manager',
       sort_order=330, updated_at=now() WHERE role_key='coffee-station-supervisor';
UPDATE public.role_catalogue SET department='Food & Beverage', reports_to_key='restaurant-manager',
       sort_order=340, updated_at=now() WHERE role_key='waiter';
UPDATE public.role_catalogue SET department='Food & Beverage', reports_to_key='coffee-station-supervisor',
       sort_order=350, updated_at=now() WHERE role_key='barista';

UPDATE public.role_catalogue SET department='Bar', reports_to_key='bar-manager', sort_order=410,
       updated_at=now() WHERE role_key='bar-attendant';

UPDATE public.role_catalogue SET department='Delivery', reports_to_key='operations-manager',
       sort_order=510, updated_at=now() WHERE role_key='delivery-manager';
UPDATE public.role_catalogue SET role_name='Rider / Driver', department='Delivery',
       reports_to_key='delivery-manager', sort_order=520, updated_at=now() WHERE role_key='rider';

UPDATE public.role_catalogue SET department='Front Office', reports_to_key='front-office-manager',
       sort_order=610, updated_at=now() WHERE role_key='receptionist';

UPDATE public.role_catalogue SET department='Housekeeping', reports_to_key='housekeeping-manager',
       sort_order=710, updated_at=now() WHERE role_key='housekeeper';

UPDATE public.role_catalogue SET department='Inventory & Stores', reports_to_key='operations-manager',
       sort_order=810, updated_at=now() WHERE role_key='storekeeper';
UPDATE public.role_catalogue SET department='Inventory & Stores', reports_to_key='storekeeper',
       sort_order=820, updated_at=now() WHERE role_key='receiving-clerk';

UPDATE public.role_catalogue SET department='Laundry', reports_to_key='laundry-manager',
       sort_order=910, updated_at=now() WHERE role_key='laundry-attendant';

UPDATE public.role_catalogue SET department='Human Resources', reports_to_key='owner',
       sort_order=1010, updated_at=now() WHERE role_key='human-resources-manager';

UPDATE public.role_catalogue SET department='Procurement', reports_to_key='operations-manager',
       sort_order=1110, updated_at=now() WHERE role_key='procurement-manager';

UPDATE public.role_catalogue SET department='Marketing', reports_to_key='operations-manager',
       sort_order=1210, updated_at=now() WHERE role_key='marketing-manager';

UPDATE public.role_catalogue SET role_name='Sales & Events Manager', department='Sales, Events & Banqueting',
       reports_to_key='operations-manager', sort_order=1310, updated_at=now()
 WHERE role_key='sales-and-events-manager';
UPDATE public.role_catalogue SET department='Sales, Events & Banqueting',
       reports_to_key='sales-and-events-manager', sort_order=1320, updated_at=now()
 WHERE role_key='banqueting-staff';

UPDATE public.role_catalogue SET role_name='Maintenance & Landscaping Manager',
       department='Maintenance & Landscaping', reports_to_key='operations-manager', sort_order=1410,
       updated_at=now() WHERE role_key='maintenance-manager';
UPDATE public.role_catalogue SET role_name='Maintenance Officer', department='Maintenance & Landscaping',
       reports_to_key='maintenance-manager', access_scope='team', management_level=30, sort_order=1420,
       updated_at=now() WHERE role_key='maintenance-officer';
UPDATE public.role_catalogue SET role_name='Ground Worker', department='Maintenance & Landscaping',
       reports_to_key='maintenance-manager', sort_order=1430, updated_at=now() WHERE role_key='grounds-worker';

UPDATE public.role_catalogue SET role_name='Kitchen Manager / Head Chef', department='Main Kitchen',
       reports_to_key='operations-manager', sort_order=1510, updated_at=now() WHERE role_key='head-chef';
UPDATE public.role_catalogue SET department='Main Kitchen', reports_to_key='head-chef', sort_order=1520,
       updated_at=now() WHERE role_key='hot-kitchen-supervisor';
UPDATE public.role_catalogue SET department='Main Kitchen', reports_to_key='hot-kitchen-supervisor',
       sort_order=1530, updated_at=now() WHERE role_key='hot-kitchen-chef';
UPDATE public.role_catalogue SET department='Main Kitchen', reports_to_key='head-chef', sort_order=1540,
       updated_at=now() WHERE role_key='kitchen-steward';

UPDATE public.role_catalogue SET department='Pastry & Bakery', reports_to_key='head-chef', sort_order=1610,
       updated_at=now() WHERE role_key='head-pastry-chef';
UPDATE public.role_catalogue SET department='Pastry & Bakery', reports_to_key='head-pastry-chef',
       sort_order=1620, updated_at=now() WHERE role_key='pastry-chef';

UPDATE public.role_catalogue SET department='Security', reports_to_key='operations-manager', sort_order=1710,
       updated_at=now() WHERE role_key='security-supervisor';
UPDATE public.role_catalogue SET department='Security', reports_to_key='security-supervisor', sort_order=1720,
       updated_at=now() WHERE role_key='security-guard';

-- System Administration (18): explicitly left as-is.
UPDATE public.role_catalogue SET sort_order=1800, updated_at=now() WHERE role_key='it-system-administrator';

-- 3) Retire everything outside the final structure (never deleted) ------
UPDATE public.role_catalogue SET retired = true, updated_at = now()
 WHERE role_key IN (
   'general-manager','night-auditor','reservations-agent','front-office-cashier','porter','driver',
   'hr-officer','chief-steward','procurement-officer','events-coordinator','stores-manager',
   'front-office-supervisor','housekeeping-supervisor','laundry-supervisor','bar-supervisor',
   'restaurant-supervisor','maintenance-technician'
 );

-- 4) Recognised equivalents so old titles resolve to the new roles ------
INSERT INTO public.role_catalogue_aliases (alias_key, role_key, ambiguous, review_reason) VALUES
  ('front office supervisor','front-office-manager',false,''),
  ('front office manager','front-office-manager',false,''),
  ('housekeeping supervisor','housekeeping-manager',false,''),
  ('housekeeping manager','housekeeping-manager',false,''),
  ('laundry supervisor','laundry-manager',false,''),
  ('laundry manager','laundry-manager',false,''),
  ('bar supervisor','bar-manager',false,''),
  ('bar manager','bar-manager',false,''),
  ('restaurant supervisor','restaurant-manager',false,''),
  ('restaurant manager','restaurant-manager',false,''),
  ('maintenance technician','maintenance-officer',false,''),
  ('maintenance officer','maintenance-officer',false,''),
  ('hot kitchen supervisor','hot-kitchen-supervisor',false,''),
  ('coffee station supervisor','coffee-station-supervisor',false,''),
  ('kitchen manager','head-chef',false,''),
  ('head chef','head-chef',false,''),
  ('cashier','cashier',false,''),
  ('social media manager','social-media-manager',false,''),
  ('ground worker','grounds-worker',false,''),
  ('grounds worker','grounds-worker',false,''),
  ('f b manager','food-and-beverage-manager',false,''),
  ('owner director','owner',false,'')
ON CONFLICT (alias_key) DO UPDATE SET
  role_key = EXCLUDED.role_key, ambiguous = false, review_reason = '';

-- 5) Capability templates for the new roles (mirror the role they replace)
INSERT INTO public.role_feature_templates (role_key, module, feature, action)
SELECT 'housekeeping-manager', module, feature, action FROM public.role_feature_templates WHERE role_key='housekeeping-supervisor'
UNION ALL
SELECT 'laundry-manager', module, feature, action FROM public.role_feature_templates WHERE role_key='laundry-supervisor'
UNION ALL
SELECT 'maintenance-officer', module, feature, action FROM public.role_feature_templates WHERE role_key='maintenance-technician'
ON CONFLICT DO NOTHING;

INSERT INTO public.role_feature_templates (role_key, module, feature, action)
VALUES
  ('restaurant-manager','restaurant','*','view'),
  ('restaurant-manager','kitchen','queue','view'),
  ('restaurant-manager','stores','overview','view'),
  ('bar-manager','restaurant','floor','view'),
  ('bar-manager','restaurant','orders','view'),
  ('bar-manager','restaurant','menu','view'),
  ('bar-manager','restaurant','shifts','view'),
  ('bar-manager','restaurant','reports','view'),
  ('bar-manager','stores','overview','view'),
  ('cashier','finance','overview','view'),
  ('cashier','finance','receivables','view'),
  ('cashier','front-office','folios','view'),
  ('cashier','restaurant','shifts','view'),
  ('social-media-manager','marketing','overview','view'),
  ('social-media-manager','marketing','campaigns','view'),
  ('social-media-manager','marketing','content','view'),
  ('hot-kitchen-supervisor','kitchen','overview','view'),
  ('hot-kitchen-supervisor','kitchen','queue','view'),
  ('hot-kitchen-supervisor','kitchen','production','view'),
  ('hot-kitchen-supervisor','kitchen','recipes','view'),
  ('hot-kitchen-supervisor','restaurant','kds','view')
ON CONFLICT DO NOTHING;
