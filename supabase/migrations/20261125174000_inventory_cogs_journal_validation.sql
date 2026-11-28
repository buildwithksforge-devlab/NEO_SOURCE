-- NEØ inventory COGS journal integrity validation.
-- Validate actual posted journal lines and original account identity.
-- No historical financial records modified.

BEGIN;

CREATE OR REPLACE FUNCTION public.neo_inventory_validate_cogs_journal(
    _event_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE

    e public.inventory_posting_events;
    j public.journal_entries;

    v_cogs_account uuid;
    v_inventory_account uuid;

    v_cogs_code text;
    v_inventory_code text;

    v_line_count integer;
    v_debit_count integer;
    v_credit_count integer;

    v_debit numeric;
    v_credit numeric;

BEGIN

    SELECT *
      INTO e
      FROM public.inventory_posting_events
     WHERE id = _event_id
       AND organization_id = public.current_org_id()
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Consumption event unavailable'
            USING ERRCODE = '42501';
    END IF;

    IF public.neo_branch_in_scope(e.branch_id) IS NOT TRUE THEN
        RAISE EXCEPTION 'Journal outside authorised property'
            USING ERRCODE = '42501';
    END IF;

    IF e.posting_type IS DISTINCT FROM 'consumption'
       OR e.finance_posting_status IS DISTINCT FROM 'posted'
       OR e.finance_journal_id IS NULL
       OR (e.payload->>'valuation_status')
           IS DISTINCT FROM 'verified'
    THEN
        RAISE EXCEPTION 'Verified consumption journal required'
            USING ERRCODE = '23514';
    END IF;

    IF e.cost_snapshot IS NULL
       OR e.cost_snapshot <= 0
       OR e.cost_snapshot::text IN (
           'NaN','Infinity','-Infinity'
       )
    THEN
        RAISE EXCEPTION 'Invalid original consumption cost'
            USING ERRCODE = '23514';
    END IF;

    SELECT *
      INTO j
      FROM public.journal_entries
     WHERE id = e.finance_journal_id
       AND organization_id = e.organization_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Original consumption journal unavailable'
            USING ERRCODE = '23514';
    END IF;

    IF j.status IS DISTINCT FROM 'posted'
       OR j.branch_id IS DISTINCT FROM e.branch_id
       OR j.source_document_id IS DISTINCT FROM e.id
       OR j.source_document_type IS DISTINCT FROM
           'inventory_posting_event:consumption_cogs'
       OR j.source_module IS DISTINCT FROM 'inventory'
       OR j.reversed_by_journal_id IS NOT NULL
       OR j.reverses_journal_id IS NOT NULL
       OR j.total_debit IS DISTINCT FROM
           round(e.cost_snapshot,2)
       OR j.total_credit IS DISTINCT FROM
           round(e.cost_snapshot,2)
    THEN
        RAISE EXCEPTION 'Original consumption journal identity mismatch'
            USING ERRCODE = '23514';
    END IF;

    -- Reject invalid accounts, tenant mismatches and malformed lines.

    IF EXISTS (
        SELECT 1
        FROM public.journal_entry_lines l
        LEFT JOIN public.chart_of_accounts a
          ON a.id = l.account_id
        WHERE l.journal_id = j.id
          AND (
              l.organization_id
                  IS DISTINCT FROM e.organization_id
              OR l.branch_id
                  IS DISTINCT FROM e.branch_id
              OR a.organization_id
                  IS DISTINCT FROM e.organization_id
              OR l.debit IS NULL
              OR l.credit IS NULL
              OR l.debit < 0
              OR l.credit < 0
              OR l.debit::text IN (
                  'NaN','Infinity','-Infinity'
              )
              OR l.credit::text IN (
                  'NaN','Infinity','-Infinity'
              )
              OR (l.debit > 0 AND l.credit > 0)
              OR (l.debit = 0 AND l.credit = 0)
          )
    ) THEN
        RAISE EXCEPTION 'Original journal contains invalid lines'
            USING ERRCODE = '23514';
    END IF;

    SELECT
        count(*),
        count(*) FILTER (WHERE debit > 0),
        count(*) FILTER (WHERE credit > 0),
        COALESCE(sum(debit),0),
        COALESCE(sum(credit),0)
      INTO
        v_line_count,
        v_debit_count,
        v_credit_count,
        v_debit,
        v_credit
      FROM public.journal_entry_lines
     WHERE journal_id = j.id;

    -- The inventory consumption engine creates exactly two lines.

    IF v_line_count <> 2
       OR v_debit_count <> 1
       OR v_credit_count <> 1
       OR v_debit IS DISTINCT FROM j.total_debit
       OR v_credit IS DISTINCT FROM j.total_credit
       OR v_debit <= 0
       OR v_debit <> v_credit
    THEN
        RAISE EXCEPTION 'Original journal lines do not reconcile'
            USING ERRCODE = '23514';
    END IF;

    SELECT l.account_id, a.code
      INTO v_cogs_account, v_cogs_code
      FROM public.journal_entry_lines l
      JOIN public.chart_of_accounts a
        ON a.id = l.account_id
     WHERE l.journal_id = j.id
       AND l.debit > 0;

    SELECT l.account_id, a.code
      INTO v_inventory_account, v_inventory_code
      FROM public.journal_entry_lines l
      JOIN public.chart_of_accounts a
        ON a.id = l.account_id
     WHERE l.journal_id = j.id
       AND l.credit > 0;

    IF v_cogs_account IS NULL
       OR v_inventory_account IS NULL
       OR v_cogs_account = v_inventory_account
       OR nullif(btrim(v_cogs_code),'') IS NULL
       OR nullif(btrim(v_inventory_code),'') IS NULL
    THEN
        RAISE EXCEPTION 'Original journal account identity invalid'
            USING ERRCODE = '23514';
    END IF;

    -- Existing journal engine resolves accounts by code.
    -- Ensure those codes still resolve to the original account IDs.

    IF public.neo_gl_acct(
        e.organization_id,v_cogs_code
    ) IS DISTINCT FROM v_cogs_account

       OR public.neo_gl_acct(
           e.organization_id,v_inventory_code
       ) IS DISTINCT FROM v_inventory_account
    THEN
        RAISE EXCEPTION 'Original journal account mapping changed'
            USING ERRCODE = '23514';
    END IF;

    RETURN jsonb_build_object(
        'status','validated',
        'organization_id',e.organization_id,
        'branch_id',e.branch_id,
        'consumption_event_id',e.id,
        'original_journal_id',j.id,
        'original_cost',e.cost_snapshot,
        'posted_amount',j.total_debit,
        'currency',j.currency,
        'accounting_date',j.accounting_date,
        'cogs_account_id',v_cogs_account,
        'cogs_account_code',v_cogs_code,
        'inventory_account_id',v_inventory_account,
        'inventory_account_code',v_inventory_code
    );

END;
$function$;

REVOKE ALL ON FUNCTION
    public.neo_inventory_validate_cogs_journal(uuid)
FROM PUBLIC, anon, authenticated;

COMMIT;