-- NEØ Cell 01-D3: Original deposit journal integrity
-- LOCAL CANDIDATE ONLY. Not approved for deployment.
-- No historic mutation or new cash posting.
BEGIN;

DO $guard$
DECLARE
    fn regprocedure :=
      to_regprocedure('public.neo_guest_deposit_application_post()');
    matcher regprocedure :=
      to_regprocedure(
        'public.neo_connection_journal_matches(uuid,uuid,uuid,text,numeric,text,uuid)'
      );
    definition text;
    predicate text :=
      'r.status = ''posted''';
    additional text := $conditions$
r.status = 'posted'
            AND r.journal_id IS NOT NULL
            AND public.neo_connection_journal_matches(
                r.journal_id,
                NEW.organization_id,
                NEW.branch_id,
                coalesce(
                    nullif(NEW.currency,''),
                    public.neo_fact_currency(
                        NEW.organization_id,NEW.branch_id
                    )
                ),
                v_amount,
                'reservation_deposit:deposit',
                NEW.id
            )
            AND EXISTS (
                SELECT 1
                FROM public.journal_entry_lines original_line
                JOIN public.chart_of_accounts original_account
                  ON original_account.id = original_line.account_id
                 AND original_account.organization_id =
                     NEW.organization_id
                WHERE original_line.journal_id = r.journal_id
                  AND original_line.organization_id =
                      NEW.organization_id
                  AND original_line.branch_id IS NOT DISTINCT
                      FROM NEW.branch_id
                  AND original_account.code = '2020'
                  AND original_line.credit = v_amount
                  AND coalesce(original_line.debit,0) = 0
            )
$conditions$;
BEGIN
    IF fn IS NULL OR matcher IS NULL THEN
        RAISE EXCEPTION
          'Deposit trigger or journal verifier is missing';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'finance_posting_receipts'
          AND column_name = 'journal_id'
    ) THEN
        RAISE EXCEPTION 'Receipt journal linkage is missing';
    END IF;

    SELECT pg_get_functiondef(fn) INTO definition;

    IF position(
        'Cannot apply deposit' IN definition
    ) = 0 OR position(
        'reservation_deposit_application' IN definition
    ) = 0 OR position(
        'deposit:' IN definition
    ) = 0 THEN
        RAISE EXCEPTION
          'Installed deposit trigger differs from reviewed source';
    END IF;

    IF (
        length(definition) -
        length(replace(definition,predicate,''))
    ) <> length(predicate) THEN
        RAISE EXCEPTION
          'Original receipt predicate is not uniquely recognised';
    END IF;

    definition := replace(
        definition,predicate,additional
    );

    EXECUTE definition;

    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p
        WHERE p.oid = fn
          AND position(
            'neo_connection_journal_matches' IN p.prosrc
          ) > 0
          AND position(
            'original_account.code' IN p.prosrc
          ) > 0
    ) THEN
        RAISE EXCEPTION
          'Original deposit journal protection was not installed';
    END IF;
END;
$guard$;

COMMIT;