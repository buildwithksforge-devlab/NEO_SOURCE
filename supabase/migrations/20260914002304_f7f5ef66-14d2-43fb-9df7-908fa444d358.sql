-- 1. Sale consumption referenced a non-existent table name for stations.
DO $do$
DECLARE src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'inventory_consume_order_item_core';
  IF src IS NULL THEN RAISE EXCEPTION 'inventory_consume_order_item_core missing'; END IF;
  src := replace(src,
    'FROM stations s WHERE s.id = v_station',
    'FROM operational_stations s WHERE s.id = v_station');
  EXECUTE src;
END $do$;

-- 2. Settlement account resolution must respect the property's real chart of
--    accounts instead of assuming a fixed code carries the expected meaning.
CREATE OR REPLACE FUNCTION public.neo_gl_settlement_code_base(_method text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT CASE lower(coalesce(replace(_method,'-','_'),'cash'))
    WHEN 'cash' THEN '1010'
    WHEN 'bank' THEN '1020'
    WHEN 'bank_transfer' THEN '1020'
    WHEN 'cheque' THEN '1020'
    WHEN 'eft' THEN '1020'
    WHEN 'mpesa' THEN '1030'
    WHEN 'm_pesa' THEN '1030'
    WHEN 'mobile_money' THEN '1030'
    WHEN 'card' THEN '1040'
    WHEN 'credit_card' THEN '1040'
    WHEN 'debit_card' THEN '1040'
    WHEN 'card_terminal' THEN '1040'
    WHEN 'qr' THEN '1040'
    WHEN 'credit' THEN '1060'
    WHEN 'city_ledger' THEN '1060'
    WHEN 'corporate_credit' THEN '1060'
    WHEN 'room_charge' THEN '1060'
    ELSE '1010'
  END
$$;

CREATE OR REPLACE FUNCTION public.neo_gl_settlement_code_for(_org uuid, _method text)
RETURNS text
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  WITH role AS (
    SELECT public.neo_gl_settlement_code_base(_method) AS code
  ), pat AS (
    SELECT r.code,
           CASE r.code
             WHEN '1010' THEN '%cash%'
             WHEN '1020' THEN '%bank%'
             WHEN '1030' THEN '%pesa%'
             WHEN '1040' THEN '%card%'
             WHEN '1060' THEN '%receivable%'
             ELSE NULL
           END AS name_pattern
      FROM role r
  )
  SELECT COALESCE(
    -- the standard code, when its name still carries the expected meaning
    (SELECT c.code FROM public.chart_of_accounts c, pat p
      WHERE c.organization_id = _org AND c.active AND coalesce(c.postable, true)
        AND c.code = p.code
        AND (p.name_pattern IS NULL OR c.name ILIKE p.name_pattern)
      LIMIT 1),
    -- otherwise the property's actual account for that role
    (SELECT c.code FROM public.chart_of_accounts c, pat p
      WHERE c.organization_id = _org AND c.active AND coalesce(c.postable, true)
        AND p.name_pattern IS NOT NULL AND c.name ILIKE p.name_pattern
      ORDER BY c.code
      LIMIT 1),
    (SELECT p.code FROM pat p))
$$;

CREATE OR REPLACE FUNCTION public.neo_gl_settlement_code(_method text)
RETURNS text
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT COALESCE(
    public.neo_gl_settlement_code_for(public.current_org_id(), _method),
    public.neo_gl_settlement_code_base(_method))
$$;

-- 3. A folio payment and a payment are one transaction, not two register rows.
CREATE OR REPLACE FUNCTION public.neo_financial_family(_module text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
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
    WHEN 'folio_payment' THEN 'payment'
    ELSE lower(coalesce(replace(_module, '-', '_'), ''))
  END
$$;

CREATE OR REPLACE FUNCTION public.neo_financial_lifecycle_register(
  _branch uuid DEFAULT NULL::uuid, _from date DEFAULT NULL::date, _to date DEFAULT NULL::date,
  _family text DEFAULT NULL::text, _status text DEFAULT NULL::text)
RETURNS TABLE(family text, source_id uuid, branch_id uuid, source_reference text, operational_state text, financial_status text, status_origin text, disagreement boolean, canonical_financial_state text, amount numeric, currency text, accounting_date date, journal_id uuid, journal_number text, receipt_id uuid, attempts integer, last_error text, blocking_reason text, next_action text, current_owner text, posted_at timestamp with time zone, reversed_at timestamp with time zone, occurred_at timestamp with time zone, updated_at timestamp with time zone)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH scope AS (
    SELECT public.current_org_id() AS org, public.current_access_scope() AS acc
  ),
  fin AS (
    SELECT DISTINCT ON (public.neo_financial_family(fs.source_module), fs.source_id)
           public.neo_financial_family(fs.source_module) AS family, fs.*
      FROM public.financial_states fs, scope s
     WHERE fs.organization_id = s.org
       AND (s.acc = 'all' OR fs.branch_id IS NULL OR fs.branch_id = ANY (public.current_branch_ids()))
     ORDER BY public.neo_financial_family(fs.source_module), fs.source_id, fs.updated_at DESC NULLS LAST
  ),
  canon AS (
    SELECT DISTINCT ON (public.neo_financial_family(cs.source_module), cs.source_id)
           public.neo_financial_family(cs.source_module) AS family, cs.*
      FROM public.canonical_transaction_states cs, scope s
     WHERE cs.organization_id = s.org
       AND (s.acc = 'all' OR cs.branch_id IS NULL OR cs.branch_id = ANY (public.current_branch_ids()))
     ORDER BY public.neo_financial_family(cs.source_module), cs.source_id, cs.updated_at DESC NULLS LAST
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
$function$;