
CREATE TABLE IF NOT EXISTS public.rbac_restoration_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  batch text NOT NULL,
  role_id uuid NOT NULL,
  role_name text NOT NULL,
  permission_id uuid NOT NULL,
  module text NOT NULL,
  feature text NOT NULL,
  action text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.rbac_restoration_snapshots TO authenticated;
GRANT ALL ON public.rbac_restoration_snapshots TO service_role;
ALTER TABLE public.rbac_restoration_snapshots ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='rbac_restoration_snapshots'
      AND policyname='rbac_snapshots_org_read'
  ) THEN
    EXECUTE $p$CREATE POLICY "rbac_snapshots_org_read" ON public.rbac_restoration_snapshots
      FOR SELECT TO authenticated
      USING (organization_id = public.current_org_id())$p$;
  END IF;
END $$;

-- 1. Snapshot the restricted finance grants held by roles whose policy withholds them.
WITH target_roles AS (
  SELECT r.id, r.name, r.organization_id
  FROM public.roles r
  JOIN public.role_catalogue rc ON rc.role_key = r.normalized_role_key
  WHERE r.active
    AND rc.retired = false
    AND rc.department = 'Finance'
    AND rc.restricted_authority = false
), target_perms AS (
  SELECT p.id, p.module, p.feature, p.action
  FROM public.permissions p
  WHERE p.module IN ('finance','finance-ap','finance-ar','finance-gl','finance-payments','finance-tax')
    AND p.action IN (
      'refund','refund_payment','refunds.approve','refunds.execute','refunds.request',
      'void','void_payment','override',
      'reverse_payment','payments.reverse.approve','payments.reverse.execute','payments.reverse.request',
      'reopen_period'
    )
)
INSERT INTO public.rbac_restoration_snapshots
  (organization_id, batch, role_id, role_name, permission_id, module, feature, action, reason)
SELECT tr.organization_id, 'finance-restricted-actions-2026-09-16', tr.id, tr.name,
       tp.id, tp.module, tp.feature, tp.action,
       'Role policy withholds restricted financial actions'
FROM public.role_permissions rp
JOIN target_roles tr ON tr.id = rp.role_id
JOIN target_perms tp ON tp.id = rp.permission_id
WHERE NOT EXISTS (
  SELECT 1 FROM public.rbac_restoration_snapshots s
  WHERE s.role_id = rp.role_id AND s.permission_id = rp.permission_id
    AND s.batch = 'finance-restricted-actions-2026-09-16'
);

-- 2. Remove exactly those snapshotted grants.
DELETE FROM public.role_permissions rp
USING public.rbac_restoration_snapshots s
WHERE s.batch = 'finance-restricted-actions-2026-09-16'
  AND rp.role_id = s.role_id
  AND rp.permission_id = s.permission_id;

-- 3. Keep the platform templates in step so Apply Missing cannot re-grant them.
DELETE FROM public.role_permission_templates t
WHERE t.template_key IN ('finance-manager','finance manager','accountant','cashier')
  AND t.module IN ('finance','finance-ap','finance-ar','finance-gl','finance-payments','finance-tax')
  AND t.action IN (
    'refund','refund_payment','refunds.approve','refunds.execute','refunds.request',
    'void','void_payment','override',
    'reverse_payment','payments.reverse.approve','payments.reverse.execute','payments.reverse.request',
    'reopen_period'
  );

-- 4. Retire stale Night Auditor role architecture (history untouched).
DELETE FROM public.role_permission_templates WHERE template_key IN ('night-auditor','night auditor');

UPDATE public.role_catalogue
SET can_manage_role_keys = array_remove(can_manage_role_keys, 'night-auditor'),
    updated_at = now()
WHERE 'night-auditor' = ANY(coalesce(can_manage_role_keys, '{}'));

UPDATE public.role_catalogue
SET retired = true, updated_at = now()
WHERE role_key = 'night-auditor' AND retired = false;

-- 5. Roles screen needs the recommended template to compute missing grants.
GRANT EXECUTE ON FUNCTION public.recommended_template_grants(uuid) TO authenticated;

INSERT INTO public.audit_logs(organization_id, action, module, record_id, new_value)
SELECT s.organization_id, 'rbac.restoration.finance_restricted_actions', 'administration',
       s.role_id::text,
       jsonb_build_object('removed', count(*), 'batch', s.batch)
FROM public.rbac_restoration_snapshots s
WHERE s.batch = 'finance-restricted-actions-2026-09-16'
GROUP BY s.organization_id, s.role_id, s.batch;
