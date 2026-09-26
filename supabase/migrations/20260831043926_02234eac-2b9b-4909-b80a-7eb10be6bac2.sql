CREATE OR REPLACE FUNCTION public.neo_journal_register(_branch uuid DEFAULT NULL::uuid, _from date DEFAULT NULL::date, _to date DEFAULT NULL::date, _status text DEFAULT NULL::text, _module text DEFAULT NULL::text, _limit integer DEFAULT 500)
 RETURNS TABLE(id uuid, journal_number text, accounting_date date, period_name text, period_status text, journal_type text, source_module text, source_document_type text, source_document_id uuid, document_number text, description text, currency text, total_debit numeric, total_credit numeric, balanced boolean, line_count integer, status text, branch_id uuid, property text, created_by_name text, created_at timestamp with time zone, posted_by_name text, posted_at timestamp with time zone, reverses_journal_id uuid, reverses_journal_number text, reversed_by_journal_id uuid, reversed_by_journal_number text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE org uuid := public.current_org_id();
BEGIN
  IF org IS NULL OR NOT (public.is_org_admin() OR public.can_read_general_ledger()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT j.id, j.journal_number, j.accounting_date, p.name, p.status,
         j.journal_type, j.source_module, j.source_document_type, j.source_document_id,
         j.document_number, j.description, j.currency,
         coalesce(j.total_debit,0), coalesce(j.total_credit,0),
         abs(coalesce(j.total_debit,0) - coalesce(j.total_credit,0)) < 0.01,
         (SELECT count(*)::int FROM public.journal_entry_lines l WHERE l.journal_id = j.id),
         j.status, j.branch_id, b.name,
         cs.full_name, j.created_at, ps.full_name, j.posted_at,
         j.reverses_journal_id, rj.journal_number,
         j.reversed_by_journal_id, bj.journal_number
    FROM public.journal_entries j
    LEFT JOIN public.accounting_periods p ON p.id = j.period_id
    LEFT JOIN public.branches b ON b.id = j.branch_id
    LEFT JOIN public.profiles cs ON cs.id = j.created_by
    LEFT JOIN public.profiles ps ON ps.id = j.posted_by
    LEFT JOIN public.journal_entries rj ON rj.id = j.reverses_journal_id
    LEFT JOIN public.journal_entries bj ON bj.id = j.reversed_by_journal_id
   WHERE j.organization_id = org
     AND (_branch IS NULL OR j.branch_id = _branch)
     AND (_from IS NULL OR j.accounting_date >= _from)
     AND (_to IS NULL OR j.accounting_date <= _to)
     AND (_status IS NULL OR j.status = _status)
     AND (_module IS NULL OR j.source_module = _module)
   ORDER BY j.accounting_date DESC, j.created_at DESC
   LIMIT greatest(1, least(coalesce(_limit,500), 2000));
END $function$;