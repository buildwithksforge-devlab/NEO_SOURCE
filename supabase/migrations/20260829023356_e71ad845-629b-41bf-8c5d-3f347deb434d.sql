-- 1. Register the missing feature-qualified permissions (additive).
INSERT INTO public.permissions (module, feature, action, label)
VALUES
  ('stores','items','view','View the stock item catalogue'),
  ('stores','items','create','Create stock items'),
  ('stores','items','edit','Edit stock items and thresholds'),
  ('procurement','orders','view','View purchase orders'),
  ('procurement','orders','create','Create purchase orders'),
  ('procurement','orders','edit','Edit purchase orders'),
  ('procurement','quotations','view','View RFQs and supplier quotations'),
  ('procurement','quotations','create','Create RFQs'),
  ('procurement','quotations','edit','Edit RFQs and record quotations'),
  ('procurement','quotations','manage','Manage RFQ despatch and selection')
ON CONFLICT DO NOTHING;

-- 2. Grant them to the roles that already carry the matching responsibility.
WITH wanted(role_key, module, feature, action) AS (
  VALUES
    ('procurement-manager','procurement','orders','view'),
    ('procurement-manager','procurement','orders','create'),
    ('procurement-manager','procurement','orders','edit'),
    ('procurement-manager','procurement','quotations','view'),
    ('procurement-manager','procurement','quotations','create'),
    ('procurement-manager','procurement','quotations','edit'),
    ('procurement-manager','procurement','quotations','manage'),
    ('procurement-manager','stores','items','view'),
    ('procurement-officer','procurement','orders','view'),
    ('procurement-officer','procurement','orders','create'),
    ('procurement-officer','procurement','orders','edit'),
    ('procurement-officer','procurement','quotations','view'),
    ('procurement-officer','procurement','quotations','create'),
    ('procurement-officer','procurement','quotations','edit'),
    ('storekeeper','stores','items','view'),
    ('storekeeper','stores','items','create'),
    ('storekeeper','stores','items','edit'),
    ('storekeeper','procurement','orders','view'),
    ('receiving-clerk','procurement','orders','view')
)
INSERT INTO public.role_permissions (organization_id, role_id, permission_id, source)
SELECT r.organization_id, r.id, p.id, 'template'
  FROM wanted w
  JOIN public.roles r ON r.normalized_role_key = w.role_key
  JOIN public.permissions p
    ON p.module = w.module AND p.feature = w.feature AND p.action = w.action
 WHERE NOT EXISTS (
   SELECT 1 FROM public.role_permissions rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id
 );