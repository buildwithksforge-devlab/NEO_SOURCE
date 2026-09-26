CREATE OR REPLACE FUNCTION public.neo_general_ledger(
  _from date,
  _to date,
  _branch uuid DEFAULT NULL,
  _account uuid DEFAULT NULL
)
RETURNS TABLE(
  account_id uuid,
  account_code text,
  account_name text,
  account_category text,
  opening_balance numeric,
  line_id uuid,
  journal_id uuid,
  journal_number text,
  accounting_date date,
  period_name text,
  period_status text,
  source_module text,
  source_document_type text,
  source_document_id uuid,
  document_number text,
  description text,
  branch_id uuid,
  property text,
  debit numeric,
  credit numeric,
  running_balance numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH org AS (SELECT public.current_org_id() AS id),
  scope AS (
    SELECT l.id AS line_id, l.journal_id, l.account_id, l.description, l.debit, l.credit,
           COALESCE(l.branch_id, j.branch_id) AS branch_id,
           j.journal_number, j.accounting_date, j.period_id,
           j.source_module, j.source_document_type, j.source_document_id, j.document_number
    FROM public.journal_entry_lines l
    JOIN public.journal_entries j ON j.id = l.journal_id
    WHERE l.organization_id = (SELECT id FROM org)
      AND j.status = 'posted'
      AND (_branch IS NULL OR COALESCE(l.branch_id, j.branch_id) = _branch)
      AND (_account IS NULL OR l.account_id = _account)
      AND public.can_read_general_ledger()
  ),
  opening AS (
    SELECT s.account_id, SUM(s.debit - s.credit) AS bal
    FROM scope s
    WHERE s.accounting_date < _from
    GROUP BY s.account_id
  ),
  period AS (
    SELECT s.*, COALESCE(o.bal, 0) AS opening_balance
    FROM scope s
    LEFT JOIN opening o ON o.account_id = s.account_id
    WHERE s.accounting_date >= _from AND s.accounting_date <= _to
  )
  SELECT a.id, a.code, a.name, a.category,
         p.opening_balance,
         p.line_id, p.journal_id, p.journal_number, p.accounting_date,
         ap.name, ap.status,
         p.source_module, p.source_document_type, p.source_document_id, p.document_number,
         p.description, p.branch_id, b.name,
         p.debit, p.credit,
         p.opening_balance + SUM(p.debit - p.credit) OVER (
           PARTITION BY p.account_id
           ORDER BY p.accounting_date, p.journal_number, p.line_id
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
         )
  FROM period p
  JOIN public.chart_of_accounts a ON a.id = p.account_id
  LEFT JOIN public.accounting_periods ap ON ap.id = p.period_id
  LEFT JOIN public.branches b ON b.id = p.branch_id
  ORDER BY a.code, p.accounting_date, p.journal_number, p.line_id;
$$;

REVOKE ALL ON FUNCTION public.neo_general_ledger(date, date, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_general_ledger(date, date, uuid, uuid) TO authenticated;