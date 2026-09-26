-- Access rules are rewritten so that the scope helpers are evaluated once per
-- statement (scalar sub-select => InitPlan) instead of once per row. The
-- logic below is an exact inline expansion of in_my_config_scope().

-- menu_items -----------------------------------------------------------
DROP POLICY IF EXISTS menu_items_select ON public.menu_items;
CREATE POLICY menu_items_select ON public.menu_items FOR SELECT
USING (
  organization_id = (SELECT public.current_org_id())
  AND CASE
    WHEN (SELECT public.current_access_scope()) = 'technical' THEN (SELECT public.is_org_admin())
    WHEN (SELECT public.current_access_scope()) = 'organisation' THEN true
    ELSE (branch_id IS NULL OR branch_id = ANY ((SELECT public.current_branch_ids())::uuid[]))
  END
);

DROP POLICY IF EXISTS menu_items_manage ON public.menu_items;
CREATE POLICY menu_items_manage ON public.menu_items FOR ALL
USING (
  organization_id = (SELECT public.current_org_id())
  AND CASE
    WHEN (SELECT public.current_access_scope()) = 'technical' THEN (SELECT public.is_org_admin())
    WHEN (SELECT public.current_access_scope()) = 'organisation' THEN true
    ELSE (branch_id IS NULL OR branch_id = ANY ((SELECT public.current_branch_ids())::uuid[]))
  END
  AND ((SELECT public.has_explicit_permission('pos','menu','manage'))
       OR (SELECT public.has_explicit_permission('pos','settings','manage')))
)
WITH CHECK (
  organization_id = (SELECT public.current_org_id())
  AND CASE
    WHEN (SELECT public.current_access_scope()) = 'technical' THEN (SELECT public.is_org_admin())
    WHEN (SELECT public.current_access_scope()) = 'organisation' THEN true
    ELSE (branch_id IS NULL OR branch_id = ANY ((SELECT public.current_branch_ids())::uuid[]))
  END
  AND ((SELECT public.has_explicit_permission('pos','menu','manage'))
       OR (SELECT public.has_explicit_permission('pos','settings','manage')))
);

-- menu_categories ------------------------------------------------------
DROP POLICY IF EXISTS menu_categories_select ON public.menu_categories;
CREATE POLICY menu_categories_select ON public.menu_categories FOR SELECT
USING (
  organization_id = (SELECT public.current_org_id())
  AND CASE
    WHEN (SELECT public.current_access_scope()) = 'technical' THEN (SELECT public.is_org_admin())
    ELSE true
  END
);

DROP POLICY IF EXISTS menu_categories_manage ON public.menu_categories;
CREATE POLICY menu_categories_manage ON public.menu_categories FOR ALL
USING (
  organization_id = (SELECT public.current_org_id())
  AND CASE
    WHEN (SELECT public.current_access_scope()) = 'technical' THEN (SELECT public.is_org_admin())
    ELSE true
  END
  AND ((SELECT public.has_permission('pos','menu.manage'))
       OR (SELECT public.has_permission('pos','settings.manage'))
       OR (SELECT public.has_permission('pos','tables.manage')))
)
WITH CHECK (
  organization_id = (SELECT public.current_org_id())
  AND CASE
    WHEN (SELECT public.current_access_scope()) = 'technical' THEN (SELECT public.is_org_admin())
    ELSE true
  END
  AND ((SELECT public.has_permission('pos','menu.manage'))
       OR (SELECT public.has_permission('pos','settings.manage'))
       OR (SELECT public.has_permission('pos','tables.manage')))
);

-- stock_items ----------------------------------------------------------
DROP POLICY IF EXISTS stock_items_select ON public.stock_items;
CREATE POLICY stock_items_select ON public.stock_items FOR SELECT
USING (
  organization_id = (SELECT public.current_org_id())
  AND CASE
    WHEN (SELECT public.current_access_scope()) = 'technical' THEN (SELECT public.is_org_admin())
    WHEN (SELECT public.current_access_scope()) = 'organisation' THEN true
    ELSE (branch_id IS NULL OR branch_id = ANY ((SELECT public.current_branch_ids())::uuid[]))
  END
);

DROP POLICY IF EXISTS stock_items_write ON public.stock_items;
CREATE POLICY stock_items_write ON public.stock_items FOR ALL
USING (
  organization_id = (SELECT public.current_org_id())
  AND CASE
    WHEN (SELECT public.current_access_scope()) = 'technical' THEN (SELECT public.is_org_admin())
    WHEN (SELECT public.current_access_scope()) = 'organisation' THEN true
    ELSE (branch_id IS NULL OR branch_id = ANY ((SELECT public.current_branch_ids())::uuid[]))
  END
  AND (SELECT public.has_permission('inventory','items.manage'))
)
WITH CHECK (
  organization_id = (SELECT public.current_org_id())
  AND CASE
    WHEN (SELECT public.current_access_scope()) = 'technical' THEN (SELECT public.is_org_admin())
    WHEN (SELECT public.current_access_scope()) = 'organisation' THEN true
    ELSE (branch_id IS NULL OR branch_id = ANY ((SELECT public.current_branch_ids())::uuid[]))
  END
  AND (SELECT public.has_permission('inventory','items.manage'))
);

-- stock_levels ---------------------------------------------------------
DROP POLICY IF EXISTS stock_levels_select ON public.stock_levels;
CREATE POLICY stock_levels_select ON public.stock_levels FOR SELECT
USING (
  organization_id = (SELECT public.current_org_id())
  AND (SELECT public.can_read_stock())
  AND (
    (location_id IS NULL AND CASE
        WHEN (SELECT public.current_access_scope()) = 'technical' THEN (SELECT public.is_org_admin())
        ELSE true
      END)
    OR EXISTS (
      SELECT 1 FROM public.stock_locations l
      WHERE l.id = stock_levels.location_id
        AND l.organization_id = (SELECT public.current_org_id())
        AND CASE
          WHEN (SELECT public.current_access_scope()) = 'technical' THEN (SELECT public.is_org_admin())
          WHEN (SELECT public.current_access_scope()) = 'organisation' THEN true
          ELSE (l.branch_id IS NULL OR l.branch_id = ANY ((SELECT public.current_branch_ids())::uuid[]))
        END
    )
  )
);

DROP POLICY IF EXISTS stock_levels_write ON public.stock_levels;
CREATE POLICY stock_levels_write ON public.stock_levels FOR ALL
USING (
  organization_id = (SELECT public.current_org_id())
  AND (SELECT public.has_permission('inventory','stock.manage'))
  AND (
    (location_id IS NULL AND CASE
        WHEN (SELECT public.current_access_scope()) = 'technical' THEN (SELECT public.is_org_admin())
        ELSE true
      END)
    OR EXISTS (
      SELECT 1 FROM public.stock_locations l
      WHERE l.id = stock_levels.location_id
        AND l.organization_id = (SELECT public.current_org_id())
        AND CASE
          WHEN (SELECT public.current_access_scope()) = 'technical' THEN (SELECT public.is_org_admin())
          WHEN (SELECT public.current_access_scope()) = 'organisation' THEN true
          ELSE (l.branch_id IS NULL OR l.branch_id = ANY ((SELECT public.current_branch_ids())::uuid[]))
        END
    )
  )
)
WITH CHECK (
  organization_id = (SELECT public.current_org_id())
  AND (SELECT public.has_permission('inventory','stock.manage'))
  AND (
    (location_id IS NULL AND CASE
        WHEN (SELECT public.current_access_scope()) = 'technical' THEN (SELECT public.is_org_admin())
        ELSE true
      END)
    OR EXISTS (
      SELECT 1 FROM public.stock_locations l
      WHERE l.id = stock_levels.location_id
        AND l.organization_id = (SELECT public.current_org_id())
        AND CASE
          WHEN (SELECT public.current_access_scope()) = 'technical' THEN (SELECT public.is_org_admin())
          WHEN (SELECT public.current_access_scope()) = 'organisation' THEN true
          ELSE (l.branch_id IS NULL OR l.branch_id = ANY ((SELECT public.current_branch_ids())::uuid[]))
        END
    )
  )
);

-- notifications --------------------------------------------------------
DROP POLICY IF EXISTS "notifications read" ON public.notifications;
CREATE POLICY "notifications read" ON public.notifications FOR SELECT
USING (
  organization_id = (SELECT public.current_org_id())
  AND (
    user_id = (SELECT auth.uid())
    OR acted_by = (SELECT auth.uid())
    OR (user_id IS NULL AND public.in_my_scope(organization_id, branch_id, department_id, station_id, NULL::uuid, NULL::uuid))
  )
);

DROP POLICY IF EXISTS "notifications update" ON public.notifications;
CREATE POLICY "notifications update" ON public.notifications FOR UPDATE
USING (
  organization_id = (SELECT public.current_org_id())
  AND (
    user_id = (SELECT auth.uid())
    OR (user_id IS NULL AND public.in_my_scope(organization_id, branch_id, department_id, station_id, NULL::uuid, NULL::uuid))
  )
);

DROP POLICY IF EXISTS "notifications delete" ON public.notifications;
CREATE POLICY "notifications delete" ON public.notifications FOR DELETE
USING (
  organization_id = (SELECT public.current_org_id())
  AND user_id = (SELECT auth.uid())
);

-- neo_test_results -----------------------------------------------------
DROP POLICY IF EXISTS neo_test_results_read ON public.neo_test_results;
CREATE POLICY neo_test_results_read ON public.neo_test_results FOR SELECT
USING (
  control_org_id = (SELECT public.current_org_id())
  AND (SELECT public.is_org_admin_for((SELECT public.current_org_id())))
);

-- organization_settings ------------------------------------------------
DROP POLICY IF EXISTS "org members read settings" ON public.organization_settings;
CREATE POLICY "org members read settings" ON public.organization_settings FOR SELECT
USING (organization_id = (SELECT public.current_org_id()));

DROP POLICY IF EXISTS "org admins update settings" ON public.organization_settings;
CREATE POLICY "org admins update settings" ON public.organization_settings FOR UPDATE
USING (organization_id = (SELECT public.current_org_id()) AND (SELECT public.is_org_admin()));

-- Supporting indexes ---------------------------------------------------
CREATE INDEX IF NOT EXISTS menu_items_branch_order_idx
  ON public.menu_items (organization_id, branch_id, display_order, name);
CREATE INDEX IF NOT EXISTS menu_categories_org_order_idx
  ON public.menu_categories (organization_id, display_order, name);
CREATE INDEX IF NOT EXISTS notifications_org_branch_recent_idx
  ON public.notifications (organization_id, branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_org_user_recent_idx
  ON public.notifications (organization_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS stock_levels_location_idx
  ON public.stock_levels (location_id, stock_item_id);
CREATE INDEX IF NOT EXISTS stock_levels_org_item_idx
  ON public.stock_levels (organization_id, stock_item_id);
CREATE INDEX IF NOT EXISTS stock_items_org_name_active_idx
  ON public.stock_items (organization_id, active, name);
CREATE INDEX IF NOT EXISTS stock_locations_org_branch_idx
  ON public.stock_locations (organization_id, branch_id);
CREATE INDEX IF NOT EXISTS user_roles_user_org_idx
  ON public.user_roles (user_id, organization_id);
CREATE INDEX IF NOT EXISTS role_permissions_org_role_idx
  ON public.role_permissions (organization_id, role_id);
CREATE INDEX IF NOT EXISTS user_permissions_user_org_effect_idx
  ON public.user_permissions (user_id, organization_id, effect);

ANALYZE public.menu_items;
ANALYZE public.menu_categories;
ANALYZE public.notifications;
ANALYZE public.stock_items;
ANALYZE public.stock_levels;