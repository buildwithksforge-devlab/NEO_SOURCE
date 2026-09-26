-- Stage 3: hoist constant-argument context calls out of per-row policy evaluation.
-- Semantics are identical; only the number of evaluations changes.
DROP POLICY IF EXISTS "audit admin read" ON public.audit_logs;
CREATE POLICY "audit admin read" ON public.audit_logs
  FOR SELECT TO authenticated
  USING (
    (SELECT public.current_org_id()) IS NOT NULL
    AND organization_id = (SELECT public.current_org_id())
    AND ((SELECT public.is_org_admin()) OR user_id = (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS "audit insert" ON public.audit_logs;
CREATE POLICY "audit insert" ON public.audit_logs
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT public.current_org_id()) IS NOT NULL
    AND organization_id = (SELECT public.current_org_id())
    AND user_id = (SELECT auth.uid())
  );

DROP POLICY IF EXISTS "stock_movements_select" ON public.stock_movements;
CREATE POLICY "stock_movements_select" ON public.stock_movements
  FOR SELECT TO authenticated
  USING (
    (SELECT public.can_read_stock())
    AND (
      public.in_my_config_scope(organization_id, branch_id)
      OR EXISTS (
        SELECT 1 FROM public.stock_locations l
        WHERE l.id = stock_movements.location_id
          AND public.in_my_config_scope(l.organization_id, l.branch_id)
      )
    )
  );

DROP POLICY IF EXISTS "stock_movements_write" ON public.stock_movements;
CREATE POLICY "stock_movements_write" ON public.stock_movements
  FOR ALL TO authenticated
  USING (
    (SELECT public.has_permission('inventory', 'stock.manage'))
    AND (
      public.in_my_config_scope(organization_id, branch_id)
      OR EXISTS (
        SELECT 1 FROM public.stock_locations l
        WHERE l.id = stock_movements.location_id
          AND public.in_my_config_scope(l.organization_id, l.branch_id)
      )
    )
  )
  WITH CHECK (
    (SELECT public.has_permission('inventory', 'stock.manage'))
    AND (
      public.in_my_config_scope(organization_id, branch_id)
      OR EXISTS (
        SELECT 1 FROM public.stock_locations l
        WHERE l.id = stock_movements.location_id
          AND public.in_my_config_scope(l.organization_id, l.branch_id)
      )
    )
  );

-- Stage 4: remove indexes fully subsumed by a stricter surviving unique index.
-- event_bookings keeps UNIQUE (organization_id, event_reference) as a constraint.
DROP INDEX IF EXISTS public.event_bookings_org_reference_uidx;
DROP INDEX IF EXISTS public.event_bookings_org_branch_reference_key;
-- domain_events keeps UNIQUE (organization_id, idempotency_key).
DROP INDEX IF EXISTS public.domain_events_idempotency_unique;
-- notifications keeps the strictest UNIQUE (organization_id, idempotency_key).
DROP INDEX IF EXISTS public.notifications_idem_idx;
DROP INDEX IF EXISTS public.notifications_idempotency_unique;