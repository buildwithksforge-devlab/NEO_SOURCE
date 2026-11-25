-- NEØ Finance property isolation and journal concurrency.
-- Definition-only migration. No historical business rows changed.

BEGIN;

CREATE FUNCTION pg_temp.neo_finance_scope_patch(
    _source text,
    _old text,
    _new text
)
RETURNS text
LANGUAGE plpgsql
AS $$
BEGIN
    IF _source IS NULL
       OR length(_old) = 0
       OR (
           length(_source)
           - length(replace(_source, _old, ''))
       ) <> length(_old)
    THEN
        RAISE EXCEPTION
            'Finance source anchor changed: %',
            left(_old, 100);
    END IF;

    RETURN replace(_source, _old, _new);
END;
$$;

CREATE TEMP TABLE neo_finance_scope_metadata
ON COMMIT DROP AS
SELECT
    oid,
    proowner,
    proacl::text AS acl,
    prosecdef,
    provolatile,
    proconfig
FROM pg_proc
WHERE oid IN (
    'public.fin_trial_balance(date,date,uuid)'::regprocedure,
    'public.neo_general_ledger(date,date,uuid,uuid)'::regprocedure,
    'public.fin_post_journal(uuid)'::regprocedure,
    'public.fin_reverse_journal(uuid,text)'::regprocedure
);

DO $patch$
DECLARE
    d text;
BEGIN

    -- GENERAL LEDGER PROPERTY ISOLATION

    d := pg_get_functiondef(
        'public.neo_general_ledger(date,date,uuid,uuid)'::regprocedure
    );

    IF md5(d) <> 'bc97178174fb4daaa4f86b54add1e520' THEN
        RAISE EXCEPTION 'General Ledger source drift';
    END IF;

    d := pg_temp.neo_finance_scope_patch(
        d,
        $old$AND j.status = 'posted'$old$,
        $new$AND j.status = 'posted'
      AND j.organization_id = (SELECT id FROM org)
      AND (
        COALESCE(l.branch_id, j.branch_id) IS NOT NULL
        OR public.current_access_scope() IN ('organisation','technical')
      )
      AND (
        public.neo_branch_in_scope(j.branch_id) IS TRUE
        AND public.neo_branch_in_scope(
            COALESCE(l.branch_id, j.branch_id)
        ) IS TRUE
      )
      AND (
        _branch IS NULL
        OR public.neo_branch_in_scope(_branch) IS TRUE
      )$new$
    );

    d := pg_temp.neo_finance_scope_patch(
        d,
        $old$JOIN public.chart_of_accounts a ON a.id = p.account_id$old$,
        $new$JOIN public.chart_of_accounts a ON a.id = p.account_id
          AND a.organization_id = public.current_org_id()$new$
    );

    EXECUTE d;

    -- TRIAL BALANCE PROPERTY ISOLATION

    d := pg_get_functiondef(
        'public.fin_trial_balance(date,date,uuid)'::regprocedure
    );

    IF md5(d) <> '6f951417c4cbaf4e3124e19e5c7620b7' THEN
        RAISE EXCEPTION 'Trial Balance source drift';
    END IF;

    d := pg_temp.neo_finance_scope_patch(
        d,
        $old$AND j.id IS NOT NULL$old$,
        $new$AND j.id IS NOT NULL
    AND j.organization_id = public.current_org_id()
    AND l.organization_id = public.current_org_id()
    AND (
      COALESCE(l.branch_id, j.branch_id) IS NOT NULL
      OR public.current_access_scope() IN ('organisation','technical')
    )
    AND public.neo_branch_in_scope(j.branch_id) IS TRUE
    AND public.neo_branch_in_scope(
        COALESCE(l.branch_id, j.branch_id)
    ) IS TRUE
    AND (
        _branch IS NULL
        OR public.neo_branch_in_scope(_branch) IS TRUE
    )$new$
    );

    d := pg_temp.neo_finance_scope_patch(
        d,
        $old$AND (_branch IS NULL OR j.branch_id = _branch)$old$,
        $new$AND (
          _branch IS NULL
          OR COALESCE(l.branch_id, j.branch_id) = _branch
       )$new$
    );

    EXECUTE d;

    -- MANUAL JOURNAL POSTING

    d := pg_get_functiondef(
        'public.fin_post_journal(uuid)'::regprocedure
    );

    IF md5(d) <> '4162e3e7a44d05a75389087945abe2b2' THEN
        RAISE EXCEPTION 'Journal posting source drift';
    END IF;

    d := pg_temp.neo_finance_scope_patch(
        d,
        $old$WHERE id = _journal;$old$,
        $new$WHERE id = _journal
      AND organization_id = public.current_org_id()
      FOR UPDATE;$new$
    );

    d := pg_temp.neo_finance_scope_patch(
        d,
        $old$IF j.status = 'posted' THEN$old$,
        $new$IF public.neo_branch_in_scope(j.branch_id)
       IS NOT TRUE THEN
        RAISE EXCEPTION 'Journal outside authorised property scope'
          USING ERRCODE = '42501';
    END IF;

    IF public.neo_system_posting() IS NOT TRUE
       AND j.branch_id IS NULL
       AND (public.current_access_scope() IN ('organisation','technical')) IS NOT TRUE THEN
        RAISE EXCEPTION 'Organisation-wide journal requires organisation scope'
          USING ERRCODE = '42501';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.journal_entry_lines l
        LEFT JOIN public.chart_of_accounts a
          ON a.id = l.account_id
        WHERE l.journal_id = j.id
          AND a.organization_id IS DISTINCT FROM j.organization_id
    ) THEN
        RAISE EXCEPTION 'Journal account belongs to another organisation'
          USING ERRCODE = '42501';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.journal_entry_lines l
        WHERE l.journal_id = j.id
          AND (
            l.organization_id IS DISTINCT FROM j.organization_id
            OR public.neo_branch_in_scope(
                COALESCE(l.branch_id, j.branch_id)
            ) IS NOT TRUE
          )
    ) THEN
        RAISE EXCEPTION 'Journal lines outside authorised scope'
          USING ERRCODE = '42501';
    END IF;

    IF j.status = 'posted' THEN$new$
    );

    EXECUTE d;

    -- MANUAL JOURNAL REVERSAL

    d := pg_get_functiondef(
        'public.fin_reverse_journal(uuid,text)'::regprocedure
    );

    IF md5(d) <> '8cdf6e4935e32c85ac2f064bc0e039ee' THEN
        RAISE EXCEPTION 'Journal reversal source drift';
    END IF;

    d := pg_temp.neo_finance_scope_patch(
        d,
        $old$WHERE id = _journal;$old$,
        $new$WHERE id = _journal
      AND organization_id = public.current_org_id()
      FOR UPDATE;$new$
    );

    d := pg_temp.neo_finance_scope_patch(
        d,
        $old$IF j.status <> 'posted' THEN$old$,
        $new$IF public.neo_branch_in_scope(j.branch_id)
       IS NOT TRUE THEN
        RAISE EXCEPTION 'Journal outside authorised property scope'
          USING ERRCODE = '42501';
    END IF;

    IF j.branch_id IS NULL
       AND (public.current_access_scope() IN ('organisation','technical')) IS NOT TRUE THEN
        RAISE EXCEPTION 'Organisation-wide journal requires organisation scope'
          USING ERRCODE = '42501';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.journal_entry_lines l
        LEFT JOIN public.chart_of_accounts a
          ON a.id = l.account_id
        WHERE l.journal_id = j.id
          AND (
            l.organization_id IS DISTINCT FROM j.organization_id
            OR a.organization_id IS DISTINCT FROM j.organization_id
            OR public.neo_branch_in_scope(
                COALESCE(l.branch_id, j.branch_id)
            ) IS NOT TRUE
          )
    ) THEN
        RAISE EXCEPTION 'Journal reversal contains out-of-scope lines or accounts'
          USING ERRCODE = '42501';
    END IF;

    IF j.status <> 'posted' THEN$new$
    );

    EXECUTE d;

END;
$patch$;

DO $verify$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM neo_finance_scope_metadata m
        LEFT JOIN pg_proc p ON p.oid = m.oid
        WHERE p.oid IS NULL
           OR p.proowner IS DISTINCT FROM m.proowner
           OR p.proacl::text IS DISTINCT FROM m.acl
           OR p.prosecdef IS DISTINCT FROM m.prosecdef
           OR p.provolatile IS DISTINCT FROM m.provolatile
           OR p.proconfig IS DISTINCT FROM m.proconfig
    ) THEN
        RAISE EXCEPTION
            'Finance function permissions or security metadata changed';
    END IF;
END;
$verify$;

COMMIT;