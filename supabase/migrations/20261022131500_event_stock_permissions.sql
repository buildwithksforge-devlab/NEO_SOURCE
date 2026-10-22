-- NEØ E05: Register Events stock-need permissions.
-- Definitions only; no role grants or operational-data changes.

WITH required_permissions(module, feature, action, label) AS (
    VALUES
        ('events', 'stock_needs', 'view', 'View Events stock needs'),
        ('events', 'stock_needs', 'create', 'Report Events stock needs'),
        ('events', 'stock_needs', 'approve', 'Approve Events stock needs')
)
INSERT INTO public.permissions (
    module,
    feature,
    action,
    label
)
SELECT
    p.module,
    p.feature,
    p.action,
    p.label
FROM required_permissions p
WHERE NOT EXISTS (
    SELECT 1
    FROM public.permissions existing
    WHERE existing.module = p.module
      AND existing.feature = p.feature
      AND existing.action = p.action
);