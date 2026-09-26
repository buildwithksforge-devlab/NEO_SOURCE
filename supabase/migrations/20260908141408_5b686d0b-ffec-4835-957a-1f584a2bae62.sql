
-- Family key: the different module spellings used by each register
-- ("pos" vs "pos_order", "supplier-invoice" vs "supplier_invoice") describe the
-- same transaction family. One key lets the two registers be matched.
CREATE OR REPLACE FUNCTION public.neo_financial_family(_module text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE lower(coalesce(replace(_module, '-', '_'), ''))
    WHEN 'pos_order' THEN 'pos'
    WHEN 'laundry_order' THEN 'laundry'
    WHEN 'delivery_order' THEN 'delivery'
    WHEN 'inventory_receipt' THEN 'inventory'
    WHEN 'goods_receipt' THEN 'inventory'
    WHEN 'event_deposit' THEN 'event'
    WHEN 'event_invoice' THEN 'event'
    WHEN 'event_earned' THEN 'event'
    WHEN 'event_payment' THEN 'event'
    WHEN 'event_cancellation' THEN 'event'
    ELSE lower(coalesce(replace(_module, '-', '_'), ''))
  END
$$;

-- The one register every Finance surface reads.
CREATE OR REPLACE FUNCTION public.neo_financial_lifecycle_register(
  _branch uuid DEFAULT NULL,
  _from date DEFAULT NULL,
  _to date DEFAULT NULL,
  _family text DEFAULT NULL,
  _status text DEFAULT NULL)
RETURNS TABLE (
  family text,
  source_id uuid,
  branch_id uuid,
  source_reference text,
  operational_state text,
  financial_status text,
  status_origin text,
  disagreement boolean,
  canonical_financial_state text,
  amount numeric,
  currency text,
  accounting_date date,
  journal_id uuid,
  journal_number text,
  receipt_id uuid,
  attempts integer,
  last_error text,
  blocking_reason text,
  next_action text,
  current_owner text,
  posted_at timestamptz,
  reversed_at timestamptz,
  occurred_at timestamptz,
  updated_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH scope AS (
    SELECT public.current_org_id() AS org, public.current_access_scope() AS acc
  ),
  fin AS (
    SELECT public.neo_financial_family(fs.source_module) AS family, fs.*
      FROM public.financial_states fs, scope s
     WHERE fs.organization_id = s.org
       AND (s.acc = 'all' OR fs.branch_id IS NULL OR fs.branch_id = ANY (public.current_branch_ids()))
  ),
  canon AS (
    SELECT public.neo_financial_family(cs.source_module) AS family, cs.*
      FROM public.canonical_transaction_states cs, scope s
     WHERE cs.organization_id = s.org
       AND (s.acc = 'all' OR cs.branch_id IS NULL OR cs.branch_id = ANY (public.current_branch_ids()))
  ),
  joined AS (
    SELECT
      coalesce(f.family, c.family) AS family,
      coalesce(f.source_id, c.source_id) AS source_id,
      coalesce(f.branch_id, c.branch_id) AS branch_id,
      coalesce(f.source_reference, c.source_reference) AS source_reference,
      coalesce(c.operational_state, f.operational_status) AS operational_state,
      coalesce(f.financial_status, c.financial_state, 'pending') AS financial_status,
      CASE WHEN f.id IS NOT NULL THEN 'accounting' ELSE 'canonical' END AS status_origin,
      (f.id IS NOT NULL AND c.id IS NOT NULL
        AND coalesce(f.financial_status,'') IS DISTINCT FROM coalesce(c.financial_state,'')) AS disagreement,
      c.financial_state AS canonical_financial_state,
      coalesce(f.amount, c.amount, 0) AS amount,
      coalesce(f.currency, c.currency, 'KES') AS currency,
      coalesce(f.accounting_date, (c.occurred_at AT TIME ZONE 'UTC')::date) AS accounting_date,
      coalesce(f.journal_id, c.journal_id) AS journal_id,
      coalesce(f.receipt_id, c.receipt_id) AS receipt_id,
      coalesce(f.attempts, 0) AS attempts,
      f.last_error,
      coalesce(c.blocking_reason, f.reason) AS blocking_reason,
      c.next_action,
      c.current_owner,
      f.posted_at,
      f.reversed_at,
      coalesce(c.occurred_at, f.updated_at) AS occurred_at,
      greatest(coalesce(f.updated_at, c.updated_at), coalesce(c.updated_at, f.updated_at)) AS updated_at
    FROM fin f
    FULL OUTER JOIN canon c
      ON c.source_id = f.source_id AND c.family = f.family
  )
  SELECT j.family, j.source_id, j.branch_id, j.source_reference, j.operational_state,
         j.financial_status, j.status_origin, j.disagreement, j.canonical_financial_state,
         j.amount, j.currency, j.accounting_date, j.journal_id, je.journal_number, j.receipt_id,
         j.attempts, j.last_error, j.blocking_reason, j.next_action, j.current_owner,
         j.posted_at, j.reversed_at, j.occurred_at, j.updated_at
    FROM joined j
    LEFT JOIN public.journal_entries je ON je.id = j.journal_id
   WHERE (_branch IS NULL OR j.branch_id = _branch)
     AND (_from IS NULL OR coalesce(j.accounting_date, (j.occurred_at AT TIME ZONE 'UTC')::date) >= _from)
     AND (_to IS NULL OR coalesce(j.accounting_date, (j.occurred_at AT TIME ZONE 'UTC')::date) <= _to)
     AND (_family IS NULL OR j.family = _family)
     AND (_status IS NULL OR j.financial_status = _status)
   ORDER BY j.updated_at DESC NULLS LAST
   LIMIT 2000;
$$;

REVOKE ALL ON FUNCTION public.neo_financial_lifecycle_register(uuid, date, date, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_financial_lifecycle_register(uuid, date, date, text, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.neo_financial_family(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_financial_family(text) TO authenticated, service_role;
