BEGIN;

DO $migration$
DECLARE
    v_constraint text;
    v_count integer;
BEGIN

    SELECT count(*), min(c.conname)
      INTO v_count,v_constraint
    FROM pg_constraint c
    WHERE c.conrelid =
        'public.chart_of_accounts'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid)
          LIKE '%operating_expense%'
      AND pg_get_constraintdef(c.oid)
          LIKE '%other_expense%'
      AND pg_get_constraintdef(c.oid)
          LIKE '%cost_of_sales%';

    IF v_count <> 1 THEN
        RAISE EXCEPTION
            'Chart of accounts category constraint requires review';
    END IF;

    EXECUTE format(
        'ALTER TABLE public.chart_of_accounts DROP CONSTRAINT %I',
        v_constraint
    );

    EXECUTE format(
        'ALTER TABLE public.chart_of_accounts ADD CONSTRAINT %I CHECK (
            category IN (
                ''asset'',
                ''liability'',
                ''equity'',
                ''revenue'',
                ''cost_of_sales'',
                ''operating_expense'',
                ''other_income'',
                ''other_expense'',
                ''income_tax_expense''
            )
        )',
        v_constraint
    );

END;
$migration$;

COMMIT;