-- 1. Cashier / Finance Manager can complete a collection end to end.
INSERT INTO public.role_permissions (organization_id, role_id, permission_id, source)
SELECT r.organization_id, r.id, p.id, 'collection-authority'
FROM public.roles r
JOIN public.permissions p
  ON (p.module = 'pos' AND p.feature = '*' AND p.action IN ('payments.process','payments.view','payments.verify','receipts.print','bills.view','orders.view'))
  OR (p.module = 'pms' AND p.feature = '*' AND p.action = 'payments.record')
  OR (p.module = 'events' AND p.feature = 'billing' AND p.action IN ('create','view'))
WHERE r.name IN ('Cashier','Finance Manager')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- 2. Retire the two withdrawn roles (kept for history, never assignable again).
UPDATE public.roles
   SET active = false,
       role_status = 'archived',
       effective_until = COALESCE(effective_until, CURRENT_DATE),
       updated_at = now()
 WHERE name IN ('General Manager','Night Auditor');