
CREATE TABLE IF NOT EXISTS public.data_retention_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name text NOT NULL UNIQUE,
  domain text NOT NULL,
  time_column text NOT NULL,
  retention_months integer,
  archive_mode text NOT NULL DEFAULT 'report_only' CHECK (archive_mode IN ('report_only','archive')),
  partition_threshold_rows bigint NOT NULL DEFAULT 5000000,
  notes text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.data_retention_policies TO authenticated;
GRANT ALL ON public.data_retention_policies TO service_role;

ALTER TABLE public.data_retention_policies ENABLE ROW LEVEL SECURITY;

CREATE POLICY data_retention_policies_read ON public.data_retention_policies FOR SELECT TO authenticated
  USING (is_staff());

CREATE TRIGGER data_retention_policies_touch BEFORE UPDATE ON public.data_retention_policies
  FOR EACH ROW EXECUTE FUNCTION public.neo_touch_updated_at();

INSERT INTO public.data_retention_policies(table_name, domain, time_column, retention_months, notes)
VALUES
  ('journal_entries','finance','accounting_date', NULL, 'Statutory ledger. Retention period must be set by the hotel to match its audit obligations.'),
  ('journal_entry_lines','finance','created_at', NULL, 'Follows the journal it belongs to.'),
  ('payment_attempts','finance','created_at', NULL, 'Provider attempt history.'),
  ('payment_attempt_events','finance','created_at', NULL, 'Provider callback history.'),
  ('stock_movements','inventory','created_at', NULL, 'Stock ledger; underpins valuation.'),
  ('department_consumption','inventory','created_at', NULL, 'Consumption history.'),
  ('folio_lines','pms','posting_date', NULL, 'Guest ledger postings.'),
  ('reservations','pms','created_at', NULL, 'Stay records.'),
  ('reservation_history','pms','created_at', NULL, 'Stay change history.'),
  ('pos_orders','pos','created_at', NULL, 'Sales orders.'),
  ('pos_order_status_history','pos','created_at', NULL, 'Order status trail.')
ON CONFLICT (table_name) DO NOTHING;

CREATE OR REPLACE FUNCTION public.neo_retention_overview()
RETURNS TABLE(table_name text, domain text, live_rows bigint, total_bytes bigint, partitioned boolean,
              retention_months integer, rows_past_retention bigint, threshold_rows bigint,
              needs_partitioning boolean, blockers text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p record; n bigint; past bigint; oid_ regclass; part boolean; fks integer;
BEGIN
  IF NOT is_staff() THEN RAISE EXCEPTION 'permission_denied'; END IF;
  FOR p IN SELECT * FROM data_retention_policies WHERE enabled ORDER BY domain, table_name LOOP
    BEGIN
      oid_ := format('public.%I', p.table_name)::regclass;
    EXCEPTION WHEN OTHERS THEN CONTINUE; END;

    EXECUTE format('SELECT count(*) FROM public.%I', p.table_name) INTO n;
    past := 0;
    IF p.retention_months IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM public.%I WHERE %I < now() - make_interval(months => $1)', p.table_name, p.time_column)
        INTO past USING p.retention_months;
    END IF;
    SELECT c.relkind = 'p' INTO part FROM pg_class c WHERE c.oid = oid_;
    SELECT count(*) INTO fks FROM pg_constraint WHERE confrelid = oid_ AND contype = 'f';

    table_name := p.table_name; domain := p.domain; live_rows := n;
    total_bytes := pg_total_relation_size(oid_); partitioned := part;
    retention_months := p.retention_months; rows_past_retention := past;
    threshold_rows := p.partition_threshold_rows;
    needs_partitioning := (NOT part) AND n >= p.partition_threshold_rows;
    blockers := CASE WHEN fks > 0 THEN fks || ' table(s) reference this one; their foreign keys must be re-pointed before it can be split by month' ELSE NULL END;
    RETURN NEXT;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.neo_partition_maintain(_months_ahead integer DEFAULT 3)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE t record; i integer; start_d date; end_d date; pname text; created jsonb := '[]'::jsonb;
BEGIN
  IF NOT is_org_admin() THEN RAISE EXCEPTION 'permission_denied'; END IF;
  FOR t IN
    SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'p'
  LOOP
    FOR i IN 0.._months_ahead LOOP
      start_d := date_trunc('month', now())::date + make_interval(months => i);
      end_d := start_d + interval '1 month';
      pname := t.relname || '_p' || to_char(start_d, 'YYYYMM');
      IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = pname) THEN
        EXECUTE format('CREATE TABLE public.%I PARTITION OF public.%I FOR VALUES FROM (%L) TO (%L)',
                       pname, t.relname, start_d, end_d);
        created := created || jsonb_build_object('partition', pname);
      END IF;
    END LOOP;
  END LOOP;
  RETURN jsonb_build_object('created', created);
END $$;

CREATE OR REPLACE FUNCTION public.neo_retention_archive(_table text, _confirm boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p public.data_retention_policies; cutoff timestamptz; n bigint; arch text;
BEGIN
  IF NOT is_org_admin() THEN RAISE EXCEPTION 'permission_denied'; END IF;
  SELECT * INTO p FROM data_retention_policies WHERE table_name = _table AND enabled;
  IF p.id IS NULL THEN RAISE EXCEPTION 'No retention policy for %', _table; END IF;
  IF p.retention_months IS NULL THEN RAISE EXCEPTION 'No retention period has been set for %', _table; END IF;
  IF p.archive_mode <> 'archive' THEN RAISE EXCEPTION 'Archiving is not switched on for %', _table; END IF;

  cutoff := now() - make_interval(months => p.retention_months);
  EXECUTE format('SELECT count(*) FROM public.%I WHERE %I < $1', p.table_name, p.time_column) INTO n USING cutoff;
  IF NOT _confirm THEN
    RETURN jsonb_build_object('table', p.table_name, 'cutoff', cutoff, 'rows_to_archive', n, 'executed', false);
  END IF;

  arch := p.table_name || '_archive';
  EXECUTE format('CREATE TABLE IF NOT EXISTS public.%I (LIKE public.%I INCLUDING DEFAULTS)', arch, p.table_name);
  EXECUTE format('WITH moved AS (DELETE FROM public.%I WHERE %I < $1 RETURNING *) INSERT INTO public.%I SELECT * FROM moved',
                 p.table_name, p.time_column, arch) USING cutoff;
  RETURN jsonb_build_object('table', p.table_name, 'archive_table', arch, 'cutoff', cutoff, 'rows_archived', n, 'executed', true);
END $$;

REVOKE ALL ON FUNCTION public.neo_retention_overview() FROM anon, public;
REVOKE ALL ON FUNCTION public.neo_partition_maintain(integer) FROM anon, public;
REVOKE ALL ON FUNCTION public.neo_retention_archive(text, boolean) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.neo_retention_overview() TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_partition_maintain(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_retention_archive(text, boolean) TO authenticated;
