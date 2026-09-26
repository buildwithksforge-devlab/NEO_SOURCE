-- Desired feature templates for the four over-scoped roles.
CREATE TEMP TABLE _want(role_key text, module text, feature text) ON COMMIT DROP;

-- Operations Manager: every operational module, read and report only.
INSERT INTO _want(role_key, module, feature)
SELECT 'operations-manager', p.module, p.feature
  FROM public.permissions p
 WHERE p.module IN ('front-office','restaurant','bar','kitchen','housekeeping',
                    'laundry','maintenance','security-ops','stores','events',
                    'delivery','analytics','reports')
 GROUP BY p.module, p.feature;
INSERT INTO _want(role_key, module, feature) VALUES
  ('operations-manager','procurement','overview'),
  ('operations-manager','ai','insights');

INSERT INTO _want(role_key, module, feature) VALUES
  ('waiter','restaurant','overview'),
  ('waiter','restaurant','floor'),
  ('waiter','restaurant','orders'),
  ('waiter','restaurant','kds'),
  ('waiter','restaurant','shifts'),
  ('waiter','restaurant','wastage'),
  ('waiter','ai','insights'),
  ('barista','restaurant','overview'),
  ('barista','restaurant','floor'),
  ('barista','restaurant','orders'),
  ('barista','restaurant','kds'),
  ('barista','restaurant','shifts'),
  ('barista','restaurant','wastage'),
  ('barista','ai','insights'),
  ('coffee-station-supervisor','restaurant','overview'),
  ('coffee-station-supervisor','restaurant','orders'),
  ('coffee-station-supervisor','restaurant','kds'),
  ('coffee-station-supervisor','restaurant','shifts'),
  ('coffee-station-supervisor','restaurant','reports'),
  ('coffee-station-supervisor','restaurant','requisitions'),
  ('coffee-station-supervisor','restaurant','wastage'),
  ('coffee-station-supervisor','stores','overview'),
  ('coffee-station-supervisor','ai','insights'),
  ('storekeeper','stores','overview'),
  ('storekeeper','stores','items'),
  ('storekeeper','stores','issues'),
  ('storekeeper','stores','reconciliation'),
  ('storekeeper','procurement','receiving'),
  ('storekeeper','kitchen','stores'),
  ('storekeeper','ai','insights');

-- Scope actions, then the authority limits that keep oversight from becoming
-- operation.
CREATE TEMP TABLE _rows(role_key text, module text, feature text, action text) ON COMMIT DROP;

INSERT INTO _rows(role_key, module, feature, action)
SELECT w.role_key, w.module, w.feature, a.action
  FROM _want w
  CROSS JOIN LATERAL (
    SELECT unnest(CASE w.role_key
      WHEN 'operations-manager' THEN ARRAY['view','create','edit','approve','export','print']
      WHEN 'storekeeper' THEN ARRAY['view','create','edit','approve','export','print']
      WHEN 'coffee-station-supervisor' THEN ARRAY['view','create','edit','export']
      ELSE ARRAY['view','create','edit'] END) AS action
  ) a;

-- Operations Manager: read/report everywhere, decide only on what is escalated.
DELETE FROM _rows
 WHERE role_key = 'operations-manager'
   AND action NOT IN ('view','export','print')
   AND NOT (action = 'approve'
            AND feature IN ('approvals','wastage','waste','complimentary',
                            'requests','stock-needs','stock_needs','needs'));

-- Waiter / Barista: serve the floor, never author it.
DELETE FROM _rows
 WHERE role_key IN ('waiter','barista')
   AND module = 'restaurant' AND feature IN ('floor','shifts')
   AND action <> 'view';

-- Coffee supervisor: own counter only.
DELETE FROM _rows
 WHERE role_key = 'coffee-station-supervisor'
   AND module = 'restaurant' AND feature = 'shifts' AND action <> 'view';
DELETE FROM _rows
 WHERE role_key = 'coffee-station-supervisor'
   AND module = 'restaurant' AND feature = 'reports'
   AND action NOT IN ('view','export','print');

-- Store keeper: receive goods, do not buy them.
DELETE FROM _rows
 WHERE role_key = 'storekeeper'
   AND module = 'procurement' AND feature = 'receiving'
   AND action NOT IN ('view','create','edit');

-- AI entry is view-only for every role.
DELETE FROM _rows WHERE module = 'ai' AND action <> 'view';

-- Only capabilities the interface actually has.
DELETE FROM _rows r
 WHERE NOT EXISTS (
   SELECT 1 FROM public.permissions p
    WHERE p.module = r.module AND p.feature = r.feature AND p.action = r.action);

DELETE FROM public.role_feature_templates
 WHERE role_key IN ('operations-manager','waiter','barista',
                    'coffee-station-supervisor','storekeeper');

INSERT INTO public.role_feature_templates(role_key, module, feature, action)
SELECT DISTINCT role_key, module, feature, action FROM _rows;

-- Recompile live grants for every workspace from the corrected templates.
DO $$
DECLARE _o uuid;
BEGIN
  FOR _o IN SELECT id FROM public.organizations LOOP
    PERFORM public.neo_apply_feature_templates(_o);
  END LOOP;
END $$;