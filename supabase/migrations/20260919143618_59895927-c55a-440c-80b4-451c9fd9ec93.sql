-- Stage 1: canonical table classification for tenant-scale indexing
CREATE OR REPLACE FUNCTION public.neo_index_class(_table text)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH t AS (
    SELECT c.oid,
      EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='organization_id' AND NOT a.attisdropped) AS has_org,
      EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='branch_id' AND NOT a.attisdropped) AS has_branch,
      EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='status' AND NOT a.attisdropped) AS has_status,
      EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='created_at' AND NOT a.attisdropped) AS has_created,
      EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='name' AND NOT a.attisdropped) AS has_name
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND c.relname=_table
  )
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM t) THEN NULL
    WHEN NOT (SELECT has_org FROM t) THEN 'F'
    WHEN _table ~ '_(lines|items|ingredients|modifiers|results|recipients|steps|evidence|acknowledgments)$'
      AND NOT (SELECT has_branch FROM t) THEN 'E'
    WHEN (SELECT has_created FROM t) AND (
      _table ~ '(_logs|_log|_events|_movements|_history|_transactions|_records|_entries|_snapshots|_tickets|_orders|_attempts|_queue|_requests|_jobs|_payments|_invoices|_receipts|_shifts|_takes|_adjustments|_counts|_tabs|_sessions|_bookings|_reservations|_assignments|_allocations|_readings|_checks|_tasks)'
      OR _table IN ('notifications','audit_logs','tasks','stays','refunds','defects','budgets','carts')
    ) THEN 'A'
    WHEN (SELECT has_status FROM t) AND (SELECT has_branch FROM t) THEN 'B'
    WHEN (SELECT has_name FROM t) THEN 'C'
    ELSE 'D'
  END;
$$;

COMMENT ON FUNCTION public.neo_index_class(text) IS
'Tenant-scale indexing class. A=high-volume operational feed, B=filtered work queue, C=master data, D=configuration, E=child/line table read through its parent, F=platform catalogue with no tenant key.';

-- Stage 5 guard: every A/B table must carry an index led by organization_id
CREATE OR REPLACE FUNCTION public.neo_index_coverage_scan()
RETURNS TABLE(table_name text, index_class text, live_rows bigint, seq_scans bigint, covered boolean)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT c.relname::text,
         public.neo_index_class(c.relname),
         coalesce(s.n_live_tup,0)::bigint,
         coalesce(s.seq_scan,0)::bigint,
         EXISTS (SELECT 1 FROM pg_index ix
                 WHERE ix.indrelid=c.oid
                   AND pg_get_indexdef(ix.indexrelid) ILIKE '%(organization_id%')
  FROM pg_class c
  JOIN pg_namespace n ON n.oid=c.relnamespace
  LEFT JOIN pg_stat_user_tables s ON s.relid=c.oid
  WHERE n.nspname='public' AND c.relkind='r'
    AND public.neo_index_class(c.relname) IN ('A','B')
    AND NOT EXISTS (SELECT 1 FROM pg_index ix
                    WHERE ix.indrelid=c.oid
                      AND pg_get_indexdef(ix.indexrelid) ILIKE '%(organization_id%')
  ORDER BY coalesce(s.seq_scan,0) DESC;
$$;

COMMENT ON FUNCTION public.neo_index_coverage_scan() IS
'Lists class A and B tables that have no index led by organization_id. Empty result = tenant-scale index coverage intact.';

REVOKE ALL ON FUNCTION public.neo_index_class(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_index_coverage_scan() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_index_class(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_index_coverage_scan() TO authenticated, service_role;

-- Stage 2: create the class-appropriate index for every uncovered A/B table
DO $do$
DECLARE
  r record;
  cols text;
  idx text;
BEGIN
  FOR r IN
    SELECT c.oid, c.relname,
      EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='branch_id' AND NOT a.attisdropped) AS has_branch,
      EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='status' AND NOT a.attisdropped) AS has_status,
      EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='created_at' AND NOT a.attisdropped) AS has_created
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r'
      AND public.neo_index_class(c.relname) IN ('A','B')
      AND NOT EXISTS (SELECT 1 FROM pg_index ix WHERE ix.indrelid=c.oid
                      AND pg_get_indexdef(ix.indexrelid) ILIKE '%(organization_id%')
  LOOP
    IF r.has_branch AND r.has_status AND r.has_created THEN
      cols := '(organization_id, branch_id, status, created_at DESC)';
    ELSIF r.has_branch AND r.has_created THEN
      cols := '(organization_id, branch_id, created_at DESC)';
    ELSIF r.has_created THEN
      cols := '(organization_id, created_at DESC)';
    ELSIF r.has_branch THEN
      cols := '(organization_id, branch_id)';
    ELSE
      cols := '(organization_id)';
    END IF;

    idx := left('idx_' || r.relname || '_org_scope', 63);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I %s', idx, r.relname, cols);
  END LOOP;
END
$do$;

-- Stage 2 (class E): child tables are read through their parent, so index the parent key
CREATE INDEX IF NOT EXISTS idx_purchase_order_lines_order ON public.purchase_order_lines (order_id);
CREATE INDEX IF NOT EXISTS idx_purchase_request_lines_request ON public.purchase_request_lines (request_id);
CREATE INDEX IF NOT EXISTS idx_supplier_invoice_lines_invoice ON public.supplier_invoice_lines (supplier_invoice_id);
CREATE INDEX IF NOT EXISTS idx_goods_receipt_lines_receipt ON public.goods_receipt_lines (receipt_id);
CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_recipe ON public.recipe_ingredients (recipe_id);
CREATE INDEX IF NOT EXISTS idx_pos_order_item_modifiers_order_item ON public.pos_order_item_modifiers (order_item_id);
CREATE INDEX IF NOT EXISTS idx_station_ticket_items_order_item ON public.station_ticket_items (order_item_id);
CREATE INDEX IF NOT EXISTS idx_journal_entry_lines_account ON public.journal_entry_lines (account_id);